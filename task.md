# task.md — OCI data-persistence node (handoff)

_Handoff for a fresh Claude session. Goal: the team-sync "state recording"
database (multi-node token + cost metadata) is persisted on a free Oracle Cloud
node and exposed as a read/write endpoint. The core is **already running**; this
doc is how to pick it up and what's left._

## TL;DR current state
- **Instance #1 `lcm-sync`** (Oracle **Always-Free** `VM.Standard.E2.1.Micro`, 1 OCPU/1 GB, x86_64, Ubuntu 24.04, +2 GB swap) is **up** in **us-ashburn-1 / AD-3**, public IP **157.151.229.109**.
- The persistence stack is **deployed and verified** on it: Postgres 17 + the team-sync server, schema migrated to **v3**, write→read round-trip + restart-durability proven.
- **Multi-node consistency verified** (2026-06-01): `team-demo` now has **2 members** (`user-1` admin, `user-2`) across **3 nodes** (`node-1`+`node-2` = user-1, `node-3` = user-2), **5 events**, **$10.25** total. `GET /usage` sums cost + tokens consistently across all nodes, and the totals survive a full `docker compose restart` (named volume `lcm-deploy_lcm_pgdata`). Reproduce/extend with **`deploy/seed-multinode.sh`** (`ENDPOINT=… TEAM=… ./seed-multinode.sh`).
- Endpoint is bound to **127.0.0.1:4017 on the box only** (NOT internet-exposed, by user choice). Reach it from the Mac via an SSH tunnel.
- **Instance #2 `lcm-arm`** (the full free ARM quota, `A1.Flex` 4 OCPU/24 GB) is **not yet created** — Ashburn ARM is capacity-locked; a retry loop is hunting it (see "ARM hunt").

## Access
- SSH: **`ssh oci`** (passwordless). Config: `~/.ssh/config` host `oci` → `ubuntu@157.151.229.109`, key `~/.ssh/oci_lcm` (IdentitiesOnly).
- Endpoint tunnel from Mac: `ssh -L 4017:localhost:4017 oci` → then `http://localhost:4017`.
- OCI CLI: profile **`lcm`**, session-token auth (`oci ... --profile lcm --auth security_token`). Tenancy OCID in `/tmp/lcm-tenancy.txt`; user `hymlaucs@gmail.com`. **Session tokens expire ~1 h** (tenancy caps at 60 min even when 720 is requested) — refresh with `oci session refresh --profile lcm` before expiry, or re-auth: `oci session authenticate --region us-ashburn-1 --profile-name lcm --session-expiration-in-minutes 720`.

## What's deployed on `lcm-sync` (`~/lcm-deploy/`)
- `docker-compose.box.yml` — services:
  - **`lcm-pg`** = `postgres:17.2-alpine`, volume **`lcm_pgdata`** (data persists across restarts), DBs `llm_cost_monitor` + `lcm_team_sync` (created by `db-init/01-create-team-sync-db.sql`).
  - **`lcm-server`** = image **`lcm-server:fixed`**, `LCM_SERVER_AUTH=insecure-noverify` (demo), published `127.0.0.1:4017->4017`, read-only rootfs.
- `.env` (chmod 600) holds `POSTGRES_PASSWORD` (random) — **do not commit / echo it**.
- Bring up / status: `cd ~/lcm-deploy && docker compose -f docker-compose.box.yml --env-file .env up -d` · `docker compose ... ps` · `docker logs lcm-server`.

## The endpoint (read / write)
Server source lives in the repo (`server/`, `server-migrations/`); it self-migrates on boot (`runServerMigrations`). Auth header is `Authorization: Bearer <jwt>`; in `insecure-noverify` the JWT is decoded (not verified) and `sub` = userId. To write, the team + an **active** member must exist (bootstrap via psql: insert into `teams` + `team_members`). The `sync_event_id` must equal `sha256("teamId|userId|nodeId|localEventId")` (forgery guard in `server/team-service.ts`).
- **WRITE** `POST /v1/teams/:teamId/events:batchUpsert` body `{"events":[SyncedEventV1...]}` (shape in `src/shared/sync.ts`).
- **READ** `GET /v1/teams/:teamId/usage` → totals **summed across nodes**, per-member + per-provider breakdown, today/MTD.
- `GET /healthz` → `{"ok":true}`.
- Demo team already present: `team-demo` / member `user-1` (admin).

