# Team features — onboarding + mock-data walkthrough

Two scripts cover the two common needs around team sync:

| Script | Purpose |
|---|---|
| [`Scripts/team-setup.py`](../Scripts/team-setup.py) | **Friendly first-time setup** — walks a new node through reachability → identity → team join/create → settings.json write. ✓/✗ at every step. |
| [`Scripts/seed-mock-team.py`](../Scripts/seed-mock-team.py) | **Mock data + scenario probes** — populates a team with 5 mock users and exercises revoke + device-limit invariants. Has a `--cleanup` flag. |

## A. First-time setup (real users)

```bash
# Interactive — prompts for team_id (defaults to team-acme) and uses the
# Electron app's currently signed-in user when available.
Scripts/team-setup.py

# Or one-shot for a known user + team:
Scripts/team-setup.py \
  --team my-team \
  --user 105375377941393769884 \
  --display "Yimin Huang"

# CI / non-interactive (errors instead of prompting):
Scripts/team-setup.py --non-interactive --team my-team --user my-uid
```

Output looks like:

```
Team sync setup
───────────────

▸ Step 1/4 — Server reachable?
  ✓ server at http://127.0.0.1:4017 is healthy

▸ Step 2/4 — Who are you?
  ✓ detected signed-in user: yimin huang

▸ Step 3/4 — Pick (or create) a team
  ✓ team 'team-acme' is new — creating it; you become the first admin
  ✓ membership: (team-acme, 105…884, role=admin, status=active)

▸ Step 4/4 — Write local settings.json
  ✓ wrote /Users/yimin/Library/Application Support/llm-cost-monitor/settings.json
  ✓    teamSync.enabled = true
  ✓    teamSync.teamId  = team-acme
  ✓    teamSync.serverUrl = http://127.0.0.1:4017

Setup complete.
```

It's idempotent: re-running on a configured node is a no-op except for refreshing the `display_name`.

## B. Mock team for demo / manual exercise

`Scripts/seed-mock-team.py` populates `team-acme` with 5 mock users
(Carol/Dave/Eve/Fred/Grace) plus a Henry account that's used to trigger
the device-limit overflow. Idempotent — re-running won't double-count
(server's `sync_event_id` PK dedup). Produces output like:

```
[step 1/3] events uploaded=15  duplicates=0

[step 2/3] revoke-then-upload scenario
  ✓ eve's post-revoke upload rejected:
    reason: membership is revoked
  ✓ Eve re-activated for next run

[step 3/3] device-limit overflow scenario (cap = 5 per user)
  ✓ device #1 accepted
  ✓ device #2 accepted
  ✓ device #3 accepted
  ✓ device #4 accepted
  ✓ device #5 accepted
  ✗ device #6 rejected: device_limit_exceeded — max 5 devices per user
  ✗ device #7 rejected: device_limit_exceeded — max 5 devices per user
  ✓ summary: 5 accepted / 2 rejected (expected 5/2)
```

Wipe the mock data when you're done (idempotent — keeps the real users):

```bash
Scripts/seed-mock-team.py --cleanup
```

The script exercises every server-side invariant the design relies on:

## Prerequisites

- Postgres on `127.0.0.1:5433` (from the project's `docker-compose.yml`).
- Team-sync server running. Easiest:

  ```bash
  npm run server:up               # docker-compose-driven, bound 127.0.0.1
  # …or for LAN demo, the one-off `docker run` from the commit log.
  ```

## Seed the mock team

```bash
python3 Scripts/seed-mock-team.py
```

Idempotent — re-running won't double-count (server's `sync_event_id` PK
dedup). Produces output like:

```
[step 1/3] events uploaded=15  duplicates=0

[step 2/3] revoke-then-upload scenario
  ✓ eve's post-revoke upload rejected:
    reason: membership is revoked
  ✓ Eve re-activated for next run

[step 3/3] device-limit overflow scenario (cap = 5 per user)
  ✓ device #1 accepted
  ✓ device #2 accepted
  ✓ device #3 accepted
  ✓ device #4 accepted
  ✓ device #5 accepted
  ✗ device #6 rejected: device_limit_exceeded — max 5 devices per user
  ✗ device #7 rejected: device_limit_exceeded — max 5 devices per user
  ✓ summary: 5 accepted / 2 rejected (expected 5/2)
```

The script exercises every server-side invariant the design relies on:

| Invariant | How the script triggers it |
|---|---|
| Membership cache (one lookup per user per batch) | Carol's 5 events from same `user_id` |
| Per-(team,user,node,date,provider,model) rollup accumulate | Carol's `carol-mbp` claude-sonnet-3-5 lines collapse to one rollup row |
| Same-user multi-node merge | Carol on `carol-mbp` + `carol-imac` → one member row |
| `sync_event_id` PK dedup on retry | Re-run script → all 15 reported as duplicates |
| Membership status check | Eve revoked → her upload rejected with `membership is revoked` |
| Device cap (configurable, default 5) | Henry tries 7 nodes; 6th & 7th rejected with `device_limit_exceeded` |

## What the dashboard shows

After seeding, both physically separate Electron instances (signed in to
the same account) render byte-equal team-overview bodies (modulo
`generatedAt` + `currentUserRole`). Screenshots captured automatically
via `Scripts/screenshot-dashboard.mjs`:

| Viewer | Screenshot | Role-gated bits |
|---|---|---|
| Admin (local MBP) | [`team-dashboard-mbp.png`](screenshots/team-dashboard-mbp.png) | MEMBERS · **manage** + Add/Revoke controls |
| Member (remote Mac, SSH-forwarded) | [`team-dashboard-remote.png`](screenshots/team-dashboard-remote.png) | COLLABORATORS list (read-only) |

Both views show the same numbers: 9 active members, 16 active nodes,
$56.46 today, $948.7 over the 30-day window, with the same per-member /
per-project / per-(provider,model) breakdowns. The role-based UI gating
swaps the section header and the management buttons, but never the data.

## Re-generate the screenshots

```bash
# After seeding (or any state change), capture fresh visual proof:
node Scripts/screenshot-dashboard.mjs                                    # local 5174 → team-dashboard.png
node Scripts/screenshot-dashboard.mjs --url http://localhost:5173/ --out docs/screenshots/team-dashboard-remote.png
```

The script uses puppeteer-core against the system Chrome at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` and
pre-seeds `localStorage.lcm.web.tab = 'team'` so the headless render
lands on the team view.

## Cleanup

```bash
Scripts/seed-mock-team.py --cleanup
```

Removes the 6 mock users (`carol`/`dave`/`eve`/`fred`/`grace`/`henry`)
and every row keyed off them — `team_members`, `nodes`, `usage_events`,
`event_daily_rollup`. `team-acme` itself and any real members are
preserved.
