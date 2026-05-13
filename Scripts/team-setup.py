#!/usr/bin/env python3
"""Friendly team-sync setup walker.

Walks a fresh node through the four steps to get on a team:

  1. server reachable?
  2. who am I?           — read from the local Electron auth, fallback to prompt
  3. team — create new OR join existing?
  4. write settings.json + restart the dev app

Each step prints a ✓ or ✗ and the exact next thing to try if it fails.
Idempotent — re-running on an already-configured node skips the parts
that are done.

Usage:
  Scripts/team-setup.py                              # interactive
  Scripts/team-setup.py --server http://192.168.0.108:4017 --team my-team

Flags:
  --server URL    team-sync server (default: http://127.0.0.1:4017)
  --web-api URL   local Electron loopback API (default: http://127.0.0.1:4019)
  --team ID       team to create/join (skip the prompt)
  --user ID       override the detected user_id (skip the prompt)
  --display NAME  human-readable name shown on the dashboard
  --role admin|member  role on first join (default: admin if creating, member if joining)
  --non-interactive   error instead of prompting; useful for CI seeds
"""
import argparse, json, os, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path
from typing import Optional

PG_CONTAINER = "llm-cost-monitor-postgres"
PG_DB = "lcm_team_sync"
PG_USER = "lcm"


def color(s: str, code: str) -> str:
    if not sys.stdout.isatty():
        return s
    return f"\033[{code}m{s}\033[0m"


def step(msg: str) -> None:
    print(f"\n{color('▸', '36')} {msg}")


def ok(msg: str) -> None:
    print(f"  {color('✓', '32')} {msg}")


def warn(msg: str) -> None:
    print(f"  {color('⚠', '33')} {msg}")


def fail(msg: str) -> None:
    print(f"  {color('✗', '31')} {msg}", file=sys.stderr)


def psql(sql: str) -> str:
    cmd = ["docker", "exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-t", "-c", sql]
    out = subprocess.run(cmd, check=True, capture_output=True, text=True)
    return out.stdout.strip()


def http_get_json(url: str, timeout: float = 4.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError):
        return None


def prompt(question: str, default: Optional[str] = None, non_interactive: bool = False) -> str:
    if non_interactive:
        if default is None:
            fail(f"non-interactive mode and no default for: {question}")
            sys.exit(2)
        return default
    suffix = f" [{default}]" if default is not None else ""
    val = input(f"  {question}{suffix}: ").strip()
    return val if val else (default or "")


def settings_path() -> Path:
    # macOS userData. Adjust if porting to Linux/Windows.
    return Path.home() / "Library" / "Application Support" / "llm-cost-monitor" / "settings.json"


def read_settings() -> dict:
    p = settings_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        return {}


