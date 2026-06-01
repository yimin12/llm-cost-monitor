# go-server

Go port of the team-sync Core Service in `server/`. Wire-compatible with
the TS implementation: same DSN env, same migrations directory, same HTTP
routes, same JSON shapes. Phased migration plan in [`TASKS.md`](./TASKS.md).

## Quickstart (M0)

```sh
cd go-server
go mod tidy
LCM_SERVER_DSN=postgres://lcm:lcm_dev@127.0.0.1:5433/lcm_team_sync \
LCM_SERVER_AUTH=insecure-noverify \
go run ./cmd/server
```

The server listens on `127.0.0.1:4017` by default. Override with
`LCM_SERVER_PORT` and `LCM_SERVER_BIND` (matches the TS env names).

## Wire compatibility

- `server-migrations/*.sql` is shared with the TS server. Either binary can
  apply the migrations; they converge to the same schema.
- `sync_event_id` is recomputed in `internal/sync.ComputeEventID` from the
  same `team|user|node|local` join and same SHA-256 as
  `src/shared/sync.ts:syncEventIdInput`.
- Authorization mirrors `server/auth.ts`: `LCM_SERVER_AUTH=jwks` (default,
  Google JWKS verified, audience-pinned) or `LCM_SERVER_AUTH=insecure-noverify`
  (dev only — the binary logs a startup warning).

## What is implemented (M0)

- POST /v1/teams/:teamId/events:batchUpsert — event-kind payloads
- POST /v1/teams/:teamId/members — admin-gated AddMember
- PATCH /v1/teams/:teamId/privacy-floor — admin-gated SetPrivacyFloor
- GET  /healthz

Reads (`GET /usage`), `revokeMember`, `setMemberRole`, and the
`event_daily_rollup` accumulation are intentionally deferred to M1/M2.
Until then the TS server in `server/` is authoritative for those routes.

## Layout

```
go-server/
├── cmd/server/main.go        # entry point; mirrors server/index.ts
├── internal/
│   ├── auth/                 # JWKS + insecure-noverify; mirrors server/auth.ts
│   ├── db/                   # pgx pool + migration runner; mirrors server/db.ts
│   ├── httpapi/              # hand-rolled router; mirrors server/http.ts
│   ├── sync/                 # wire types + ComputeEventID
│   └── team/                 # BatchUpsert, AddMember, GetMembership, SetPrivacyFloor
├── Dockerfile                # multi-stage, distroless:static, non-root
├── TASKS.md                  # phased migration plan (M0-M3)
└── README.md                 # this file
```

## Why Go

- **Static single-binary deploy** — distroless:static image is ~15 MB
  vs ~150 MB for the Node image. The TS image is fine; the Go image just
  drops better into restricted environments.
- **Lower runtime memory.** The 512m compose limit is generous for Go;
  it's tight for Node + pg + jose under steady load.
- **Type system catches the int64 overflow risk.** TS uses `bigint`
  pervasively to avoid the JS Number/Postgres BIGINT mismatch (see
  `pg.types.setTypeParser(20, BigInt)`); Go's `int64` is the wire
  representation already.

The TS server is not going away tomorrow. The plan in `TASKS.md` keeps
both running until M3 cutover.
