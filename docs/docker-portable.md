# Portable backend (Docker)

The Electron desktop app is per-platform (macOS / Linux / Windows). The
team-sync **Core Service** in `server/` is platform-agnostic and ships
as a Docker image so any operator can stand up a private deployment
with one command. This is slice 4 + slice 7 of `design.md` at the repo
root.

```
┌──────────────┐  HTTPS  ┌──────────────────────┐
│ Desktop app  │────────▶│ Core Service (Docker) │
│ (per-OS bin) │         │   server/index.ts     │
└──────────────┘         └──────────┬───────────┘
                                    │
                                    ▼
                              ┌──────────┐
                              │ Postgres │
                              └──────────┘
```

## What ships in this image

`Dockerfile.server` builds the team-sync API only:

- `POST /v1/teams/:teamId/events:batchUpsert`
- `GET  /v1/teams/:teamId/usage`
- `GET  /healthz`

The desktop app, its SQLite store, parsers, and tray UI are **not** in
the image. They stay on the user's machine.

## Bringing up the stack

```sh
npm run server:up        # build + start postgres + server (compose profile: server)
npm run server:logs      # tail server logs
npm run server:down      # stop server, leave postgres + volume
```

`server:up` is shorthand for `docker compose --profile server up -d --build`.
The `server` service depends on postgres being healthy; it self-migrates
on boot (legacy SQL files in `server-migrations/`) so no separate migrate
step is required for a clean run.

If you want Prisma-managed migrations (the
`prisma/server/migrations/` history) to run as well, do
`npm run db:migrate:server` once before `server:up`. The in-process
runner is idempotent so order doesn't matter.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `LCM_SERVER_PORT` | `4017` | Port the HTTP listener binds to inside the container. |
| `LCM_SERVER_BIND` | `127.0.0.1` (host) / `0.0.0.0` (compose) | Bind address. The host default keeps `npm run server:dev` off the LAN; compose flips to `0.0.0.0` and uses the published port mapping (`127.0.0.1:4017:4017`) to gate external access. |
| `LCM_SERVER_DSN` | `postgres://lcm:lcm_dev@127.0.0.1:5433/lcm_team_sync` | Postgres connection string. Compose overrides to `postgres://lcm:lcm_dev@postgres:5432/...` for in-network access. |
| `LCM_SERVER_MIGRATIONS_DIR` | `<dist>/server-migrations` | Override the migrations directory if you bake your own image. |

## Pointing a desktop at it

The desktop builds the sync transport from `settings.effectiveSyncUrl()`.
It returns the persisted `teamSync.serverUrl` from `settings.json` if
set, otherwise falls back to `LCM_SYNC_URL` from the environment. So
either of these will route a desktop at a private deploy:

```sh
# (a) one-off via env when launching the dev shell
LCM_SYNC_URL=https://sync.example.com npm run dev

# (b) persisted via the Settings UI — wins over the env value
```

Sync stays opt-in: the queue only constructs when an effective URL is
present *and* the user toggles `teamSync.enabled` on.

## Production-style deploy

The image is portable — `docker build -f Dockerfile.server -t lcm-server:0.0.1 .`
gives you something you can `docker push` to your registry and run
behind whatever reverse proxy / TLS terminator you already trust. The
in-container listener is plain HTTP on `:4017`; do TLS at the edge.

For a fully self-contained one-VM deploy, `docker-compose.yml`'s
`server` profile is the canonical reference. Override the postgres
password and bind range before exposing it past loopback.

## What this image is **not**

- Not a build of the Electron app. Docker can't run macOS `.app`
  bundles, and a containerized Electron is usually the wrong primitive
  for a tray UI. See `design.md` §"结论".
- Not a single-tenant backend. The same image powers personal
  multi-device sync (one user, many `nodeId`s) and team deployments
  (many users in one `teamId`); the difference is just data, not code.