## How the image was built (1 GB box can't build it)
`Dockerfile.server`'s build stage (`npm ci` + `tsc`) is too heavy for 1 GB, so it was **cross-built on the Mac**: `docker buildx build --platform linux/amd64 -f Dockerfile.server -t lcm-server:amd64 --load .`, then `docker save | ssh oci 'docker load'`.

### ⚠️ Known bug worth a real fix
`Dockerfile.server` runtime stage pins **`jose@6.2.3` (ESM-only)** but the server compiles to **CommonJS** → `require("jose")` throws `ERR_REQUIRE_ESM`, crash-loop. **Workaround applied on the box**: layered `jose@5.9.6` over the image → tag `lcm-server:fixed`. **Proper fix (TODO/PR):** pin `jose@5` in the runtime `npm install` line of `Dockerfile.server` (or emit ESM for the server build). `jose@5` is API-compatible for `createRemoteJWKSet`/`jwtVerify`/`decodeJwt`.

## Deploy assets in the repo (for the production/public path)
Uncommitted on `main` (created earlier): `docker-compose.prod.yml`, `deploy/Caddyfile`, `deploy/env.example`, `deploy/backup.sh`, `deploy/README.md`. These add **Caddy TLS + `jwks` auth + daily pg_dump backups** for a public deploy — use them when a domain is available.

## Next steps (pick up here)
1. **Make it usable to real clients** (currently localhost-only + no real auth):
   - Get a domain → point A record at `157.151.229.109` → switch to `docker-compose.prod.yml` (Caddy + Let's Encrypt) with `LCM_SERVER_AUTH=jwks` and `LCM_SERVER_AUDIENCE=474644305609-itbl41homk2q8abu1325agn2vhf3rpm4.apps.googleusercontent.com` (desktop OAuth client_id, `src/shared/oauth-config.ts`).
   - Then set each desktop app's `teamSync.serverUrl` (`src/shared/sync.ts`) to the HTTPS URL.
2. **Backups**: install `rclone` on the box, configure a B2/R2 remote, cron `deploy/backup.sh` (daily `pg_dump lcm_team_sync` → object storage). ~$0 at this data size.
3. **Land the ARM box** (see below) and migrate the stack there (24 GB ≫ 1 GB; far more headroom). Same `docker compose` + restore a `pg_dump`.
4. **Fix the `jose` bug in `Dockerfile.server`** and open a PR.
5. Commit the `deploy/` assets + `docker-compose.prod.yml` to a branch / PR (still uncommitted).

## ARM hunt (instance #2, optional)
- Loop: `/tmp/lcm-arm-hunt.sh` (cycles all 3 ADs, `A1.Flex` 4/24, ~12 h deadline, stops on success/limit/auth-expiry). Status markers: `/tmp/lcm-arm.id` (OCID when landed, else `AUTH_EXPIRED`/`LIMIT`/`EXHAUSTED`), log `/tmp/lcm-arm-hunt.log`.
- Networking already built: VCN `lcm-vcn`, public subnet, sec-list ingress 22/80/443 (OCIDs in `/tmp/lcm-oci.env`). ARM Ubuntu image: `ocid1.image.oc1.iad.aaaaaaaaioyy7je3vndsccly24frkfptl5lggvyupubg74awcf2gmua7k3ra`.
- Capacity in Ashburn has been "Out of host capacity" on every attempt so far; it's a lottery. Relaunch: `nohup bash /tmp/lcm-arm-hunt.sh >/dev/null 2>&1 &` (token must be valid).

## Free-tier limits reminder
2× E2 micro (using 1) + 4 OCPU/24 GB ARM pool (unused) = up to 6 VMs; 200 GB total block storage; 10 TB/mo egress. Don't crypto-mine (account suspension).
