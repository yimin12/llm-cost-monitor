#!/usr/bin/env python3
"""Seed the team-sync server with a populated mock team for demos and
manual UI exercise. Idempotent — re-running won't double-count thanks to
the server's sync_event_id PK dedup.

What it does:
  1. Bootstraps team `team-acme` and 5 mock members (Carol/Dave/Eve/Fred/
     Grace) directly via psql against the lcm_team_sync database.
  2. Uploads ~15 representative events through the public POST
     /v1/teams/<team>/events:batchUpsert HTTP API — each user spans 1-2
     nodes, multiple providers/models, and several project hashes so the
     dashboard cards have real shape to render.
  3. Runs two extra scenario probes:
       - revoke-then-upload: revokes Eve via SQL, then tries to upload
         from her node — server must reject with reason 'membership is
         revoked'. Then re-activates her so subsequent demo runs work.
       - device-limit overflow: a new "henry" user is added and asked to
         register 7 nodes; the first 5 land, the 6th + 7th get rejected
         with 'device_limit_exceeded'.

Usage:
  Scripts/seed-mock-team.py                # default — server at 4017
  Scripts/seed-mock-team.py --base http://127.0.0.1:4017

The script targets the dockerized server (LCM_SERVER_DSN points to
host postgres). For a tsx-mode dev server, the same calls work.
"""
import argparse, hashlib, json, subprocess, sys, time, urllib.request, urllib.error

TEAM = "team-acme"
NOW_MS = int(time.time() * 1000)

# (user, display, role, [(node, local, provider, model, project_hash, in, out, cost_micro)])
MOCK_USERS = [
    ("carol@example.com", "Carol", "admin", [
        ("carol-mbp",  "c-1", "anthropic", "claude-3-5-sonnet", "p-website",  20000, 1500, 320000),
        ("carol-mbp",  "c-2", "anthropic", "claude-3-5-sonnet", "p-website",  18000, 1200, 290000),
        ("carol-mbp",  "c-3", "anthropic", "claude-3-5-haiku",  "p-scripts",   5000,  300,  20000),
        ("carol-imac", "c-4", "anthropic", "claude-3-5-sonnet", "p-website",  22000, 1600, 350000),
        ("carol-imac", "c-5", "openai",    "gpt-4o",            "p-website",  10000,  800, 150000),
    ]),
    ("dave@example.com", "Dave", "member", [
        ("dave-linux", "d-1", "anthropic", "claude-3-5-sonnet", "p-backend", 30000, 2200, 460000),
        ("dave-linux", "d-2", "anthropic", "claude-3-5-sonnet", "p-backend", 25000, 1800, 380000),
        ("dave-linux", "d-3", "anthropic", "claude-3-5-haiku",  "p-scripts",  3000,  200,  12000),
    ]),
    ("eve@example.com", "Eve", "member", [
        ("eve-mbp", "e-1", "openai", "gpt-4o",      "p-frontend", 8000, 500, 120000),
        ("eve-mbp", "e-2", "openai", "gpt-4o-mini", "p-frontend", 4000, 250,  20000),
    ]),
    ("fred@example.com", "Fred", "member", [
        ("fred-mbp", "f-1", "anthropic", "claude-3-5-sonnet", "p-data",    40000, 3000, 620000),
        ("fred-mbp", "f-2", "google",    "gemini-1.5-pro",    "p-data",    35000, 2500, 480000),
        ("fred-srv", "f-3", "openai",    "gpt-4o",            "p-data",    28000, 2100, 420000),
        ("fred-srv", "f-4", "anthropic", "claude-3-5-haiku",  "p-scripts",  6000,  400,  24000),
    ]),
    ("grace@example.com", "Grace", "member", [
        ("grace-mbp", "g-1", "google", "gemini-1.5-pro", "p-ml-research", 50000, 3800, 720000),
    ]),
]

# Postgres details — match docker-compose.yml. Bootstrapping members isn't
# exposed via HTTP at seed time (admin token required), so shell out to psql.
PG_CONTAINER = "llm-cost-monitor-postgres"
PG_DB = "lcm_team_sync"
PG_USER = "lcm"


def psql(sql: str) -> str:
    cmd = ["docker", "exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-t", "-c", sql]
    out = subprocess.run(cmd, check=True, capture_output=True, text=True)
    return out.stdout.strip()


def sync_event_id(team: str, user: str, node: str, local: str) -> str:
    return hashlib.sha256(f"{team}|{user}|{node}|{local}".encode()).hexdigest()


