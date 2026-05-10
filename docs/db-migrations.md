# Database migrations

Two databases, two Prisma schemas, two migration histories — one tool.

| | Desktop (per-install Postgres) | Server (team-sync backend) |
| --- | --- | --- |
| Default DB name | `llm_cost_monitor` | `lcm_team_sync` |
| Schema file | `prisma/desktop/schema.prisma` | `prisma/server/schema.prisma` |
| Env var | `LCM_DATABASE_URL` | `LCM_SERVER_DATABASE_URL` |
| Legacy SQL | `migrations/0001…0004_*.sql` | `server-migrations/0001_init.sql` |

The legacy `.sql` files are still executed by the desktop's in-process
migration runner (`src/main/storage/migrations.ts`) and the server's
equivalent (`server/db.ts`). Prisma was layered on AFTER they ran. The
existing schema state was captured as `0_init` and marked applied so
Prisma knows the slate is clean from its perspective.

Going forward: **new schema changes go through Prisma**. The legacy SQL
runner stays in place as a belt-and-suspenders safety net but won't see
new files added to `migrations/` — its v4 file (`0004_team_sync.sql`)
is the last hand-written one. A future cleanup commit will delete the
runner entirely once we trust Prisma fully.

## Adding a new migration

```sh
# 1. Edit the schema you're changing.
$EDITOR prisma/desktop/schema.prisma         # or prisma/server/schema.prisma

# 2. Generate + apply the migration locally.
#    Prompts for a description, then writes prisma/<which>/migrations/<ts>_<name>/migration.sql
#    and applies it to your dev DB.
npm run prisma:desktop:dev                   # interactive
# or
npm run prisma:server:dev

# 3. Commit BOTH the updated schema.prisma and the generated migration folder.

# 4. Other devs and CI catch up with:
npm run db:migrate                           # dockerized, runs both schemas
```

## Running migrations in CI / production

The dockerized runner (`Dockerfile.migrate`) is the canonical way to apply
migrations on a fresh database:

```sh
# One-shot for both schemas, talking to the docker-compose Postgres.
npm run db:migrate

# Just the desktop schema.
npm run db:migrate:desktop

# Just the server schema.
npm run db:migrate:server
```

The container ships with `prisma@6.19.3` and the contents of `prisma/`.
It picks up `LCM_DATABASE_URL` / `LCM_SERVER_DATABASE_URL` from compose's
`environment:` block — pointing at the `postgres` service over the
default compose network.

For a non-dev target, build the image, tag it, and run with the appropriate
env var pointing at production:

```sh
docker build -f Dockerfile.migrate -t lcm-migrate:6.19.3 .
docker run --rm \
  -e LCM_DATABASE_URL=postgres://user:pw@db.example.com/llm_cost_monitor \
  lcm-migrate:6.19.3 \
  prisma migrate deploy --schema prisma/desktop/schema.prisma
```

## Status check

```sh
npm run prisma:status
```

Reports both schemas. Useful after pulling new commits to see whether
you're behind on migrations.

## Resetting dev databases

```sh
npm run db:reset    # nukes the volume; both DBs need re-creation + re-migration
docker exec llm-cost-monitor-postgres psql -U lcm -d postgres -c "CREATE DATABASE lcm_team_sync;"
npm run db:migrate
```

The `db-init/01-create-team-sync-db.sql` script *also* creates
`lcm_team_sync` automatically on a brand-new volume — but only on the
volume's first boot. After `db:reset`, manual creation as shown above
guarantees both DBs exist before `db:migrate` runs.

## Why two schemas, not one?

- Different deployment topologies. The desktop DB lives on every
  end-user's laptop; the server DB lives in one place per team. Mixing
  them in one schema would force Prisma to expect a single connection
  URL.
- Different rollout cadences. A schema change in the team-sync server
  rolls out to one shared DB; a desktop schema change has to ride the
  app's auto-update channel and migrate on every machine.
- Different failure modes. The desktop runs migrations against a local
  Postgres at app boot via `src/main/storage/migrations.ts`; the server
  runs them out-of-band before the HTTP listener starts.

## What didn't change

- Runtime DB access still goes through `pg` (raw SQL via the named-param
  shim in `src/main/storage/db-utils.ts`). No `@prisma/client` runtime
  dep.
- The desktop's in-process migration runner (`runMigrations` in
  `src/main/storage/migrations.ts`) still loads `migrations/*.sql`. It
  will continue to no-op on existing installs (every file already has
  its `INSERT INTO schema_version` row). New schema changes will only
  appear under `prisma/desktop/migrations/` — the in-process runner
  ignores them. To keep the local app in sync, run `npm run db:migrate`
  whenever a Prisma migration lands.
- Identical pattern on the server side (`server/db.ts` /
  `server-migrations/`).

A follow-up commit can drop the in-process runners entirely once we
trust Prisma as the only path; for now they coexist as a belt-and-suspenders
safety net.
