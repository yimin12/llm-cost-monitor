# Team Sync — operator guide

Cross-node sync + team rollups, opt-in. The desktop continues to be the
source of truth for local parsing; a separate Node/Postgres server
collects redacted projections so a team can see consolidated usage.

> Status: foundations + acceptance tests landed on `feat/team-sync`. Not
> merged to `main`. Sync is disabled by default; existing installs see no
> behavior change until they enable it in Settings → Team Sync.

## Architecture

```
desktop                                       server
─────────                                     ──────────
EventRepository  ───┐                         ┌── usage_events (sync_event_id PK)
                    │                         │
SyncQueue.drain() ──┼─► HTTP /v1/teams/:id/   ├── daily_aggregates
  redact (full /    │   events:batchUpsert    ├── team_members
   redacted /       │                         ├── nodes
   aggregateOnly)   │   GET /v1/teams/:id/    └── sync_conflicts
                    │   usage  (overview)
                    └────────────────────────┘
```

- Each desktop install is a **node** with a stable `nodeId`. Generated
  once on first launch; persisted in the `local_node` table.
- Each user has a **userId** (their Google `sub` once OAuth is wired
  end-to-end; for now a free-form string the user enters in Settings).
- Each team has a **teamId** the server's admin pre-creates.
- Sync is purely additive: every server row is keyed by
  `sync_event_id = sha256(teamId|userId|nodeId|localEventId)`, so retries
  are idempotent and two nodes uploading the same local event id under
  different node ids produce two distinct server rows.

## Privacy levels

| Level           | Project name | Session/message ids | Latency | Cost / tokens / model |
| --------------- | -------------- | --------------------- | --------- | ----------------------- |
| `full`          | uploaded       | uploaded              | uploaded  | uploaded                |
| `redacted` *(default)* | per-team `sha256` hash | NULL | NULL | uploaded |
| `aggregateOnly` | only as a group key inside the daily bucket | not sent | not sent | summed per day×provider×model |

The hash for redacted project names is salted with the team id, so the
same project uploaded by two nodes belonging to one user (or two users in
one team) collapses to the same hash — but it's incomparable across teams.

`aggregateOnly` uploads pre-computed `(date, provider, model)` daily
buckets into `daily_aggregates`. No event-level ids ever leave the node.

## Running the server

```sh
# 1. Make sure dev Postgres is up (the existing one — same container).
npm run db:up

# 2. Create the server database (one-time).
docker exec llm-cost-monitor-postgres psql -U lcm -d postgres -c "CREATE DATABASE lcm_team_sync;"

# 3. Apply server-side migrations.
npm run server:migrate

# 4. Run the server.
npm run server:dev   # listens on http://127.0.0.1:4017

# 5. Pre-create a team + members directly in psql for now.
docker exec -it llm-cost-monitor-postgres psql -U lcm -d lcm_team_sync
> INSERT INTO teams (id, name, created_at) VALUES ('team-A', 'Team A', extract(epoch from now())::bigint * 1000);
> INSERT INTO team_members (team_id, user_id, role, joined_at)
>   VALUES ('team-A', 'your-google-sub-or-email', 'admin', extract(epoch from now())::bigint * 1000);
```

## Enabling sync on the desktop

Open the tray dropdown → Settings tab → **Team Sync** card.

1. Set **Server URL** to `http://127.0.0.1:4017` (or wherever the server
   is reachable). Enter on focus blur.
2. Set **Team ID** (e.g. `team-A`).
3. Set **User ID** (matches the row in `team_members`).
4. Pick a **Privacy level** (`redacted` recommended).
5. Toggle **on**.

The queue drains every 5 minutes (configurable in `settings.json`'s
`teamSync.intervalMs`). The first drain runs ~10 s after app boot; you
can also press **sync now**. Status (pending count, last sync, last
error) shows live in the same card.

## Verifying

After a drain, hit the server directly:

```sh
curl -H "Authorization: Bearer your-google-sub-or-email" \
     http://127.0.0.1:4017/v1/teams/team-A/usage | jq
```

You should see the rollup payload — and the same data renders in the new
**Team** tab in the app.

## Acceptance tests

`server/__tests__/e2e-acceptance.test.ts` exercises the full client +
server stack against fresh databases:

- Two nodes for the same user upload events; team totals = union, no
  duplicates.
- Redacted mode never persists project, session id, or message id.
- aggregateOnly mode persists zero `usage_events` rows.
- Removed members are rejected.
- Re-draining the same client doesn't double-count.
- `pricing_snapshot_version` survives the round trip.

Run with `npx vitest run server`.

## Threat model + known gaps

- **JWT verification**: the server currently decodes the bearer token
  without verifying the Google JWKS signature. The token is treated as a
  trusted assertion of `sub`. A follow-up should drop in `jose.jwtVerify`
  with the `GOOGLE_JWKS_URL` config from `src/shared/auth-config.ts`.
- **Team admin UI**: there's no UI for creating teams, adding members,
  or revoking. Use psql for now.
- **Node enrollment**: every node trusts itself. A challenge-response
  enrollment (per `plan.md` §5) is the next slice.
- **Transport**: the server binds to `127.0.0.1` by default — fine for a
  single-machine demo, **not** suitable for multi-machine without HTTPS
  + an auth-verifying proxy in front.
