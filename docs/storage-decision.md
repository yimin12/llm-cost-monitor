# Storage decision: Postgres only

## Decision

**One event-store backend: Postgres 17.** Both dev and shipped builds.
The earlier plan to keep `better-sqlite3` as a parallel "shipped-build"
backend is dropped.

## Why one backend

- The codebase had quietly bifurcated: `src/main/storage/` was Postgres
  via `pg`, but the README still said `main` shipped builds used
  better-sqlite3. There was no actual SQLite implementation of
  `EventRepository`, no SQLite migrations directory, and no codepath in
  `src/main/index.ts` to select between the two.
- A real two-backend story means doubling the test matrix (every
  repository test runs against both engines), maintaining two migration
  trees, and writing a portability shim around bigint, ON CONFLICT
  semantics, and BIGSERIAL/INTEGER PK differences. That's weeks of work
  for users who are not asking for it.
- Postgres 17 in a containerized sidecar (or as an embedded Postgres in
  shipped builds) is fast enough for an event store that holds at most
  a few hundred thousand rows per user. The BIGINT cost-as-bigint
  contract works cleanly with `pg.types.setTypeParser(20, BigInt)`; the
  same contract on SQLite would require manual int64 plumbing (SQLite's
  storage class is dynamic and `INTEGER` columns return JS number, not
  bigint, in better-sqlite3).

## What this changes

- `src/main/index.ts` no longer hints at a future SQLite swap. The
  comment block at the `openPool({})` call now states Postgres is the
  only backend.
- `README.md` quickstart says: shipped builds will bundle Postgres
  (either via embedded-postgres or a managed sidecar via `DATABASE_URL`).
- `better-sqlite3` stays in `package.json` — but **only** because
  `src/main/providers/cursor/credentials.ts` reads the *Cursor IDE's*
  own SQLite token store. That has nothing to do with our event store.
  If we drop Cursor support, we can drop better-sqlite3 too.

## Migration trees

There are now exactly two migration directories, both Postgres:

| Tree | Purpose |
| ---- | ------- |
| `migrations/` | Desktop-local event store (`events`, `files`, `pricing_overrides`, `local_node`, `sync_cursor`, `sync_outbox`). |
| `server-migrations/` | Team server (`teams`, `team_members`, `usage_events`, `event_daily_rollup`, `sync_conflicts`). |

Both are loaded by `runMigrations(pool, dir)` in
`src/main/storage/migrations.ts` and `server/db.ts` respectively. The
schema versions are independent — the desktop runs ahead of the server
in slice numbering today and that's expected.

## What we are NOT going to do

- Implement a `SqliteEventRepository` parallel to `PostgresEventRepository`.
- Ship a build-time `STORAGE_BACKEND=sqlite|postgres` selector.
- Add a "lite" mode for users who don't want Docker. If embedded-postgres
  is too heavy at ship time we'll consider duckdb or libsql, but that's
  a separate decision — and again, only one backend.
