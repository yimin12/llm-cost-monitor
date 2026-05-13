# Team features — mock-data walkthrough

A reproducible end-to-end demo of the multi-node merge feature with a
populated team, an active member, a revoked member, and the device-limit
trigger.

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

Mock data lives only in the `lcm_team_sync` Postgres database — wipe the
relevant rows when you're done:

```sql
DELETE FROM event_daily_rollup WHERE user_id IN
  ('carol@example.com','dave@example.com','eve@example.com',
   'fred@example.com','grace@example.com','henry@example.com');
DELETE FROM usage_events WHERE user_id IN
  ('carol@example.com','dave@example.com','eve@example.com',
   'fred@example.com','grace@example.com','henry@example.com');
DELETE FROM nodes WHERE user_id IN
  ('carol@example.com','dave@example.com','eve@example.com',
   'fred@example.com','grace@example.com','henry@example.com');
DELETE FROM team_members WHERE user_id IN
  ('carol@example.com','dave@example.com','eve@example.com',
   'fred@example.com','grace@example.com','henry@example.com');
```
