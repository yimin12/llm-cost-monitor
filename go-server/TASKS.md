# go-server migration plan

Phased TS→Go port of `server/`. Goal: a wire-compatible Core Service
binary that operators can swap into `docker-compose.yml`'s `server` service
without client-side changes. The TS server stays the reference until M3.

## Principles

- **Wire compatibility first.** Same DSN env, same migration files, same
  HTTP routes, same JSON shapes. Different language ≠ different protocol.
- **Schema is shared.** `server-migrations/*.sql` is the single source of
  truth; both backends apply the same files in the same order.
- **No drift in invariants.** sync_event_id forgery guard, last-admin
  protection, append-only events, conflict-row semantics — must match.
- **Postgres only.** No SQLite re-introduction (see `docs/storage-decision.md`).

## Milestones

### M0 — Scaffold (THIS MILESTONE — DONE)

- [x] `go.mod` with pgx + jwx
- [x] `cmd/server/main.go` — listener, signal handling, slog
- [x] `internal/db` — pool + migrations runner, mirroring `server/db.ts`
- [x] `internal/auth` — JWKS / insecure-noverify modes, mirroring `server/auth.ts`
- [x] `internal/sync` — wire types + `ComputeEventID` (sha256 forgery guard)
- [x] `internal/team` — service: `BatchUpsert`, `AddMember`, `GetMembership`,
      `SetPrivacyFloor`, `EnsureTeam`
- [x] `internal/httpapi` — router for the routes M0 covers; stubs M1+ ones
- [x] `Dockerfile` — multi-stage, distroless:static, pinned bases

### M1 — Parity for the upload path

Goal: desktop app's `sync-queue.ts` can post to the Go server in dev and
all golden-path uploads succeed. TS server still answers reads.

- [ ] Add `internal/team/rollup.go`:
  - Port the `event_daily_rollup` accumulation buckets from
    `team-service.ts` lines 237–409. Same key shape (`user|node|date|provider|model|project_hash`)
    so the schema invariants hold.
  - Same UPSERT idempotency guard (`'inserted'` only).
- [ ] Add `internal/team/daily.go`:
  - Port `upsertDaily`. The endpoint dispatches on `payload.kind` so this
    is a small companion to `upsertEvent`.
- [ ] Add `internal/sync/payload.go` daily-shape parsing path.
  - `Event` and `Daily` already exist; add a discriminated decoder so
    `BatchUpsert` accepts the mixed-kind body the desktop sends.
- [ ] Conformance test suite: replay a captured TS-server request log
      against both implementations and assert identical Postgres row state.
      Captured logs land in `go-server/internal/team/testdata/`.
- [ ] Wire docker-compose: add an opt-in `server-go` service so reviewers
      can run both side-by-side under different ports.

### M2 — Reads + admin

Goal: GET /usage and the admin endpoints land. Desktop's
`renderer/team/Overview.tsx` works against the Go server.

- [ ] Port `getOverview` (the v_merged_daily view query). The view itself
      is already in `server-migrations/0003_event_daily_rollup.sql`; we
      just need the SELECT + projection.
- [ ] Port `revokeMember`, `setMemberRole` (last-admin guard).
- [ ] Backfill `handleRevokeMember` / `handleSetRole` in
      `internal/httpapi/server.go` (currently TODO).
- [ ] Match the `getOverview` response shape against
      `src/shared/ipc-channels.ts:TeamOverview` exactly.

### M3 — Cutover

- [ ] Update `docker-compose.yml` `server` service to use the Go image by
      default; keep the TS image behind `--profile legacy-ts`.
- [ ] Update `package.json` scripts: `npm run server:dev` runs the Go
      binary via `go run ./go-server/cmd/server`.
- [ ] Delete `server/`, `server-migrations/` stays (shared).
- [ ] Update `docs/team-sync.md` to point at `go-server/`.

## Known gaps to plug as we go

- **Rate limiting + size caps.** TS server has none. Add per-IP token
      bucket in `internal/httpapi` before M3. Track in
      `docs/security-todo.md` (new file at M2).
- **Structured request logging.** TS uses `console.log`. Go uses slog
      with request IDs and per-request fields.
- **OpenTelemetry.** Defer past M3 — wrap the http.Handler when adopted.

## Out of scope

- Replacing the desktop's TS main process. That is a separate
      `go-desktop/` track tracked in `go-desktop/MIGRATION_PLAN.md`.
- Reintroducing SQLite. Closed out by `docs/storage-decision.md`.