def write_settings(s: dict) -> None:
    p = settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(s, indent=2))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--server", default="http://127.0.0.1:4017")
    ap.add_argument("--web-api", default="http://127.0.0.1:4019")
    ap.add_argument("--team", default=None)
    ap.add_argument("--user", default=None)
    ap.add_argument("--display", default=None)
    ap.add_argument("--role", default=None, choices=[None, "admin", "member"])
    ap.add_argument("--non-interactive", action="store_true")
    a = ap.parse_args()

    print(color("Team sync setup", "1;36"))
    print(color("───────────────", "36"))

    # ── Step 1 ─────────────────────────────────────────────────────────
    step("Step 1/4 — Server reachable?")
    health = http_get_json(f"{a.server}/healthz")
    if health is None:
        fail(f"can't reach {a.server}/healthz")
        warn("Start it with `npm run server:up` or check your --server URL.")
        return 1
    ok(f"server at {a.server} is healthy")

    # ── Step 2 ─────────────────────────────────────────────────────────
    step("Step 2/4 — Who are you?")
    user_id = a.user
    display = a.display
    if user_id is None:
        auth = http_get_json(f"{a.web_api}/v1/auth")
        if auth and auth.get("kind") == "signed-in":
            user_id = auth["user"]["sub"]
            display = display or auth["user"].get("name") or auth["user"].get("email")
            ok(f"detected signed-in user: {display or user_id}")
        else:
            warn(f"no signed-in user on {a.web_api}.")
            warn("Sign in via the tray app first, OR pass --user <id> --display <name>.")
            user_id = prompt("user_id to use anyway", default=None,
                             non_interactive=a.non_interactive)
            if not user_id:
                fail("no user_id — aborting")
                return 1
            display = display or prompt("display name", default=user_id,
                                        non_interactive=a.non_interactive)
    else:
        ok(f"using --user {user_id}")
        display = display or user_id

    # ── Step 3 ─────────────────────────────────────────────────────────
    step("Step 3/4 — Pick (or create) a team")
    team_id = a.team or prompt("team_id", default="team-acme",
                               non_interactive=a.non_interactive)
    if not team_id:
        fail("no team_id — aborting")
        return 1

    # Detect existing team.
    exists = psql(
        f"SELECT 1 FROM teams WHERE id = '{team_id}' LIMIT 1"
    ).strip() == "1"
    now_ms = int(time.time() * 1000)
    if exists:
        ok(f"team '{team_id}' already exists — joining")
        role = a.role or "member"
    else:
        ok(f"team '{team_id}' is new — creating it; you become the first admin")
        psql(
            f"INSERT INTO teams (id, name, created_at, privacy_floor) "
            f"VALUES ('{team_id}', '{team_id}', {now_ms}, 'redacted') "
            f"ON CONFLICT (id) DO NOTHING"
        )
        role = a.role or "admin"

    # Insert/refresh membership.
    psql(
        f"INSERT INTO team_members (team_id, user_id, role, status, display_name, joined_at) "
        f"VALUES ('{team_id}', '{user_id}', '{role}', 'active', "
        f"'{display.replace(chr(39), chr(39)+chr(39))}', {now_ms}) "
        f"ON CONFLICT (team_id, user_id) DO UPDATE SET "
        f"status = 'active', role = EXCLUDED.role, "
        f"display_name = EXCLUDED.display_name"
    )
    ok(f"membership: ({team_id}, {user_id}, role={role}, status=active)")

    # ── Step 4 ─────────────────────────────────────────────────────────
    step("Step 4/4 — Write local settings.json")
    settings = read_settings()
    prev_team = settings.get("teamSync", {}).get("teamId")
    ts = settings.setdefault("teamSync", {})
    ts.update({
        "enabled": True,
        "teamId": team_id,
        "userId": user_id,
        "serverUrl": a.server,
        "privacyLevel": ts.get("privacyLevel", "redacted"),
        "intervalMs": ts.get("intervalMs", 24 * 60 * 60 * 1000),  # daily default
    })
    write_settings(settings)
    if prev_team and prev_team != team_id:
        warn(f"changed teamId: {prev_team} → {team_id}")
    ok(f"wrote {settings_path()}")
    ok(f"   teamSync.enabled = true")
    ok(f"   teamSync.teamId  = {team_id}")
    ok(f"   teamSync.serverUrl = {a.server}")

    # ── done ───────────────────────────────────────────────────────────
    print()
    print(color("Setup complete.", "1;32"))
    print()
    print("Next steps:")
    print("  1. Restart the Electron app so it picks up the new settings:")
    print("       pkill -f electron-vite ; npx electron-vite dev")
    print("  2. The first scheduled drain fires within minutes; or hit")
    print("     the 'Sync Now' button (Team tab) to force-upload immediately.")
    print("  3. Open the Team tab to see your numbers merge with other")
    print(f"     members of '{team_id}'.")
    print()
    print(f"  curl http://127.0.0.1:4017/v1/teams/{team_id}/usage \\")
    print(f"    -H 'Authorization: Bearer {user_id}' | python3 -m json.tool")
    return 0


if __name__ == "__main__":
    sys.exit(main())