def upload(base: str, user: str, node: str, local: str, provider: str, model: str,
           project: str, in_t: int, out_t: int, cost: int) -> dict:
    payload = {
        "kind": "event", "event_version": 1,
        "sync_event_id": sync_event_id(TEAM, user, node, local),
        "team_id": TEAM, "user_id": user, "node_id": node, "local_event_id": local,
        "payload_hash": f"h-{local}", "privacy_level": "redacted",
        "captured_at": NOW_MS, "synced_at": None,
        "provider": provider, "provider_raw_tag": None, "model": model,
        "timestamp": NOW_MS, "project": None, "project_hash": project,
        "session_id": None, "message_id": None,
        "input_tokens": in_t, "output_tokens": out_t,
        "cache_read_tokens": 0, "cache_creation_5m_tokens": 0, "cache_creation_1h_tokens": 0,
        "reasoning_tokens": None, "tool_call_count": None, "latency_ms": None,
        "cost_micro_usd": str(cost), "pricing_snapshot_version": "v1",
    }
    req = urllib.request.Request(
        f"{base}/v1/teams/{TEAM}/events:batchUpsert",
        data=json.dumps({"events": [payload]}).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {user}"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default="http://127.0.0.1:4017",
                    help="team-sync server URL (default: %(default)s)")
    a = ap.parse_args()

    # 1. Make sure team-acme exists.
    psql(f"INSERT INTO teams (id, name, created_at, privacy_floor) "
         f"VALUES ('{TEAM}', 'Acme', {NOW_MS}, 'redacted') "
         f"ON CONFLICT (id) DO NOTHING")

    # 2. Add all mock members (idempotent — re-activates if already there).
    rows = ",".join(
        f"('{TEAM}', '{u}', '{role}', 'active', '{name}', {NOW_MS})"
        for (u, name, role, _) in MOCK_USERS
    )
    psql(
        f"INSERT INTO team_members (team_id, user_id, role, status, display_name, joined_at) "
        f"VALUES {rows} ON CONFLICT (team_id, user_id) DO UPDATE SET "
        f"status = 'active', display_name = EXCLUDED.display_name"
    )

    # 3. Upload events.
    accepted = duplicates = 0
    for user, _name, _role, events in MOCK_USERS:
        for ev in events:
            try:
                r = upload(a.base, user, *ev)
                if r["accepted"]:
                    accepted += 1
                elif r["duplicates"]:
                    duplicates += 1
            except urllib.error.HTTPError as e:
                print(f"  ✗ upload {user} {ev[1]}: HTTP {e.code} {e.read().decode()[:80]}", file=sys.stderr)
    print(f"[step 1/3] events uploaded={accepted}  duplicates={duplicates}")

    # 4. Scenario: revoke a member then try to upload.
    print()
    print("[step 2/3] revoke-then-upload scenario")
    psql(f"UPDATE team_members SET status = 'revoked', removed_at = {NOW_MS} "
         f"WHERE team_id = '{TEAM}' AND user_id = 'eve@example.com'")
    try:
        r = upload(a.base, "eve@example.com", "eve-mbp", "post-revoke-1",
                   "openai", "gpt-4o", "p-frontend", 100, 50, 1000)
        if r["rejected"]:
            print(f"  ✓ eve's post-revoke upload rejected:")
            print(f"    reason: {r['rejected'][0]['reason']}")
        else:
            print(f"  ✗ expected reject, got {r}")
    except urllib.error.HTTPError as e:
        print(f"  ✗ HTTP {e.code} {e.read().decode()[:120]}")
    # Re-activate Eve so the next demo run starts clean.
    psql(f"UPDATE team_members SET status = 'active', removed_at = NULL "
         f"WHERE team_id = '{TEAM}' AND user_id = 'eve@example.com'")
    print(f"  ✓ Eve re-activated for next run")

    # 5. Scenario: device-limit overflow (cap = 5 per user).
    print()
    print("[step 3/3] device-limit overflow scenario (cap = 5 per user)")
    psql(f"INSERT INTO team_members (team_id, user_id, role, status, display_name, joined_at) "
         f"VALUES ('{TEAM}', 'henry@example.com', 'member', 'active', 'Henry', {NOW_MS}) "
         f"ON CONFLICT (team_id, user_id) DO UPDATE SET status = 'active'")
    # Clean any previous henry-dev-N rows so the cap check sees a fresh state.
    psql(f"DELETE FROM usage_events WHERE user_id = 'henry@example.com'")
    psql(f"DELETE FROM event_daily_rollup WHERE user_id = 'henry@example.com'")
    psql(f"DELETE FROM nodes WHERE user_id = 'henry@example.com'")
    accepted = rejected = 0
    for i in range(1, 8):
        try:
            r = upload(a.base, "henry@example.com",
                       f"henry-dev-{i}", f"h-{i}",
                       "anthropic", "claude-3-5-haiku", "p-misc", 100, 50, 1000)
            if r["accepted"]:
                accepted += 1
                print(f"  ✓ device #{i} accepted")
            elif r["rejected"]:
                rejected += 1
                print(f"  ✗ device #{i} rejected: {r['rejected'][0]['reason']}")
        except urllib.error.HTTPError as e:
            print(f"  ✗ HTTP {e.code} {e.read().decode()[:120]}")
    expected_accepted, expected_rejected = 5, 2
    ok = accepted == expected_accepted and rejected == expected_rejected
    flag = "✓" if ok else "✗"
    print(f"  {flag} summary: {accepted} accepted / {rejected} rejected "
          f"(expected {expected_accepted}/{expected_rejected})")

    print()
    print("done — GET /v1/teams/team-acme/usage for the populated dashboard")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
