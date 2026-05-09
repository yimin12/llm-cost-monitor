# Auth + Postgres plan

**Branch:** `feat/auth-gmail`
**Worktree:** `/Volumes/Portal_SSD/pojo/llm-cost-monitor-auth/`
**Status:** plan-only — no code yet. Awaiting answers to §10 before implementation.

---

## Decisions captured 2026-05-07

| Decision | Choice |
|---|---|
| Auth scope (was A / B / C in earlier draft) | **Option A — identity-only Sign in with Google.** No Gmail readonly, no cloud sync. Locked. |
| Persistence layer | **PostgreSQL (latest stable, 17.x as of 2026-05) running in Docker.** Replaces better-sqlite3 entirely. Locked. |
| OAuth flow | **OAuth 2.0 + PKCE + loopback redirect** (Google's official native-app guidance). |
| Identity scopes | `openid email profile` — non-sensitive, no verification gate. |
| Token storage | **Electron `safeStorage` API** (macOS Keychain / Linux libsecret / Windows DPAPI). No `keytar` native rebuild. |
| Branch strategy | Postgres migration + auth land **together on `feat/auth-gmail`**. Both touch storage; bundling them avoids two rebases. |

---

## 1. The tension we have to resolve first (unchanged)

The app's current identity is **strictly on-device**:

- `docs/architecture.md` D14: *"Telemetry: none. … Data location: all on the user's machine."*
- The privacy banner: *"On-device only. Session logs scanned locally; no telemetry, no cloud sync."*
- README masthead: *"Local-only, no telemetry, MIT."*

Two changes affect that posture:

1. **Postgres-in-Docker** — still on-device. Postgres runs on the user's localhost, in a Docker container the user owns. Data does not leave the machine. Privacy posture is preserved.
2. **Sign in with Google (Option A)** — adds a single OAuth round-trip to Google during sign-in, then nothing else leaves the device. Token sits in Keychain. No usage data uploaded. Privacy posture is preserved if we keep Option A's invariants strict (no Gmail scope creep, no usage upload).

Both changes are **opt-in extensions** — sign-in remains optional, Postgres is a stack change but doesn't add user-facing surface area.

---

## 2. Why Postgres-in-Docker (recapping the user's call)

User asked for relational data to live in Postgres rather than SQLite, with a Docker container hosting it. Picked the latest stable Postgres (17 series). Implications I want to flag:

**Pros (matches the user's intent):**
- Real concurrent connections — if we ever want a separate "collector" process (per CLI Pulse §2) or a CLI alongside the GUI, Postgres handles it natively. SQLite needs WAL gymnastics.
- Industry-standard SQL — easier to port queries to other tools (Grafana, Metabase, dbt) without translation.
- BIGINT, JSONB, ranges, window functions natively — relevant once aggregations get fancier.

**Cons / trade-offs (worth knowing):**
- **Removes the "just runs" property.** Today, `npm run dev` boots the app instantly with zero infrastructure. After this change, the user must have Docker Desktop or `colima` running. We add a `predev` check that warns if Postgres isn't reachable.
- **Distribution gets harder.** A shipped `.dmg` / `.AppImage` cannot ship Postgres. For distribution we have two paths: (a) keep SQLite as a build-time toggle for shipped binaries; (b) require end users to run Postgres themselves. **My recommendation:** dev-mode-Postgres + shipped-binary-SQLite, controlled by a config flag. **This is the #1 open question in §10.**
- **Bigger surface to reason about.** Connection pooling, prepared statements, lifecycle (Postgres can be down when app launches). All solvable but real.

If the user says "Postgres for everything including shipped builds", we'd need to bundle a tiny Postgres or require Docker as a runtime dep. That's the full-cloud-app trajectory and we should know we're choosing it.

---

## 3. Postgres migration — architecture

### 3.1 docker-compose

New file at repo root: `docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:17-alpine        # latest stable; ~80 MB
    container_name: llm-cost-monitor-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: llm_cost_monitor
      POSTGRES_USER: lcm
      POSTGRES_PASSWORD: lcm_dev      # dev only; never used outside the user's machine
    ports:
      - "127.0.0.1:5433:5432"        # localhost-only bind; non-default port to avoid clobbering an existing Postgres
    volumes:
      - lcm_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U lcm -d llm_cost_monitor"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  lcm_pgdata:                         # named volume; survives `docker compose down`
```

**Key choices and why:**

- `postgres:17-alpine` — latest stable as of 2026-05. Alpine is ~80 MB vs ~300 MB for the Debian-based image. Same engine.
- **Port 5433** instead of 5432 — many devs already have a default-port Postgres for other projects. Bind to a non-default to avoid stomping. App connection string baked to this.
- **`127.0.0.1:5433:5432`** — only loopback bind. Container is unreachable from the network. No accidental exposure.
- **Named volume `lcm_pgdata`** — survives container recreation (`docker compose down && up`). Only lost if the user explicitly `docker volume rm lcm_pgdata`.
- **`POSTGRES_PASSWORD=lcm_dev`** is dev-only. Never used outside the user's machine; the bind to `127.0.0.1` is the actual security boundary. Documented prominently in README so anyone reading doesn't assume it's a "secret".

**Convenience npm scripts:**

```jsonc
{
  "scripts": {
    "db:up":   "docker compose up -d postgres",
    "db:down": "docker compose down",
    "db:logs": "docker compose logs -f postgres",
    "db:psql": "docker compose exec postgres psql -U lcm -d llm_cost_monitor",
    "db:reset": "docker compose down -v && docker compose up -d postgres",
    "predev":  "npm run db:up && electron-builder install-app-deps"
  }
}
```

`predev` chains `db:up` first so `npm run dev` becomes the same one-liner the user already uses. The script returns immediately after `up -d`; the app's `main/storage/connect.ts` (see 3.3) waits for the healthcheck.

### 3.2 Driver choice

| Option | Pros | Cons | Pick |
|---|---|---|---|
| `pg` (node-postgres) | Battle-tested, the default, every codebase uses it. Has built-in pool. | API is callback-flavored; named params need a wrapper. | **Pick.** Maturity wins for a single-user app. |
| `postgres.js` (Porsager) | Smallest, fastest, native template-string queries. | Younger; some edge cases under heavy load. | Strong runner-up. |
| `pg-promise` | Built on `pg` + helpers. | Now mostly redundant — `pg` itself is async. | Skip. |
| ORM (Prisma/Drizzle/Kysely) | Type-safe queries. | Migration tooling overhead; we're well-served by 4 tables of plain SQL. | Skip — see `architecture.md` D9. |

**Picking `pg`** — version `^8.13.0` (latest as of 2026-05). Add `@types/pg` dev dep.

By default, `pg` returns BIGINT as strings to avoid JS number precision loss. We'll override via `pg.types.setTypeParser` to return JS `bigint` directly, mirroring the better-sqlite3 `defaultSafeIntegers(true)` behavior we already have. The `bigint`-everywhere invariant in `UsageEvent.computedCostMicroUsd` survives unchanged.

### 3.3 Connection lifecycle

```
src/main/storage/
├── connect.ts          # creates a pg.Pool; waits for `pg_isready` on first connect
├── migrations.ts       # runs migrations against the pool; idempotent (uses schema_version table)
├── event-repository.ts # ports the existing repo from better-sqlite3 → pg
├── file-cache.ts       # ports
└── db-types.ts         # readBigint/readCount helpers, parameter binding wrapper
```

**Startup sequence in `main/index.ts`:**

1. Open `pg.Pool({ connectionString: env.DATABASE_URL ?? 'postgres://lcm:lcm_dev@127.0.0.1:5433/llm_cost_monitor' })`.
2. Retry-with-backoff for up to 30 s if Postgres isn't ready (Docker just started).
3. Run migrations (idempotent).
4. Continue with existing flow (load pricing, build providers, register IPC).
5. On `before-quit`, `pool.end()`.

**If Postgres is unreachable after 30 s:** show an in-app error (red banner in dropdown header) with a `Retry` button. App stays running but cost data is unavailable. We never silently fail or fall back to SQLite — predictable failure mode.

### 3.4 Schema port

Existing SQLite v1 → Postgres v1, expressed as `migrations/0001_init.sql`:

```sql
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

CREATE TABLE IF NOT EXISTS events (
  id                          TEXT PRIMARY KEY,
  provider                    TEXT NOT NULL,
  provider_raw_tag            TEXT,
  model                       TEXT NOT NULL,
  timestamp                   BIGINT NOT NULL,
  project                     TEXT,
  project_raw_slug            TEXT,
  session_id                  TEXT,
  message_id                  TEXT,
  input_tokens                BIGINT NOT NULL DEFAULT 0,
  output_tokens               BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens           BIGINT NOT NULL DEFAULT 0,
  cache_creation_5m_tokens    BIGINT NOT NULL DEFAULT 0,
  cache_creation_1h_tokens    BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens            BIGINT,
  tool_call_count             BIGINT,
  latency_ms                  BIGINT,
  computed_cost_micro_usd     BIGINT NOT NULL,
  pricing_snapshot_version    TEXT NOT NULL,
  source_file                 TEXT NOT NULL,
  source_line_offset          BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp DESC);
CREATE INDEX IF NOT EXISTS events_provider_model_idx ON events(provider, model);
CREATE INDEX IF NOT EXISTS events_project_idx ON events(project);

CREATE TABLE IF NOT EXISTS files (
  path           TEXT PRIMARY KEY,
  mtime          BIGINT NOT NULL,
  last_parsed_at BIGINT NOT NULL,
  last_offset    BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pricing_overrides (
  model              TEXT PRIMARY KEY,
  input_per_m        BIGINT NOT NULL,
  output_per_m       BIGINT NOT NULL,
  cache_write_per_m  BIGINT,
  cache_read_per_m   BIGINT,
  source             TEXT NOT NULL
);

INSERT INTO schema_version (version) VALUES (1)
ON CONFLICT (version) DO NOTHING;
```

**Diffs from SQLite version:**
- `INTEGER` → `BIGINT` everywhere we store epoch-ms or 64-bit counts. (SQLite's `INTEGER` is 8-byte; Postgres's default `INTEGER` is 4-byte. Need to be explicit.)
- `INSERT … VALUES (1)` becomes `ON CONFLICT (version) DO NOTHING` for idempotency on re-runs.

A second migration `0002_auth_user.sql` lands with auth slice A4:

```sql
CREATE TABLE IF NOT EXISTS auth_user (
  sub                 TEXT PRIMARY KEY,
  email               TEXT NOT NULL,
  email_verified      BOOLEAN NOT NULL DEFAULT FALSE,
  name                TEXT,
  picture_url         TEXT,
  last_signed_in_at   BIGINT NOT NULL,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO schema_version (version) VALUES (2)
ON CONFLICT (version) DO NOTHING;
```

### 3.5 Query port

Differences between better-sqlite3 and `pg`:

| Concern | better-sqlite3 | `pg` |
|---|---|---|
| Sync vs async | Sync (`stmt.run()`) | Async (`await pool.query(...)`) |
| Named params | `@name` | `$1`, `$2` (positional only) |
| BIGINT return | `bigint` (with `safeIntegers`) | string by default; configure `types.setTypeParser(20, BigInt)` |
| BOOLEAN | INTEGER 0/1 | native `boolean` |
| Prepared statements | Per-statement objects | First-use auto-prepare (or use `pg.Pool.query` with a `name`) |
| In-memory testing | `:memory:` | **Tests need a real Postgres** — see 3.7 |

Every `EventRepository` method becomes async. The IPC layer's already async, so this is a refactor not a UX change. Renderer is unaffected.

**Named params:** I'll add a tiny helper:

```ts
// src/main/storage/db-types.ts
export function namedQuery<T>(sql: string, params: Record<string, unknown>): {
  text: string
  values: unknown[]
} {
  // Replace @name → $N, build values array in encounter order.
}
```

~30 LOC. Keeps query SQL readable.

### 3.6 Bigint round-trip in `pg`

```ts
import pg from 'pg'

// Postgres OIDs:
//   20 = int8 (BIGINT) — return as bigint, not string
//   1700 = numeric — leave as string (for safety, but we don't use NUMERIC)
pg.types.setTypeParser(20, (v: string) => BigInt(v))
```

Done once at module-load time before any pool is created.

### 3.7 Test strategy

The existing tests use `openDatabase(':memory:')` from better-sqlite3 — Postgres has no equivalent. Three options:

| Option | Trade-off |
|---|---|
| **Testcontainers** (`@testcontainers/postgresql`) — spin up an ephemeral Postgres per test file | Heavy (~5 s startup), but accurate. Industry standard. |
| **pg-mem** — pure-JS in-memory Postgres mock | Fast (<10 ms), but only ~80% Postgres compatibility. Hits real edges. |
| **Shared dev Postgres + per-test schemas** | Fast and accurate, but requires Docker running for tests. CI gets messy. |

**Pick: Testcontainers.** Slow tests are still <30 s total, accurate, no surprises. Add to `vitest.config.ts` per-test setup. Falls back to skipping if Docker isn't available locally (so users without Docker can still run a subset).

Alternative: keep a tiny SQLite layer for tests only behind an interface — but that defeats the point of validating against the real DB.

### 3.8 Migration-only concerns

- **Existing user data.** The current SQLite `usage.db` has 848 events. We should ship a one-shot import script (`bin/import-from-sqlite.ts`) that reads the old file and inserts into Postgres. Run once on first launch after upgrade. Documented in README.
- **The `~/Library/Application Support/llm-cost-monitor/usage.db` file** stays as-is until the user manually deletes it (we don't want to destroy data on upgrade).
- **CI:** GitHub Actions Postgres service, same image, same port. Documented in `.github/workflows/ci.yml` (slice 15 territory but worth noting).

---

## 4. Auth — architecture (Option A, locked)

### 4.1 OAuth flow

OAuth 2.0 PKCE + loopback (Google's official native-app flow: <https://developers.google.com/identity/protocols/oauth2/native-app>).

Sequence:
1. Main process generates `code_verifier` (random 43-128 chars) and `code_challenge = base64url(sha256(verifier))`.
2. Main spins up a one-shot HTTP server on `127.0.0.1:0` (OS-assigned port, e.g. 50932).
3. Main calls `shell.openExternal(googleAuthUrl)` → user's default browser → Google sign-in → redirects to `http://127.0.0.1:50932/callback?code=...&state=...`.
4. Loopback server receives `code`, returns a tiny "you can close this tab" HTML, shuts down.
5. Main exchanges `(code, code_verifier)` at `oauth2.googleapis.com/token` for `{ access_token, refresh_token, id_token }`.
6. Main verifies `id_token` (JWS signature + `aud == OUR_CLIENT_ID` + `iss == accounts.google.com` + `exp` not past) using `jose` against Google's JWKS at `https://www.googleapis.com/oauth2/v3/certs`.
7. Main extracts `(sub, email, email_verified, name, picture)`, persists to `auth_user` table in Postgres, stores `refresh_token` in Keychain via `safeStorage`.
8. Broadcasts `auth:state-changed` IPC; renderer updates the dropdown header.

**Why not** in-app `BrowserWindow` for the OAuth dialog: Google explicitly disallows it (anti-phishing) and checks the User-Agent.
**Why not** the legacy out-of-band copy-paste flow: Google deprecated it in 2022.

### 4.2 Scopes

```
openid
email
profile
```

Three scopes. **None require Google's verification gate.** No restricted scopes.

### 4.3 Storage

| Data | Where | Why |
|---|---|---|
| `refresh_token` | Keychain via Electron `safeStorage` | Secret. Survives restarts. OS-encrypted. |
| `access_token` | In-memory only | Short-lived. Re-mint as needed. |
| `id_token` | Discarded after verification | We only need its claims. |
| `(sub, email, name, picture)` | Postgres `auth_user` | Local mirror for fast UI render without network. |
| `client_id` | Bundled in `electron-builder` config (public) | Public per Google's native-app guidance. PKCE protects the flow. |
| `client_secret` | **Not used.** | PKCE-only flow. |

### 4.4 Library choices

- **OAuth state machine:** roll our own. ~150 LOC. Uses `node:crypto` for PKCE, `node:http` for loopback.
- **JWT verification:** `jose` (~30 KB, native ESM). `jose.jwtVerify(idToken, JWKS_FROM_GOOGLE)`.
- **Keychain access:** Electron `safeStorage` (built-in, all 3 platforms, no native rebuild).
- **Loopback server:** `node:http`.

No new native modules. Survives the `pg` driver's pure-JS install cleanly.

### 4.5 Threat model — what could go wrong

| Threat | Mitigation |
|---|---|
| Token theft via XSS in renderer | Renderer never sees refresh tokens; `safeStorage` only invoked from main; IPC returns claims only |
| Network MITM on OAuth callback | PKCE verifier never leaves main; loopback `127.0.0.1` is browser-loopback-only |
| Replay attack with stolen `code` | PKCE: attacker without `code_verifier` can't redeem |
| Refresh token leakage from Keychain | `safeStorage` uses OS-level encryption |
| Phishing via fake OAuth window | We use system browser, not embedded — user sees real Google chrome |
| Stale tokens after Google password change | Revalidate on launch; sign out gracefully on 401 |
| Postgres password compromise | Bind is `127.0.0.1` only; no external exposure |

---

## 5. UX (Option A — unchanged from earlier draft)

**Signed out:**

```
[ llm-cost-monitor ]                          [ ↻ refresh ]  [ 👤 Sign in ]
```

**Signed in:**

```
[ avatar ] hymlaucs@gmail.com                 [ ↻ refresh ]  [ ⋯ ]
```

`⋯` opens a tiny menu with "Sign out".

**No dropdown features are gated by sign-in.** All cost data, refresh, forecast — all of it works without ever signing in. Sign-in is purely identity.

---

## 6. Implementation slices

Slices land in this order on `feat/auth-gmail`. Each slice ends with a green typecheck + tests.

### Slice 0 — Postgres bring-up

**0a:** Add `docker-compose.yml`, `db:*` npm scripts, `predev` hook chains `db:up`. Confirm `npm run db:up && psql` works locally.

**0b:** Add `pg` + `@types/pg` deps. Create `src/main/storage/connect.ts` with retry-with-backoff and `pg.types.setTypeParser(20, BigInt)`.

**0c:** Port the schema to `migrations/0001_init.sql`. Add `migrations.ts` that runs all `migrations/*.sql` in order against the pool, tracking applied versions in `schema_version`.

**0d:** Port `EventRepository` and `FileCache` to async-pg. Update all callers.

**0e:** Update tests using Testcontainers. Verify all 47 existing test cases pass under Postgres.

**0f:** One-shot import script `bin/import-from-sqlite.ts` — reads `~/Library/Application Support/llm-cost-monitor/usage.db` if present, inserts into Postgres, idempotent (skips already-imported events by id).

**0g:** Update `docs/architecture.md` D9, README, build-log to reflect Postgres.

End state: `npm run dev` starts Postgres + the app, all existing features work, `psql` shows the same 848 events. **This slice is independently shippable** and could merge to main first if we want to land Postgres before auth — see §10 Q5.

### Slice A1 — Google Cloud Console setup (you do this)

You set up the OAuth client in Google Cloud Console; I cannot do this for you. **Detailed walkthrough in §8 below.**

### Slice A2 — Auth scaffold + types + IPC stubs

- `src/shared/auth.ts` — `AuthUser`, `AuthState` types
- `src/shared/auth-config.ts` — `GOOGLE_CLIENT_ID = "..."` (you fill in after A1)
- `src/shared/ipc-channels.ts` — add auth channels + state-changed event
- `src/main/auth/auth-service.ts` — facade returning `null` user for now
- `src/preload/index.ts` — expose `window.api.auth.{signin, signout, currentUser, onStateChanged}`
- `src/renderer/src/components/AuthHeader.tsx` — signed-out state only
- Tests: typecheck pass

End state: `npm run dev` shows a "Sign in" button that does nothing yet.

### Slice A3 — OAuth flow

- `src/main/auth/pkce.ts` — verifier + challenge (10 LOC)
- `src/main/auth/loopback-server.ts` — one-shot `127.0.0.1:0` server (40 LOC)
- `src/main/auth/google-oauth.ts` — orchestrates the flow (60 LOC)
- `src/main/auth/id-token-verify.ts` — `jose` against Google JWKS (30 LOC)
- Tests: PKCE math against RFC 7636 vectors; ID token verification with mocked JWKS

End state: clicking "Sign in" opens the system browser, you sign in, the dropdown header swaps to "hymlaucs@gmail.com" + avatar.

### Slice A4 — Storage + state plumbing

- Postgres migration `0002_auth_user.sql` (already specced in 3.4)
- `src/main/auth/auth-repository.ts` — wraps the table
- `src/main/auth/keychain.ts` — wraps `safeStorage`
- `AuthService` keeps in-memory state, persists user row + Keychain token, broadcasts `auth:state-changed`
- Tests: round-trip user; sign-out wipes state

### Slice A5 — Sign-out + UX polish + privacy update

- `Sign out` menu item in the renderer header
- Update privacy banner to show two-line state when signed in: "On-device only. Signed in as <email> for identity only — no usage data uploaded."
- Update README + `docs/architecture.md` D14
- Add `docs/privacy.md` mirroring CLI Pulse's §10 table
- Tests: clicking sign-out reverts header

### Slice A6 — Open future-extension hooks

Stub interfaces for B/C extension (no implementation):
- `RemoteUsageProbe` interface
- Document the extension point in `docs/architecture.md`

End state: branch is mergeable into `main` as a complete identity-only feature.

---

## 7. About the Google MCP — important clarification

You wrote *"you have the Google MCP, you can help me to get the token or something like that."* I want to make sure we're aligned on what the Google MCP can and can't do here, because there's a real misconception risk.

**What the Google MCP I have access to does:**
- It uses **your Claude.ai session's Google authorization** to access *your* Gmail, Calendar, and Drive on **your behalf within this Claude conversation**.
- I demonstrated this earlier when I pulled the Anthropic billing receipt out of your Gmail to do the cost reconciliation.

**What the Google MCP cannot do:**
- It cannot mint tokens for the desktop app. The desktop app is a different OAuth client. It needs **its own** Google Cloud Console project and **its own** OAuth client ID.
- It cannot bypass the Google Cloud Console setup step. Only you, signed into your Google account in a browser, can register an OAuth client.

**What I can do that's actually helpful:**
- Walk you through the GCP Console setup step-by-step (see §8 below).
- Verify, after you've done the setup, that the resulting `client_id` is well-formed and the consent screen looks right.
- Implement the desktop-side OAuth code that talks to the OAuth client you registered.
- After you sign in via the desktop app, I can use the Google MCP to spot-check that your Gmail receives the standard "New sign-in to your Google Account" notification email — that's a small but real validation that the OAuth round-trip worked end-to-end.

**If by "get the token" you meant something different** — for example, "use a token from the Google MCP context as the desktop app's auth token" — that won't work because they live in totally separate authorization scopes. Tell me what you actually want and we'll find the right path.

---

## 8. Google Cloud Console walkthrough (you do this; takes ~5 min)

I'll guide you. You log in and click; I'll watch the screenshots if you want to share them, and I'll catch errors.

1. Go to <https://console.cloud.google.com/>.
2. **Top-left dropdown → New Project.** Name: `llm-cost-monitor-personal`. No org. Create.
3. Wait ~10 s for the project to be ready, then select it from the top dropdown.
4. **APIs & Services → OAuth consent screen.**
   - User Type: **External** (any Google account can sign in; "Internal" requires a Workspace).
   - App name: `llm-cost-monitor`. User support email: yours.
   - **Scopes:** add `openid`, `email`, `profile`. (You'll see them under the "Non-sensitive scopes" tab — that's the whole point of staying off the verification gate.)
   - **Test users:** add `hymlaucs@gmail.com`.
   - Save. Status will be "Testing". You can stay here forever for personal use.
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID.**
   - Application type: **Desktop app**.
   - Name: `llm-cost-monitor mac`.
   - Create.
6. Copy the resulting `*.apps.googleusercontent.com` string. Paste it into a message to me, or directly into the file `src/shared/auth-config.ts` once it exists in slice A2.
7. **Optional sanity check:** the same Credentials page should show your client showing "Application type: Desktop app" and no client secret (PKCE doesn't use one). If you see a `Client secret` field, you accidentally created a Web app — delete and redo.

If you get stuck at any step, paste the error/screenshot and I'll diagnose.

---

## 9. Privacy posture changes (required if we ship this branch)

1. Dropdown footer: keep "On-device only" when signed out. When signed in, append: *"Signed in as <email>. Your Google account is used for identity only — no usage data is uploaded."*
2. README masthead: change *"Local-only, no telemetry, MIT."* → *"Local-only telemetry-free. Optional Sign-in with Google for identity only — no uploads."*
3. `docs/architecture.md` D14: update wording to reflect optional sign-in for identity.
4. New `docs/privacy.md` mirroring CLI Pulse §10's table.

These ride along with slice A5.

---

## 10. Open questions for you (please answer before I start slice 0)

1. **Postgres in shipped builds?** My recommendation: dev-only Postgres, build-time toggle to use SQLite for shipped `.dmg` / `.AppImage` (keeps the "just runs" property for end users). Yes / no?
2. **Postgres data location?** Named Docker volume `lcm_pgdata` (my plan), or a host-mounted path under `~/Library/Application Support/llm-cost-monitor/postgres-data/`? Named volume is cleaner; host-mount is more visible.
3. **Auto-start docker compose on app launch from Electron?** Or require user to run `npm run db:up` manually? My recommendation: chain via `predev` for `npm run dev` (already specced), and on first launch of the packaged app, surface a one-time setup screen that explains "Run docker compose up before launching."
4. **Multi-account sign-in?** Ever sign in with multiple Google accounts simultaneously? My recommendation: single account for v1 (schema accommodates either; UI is much simpler with one).
5. **Branch strategy:** keep Postgres + auth on the same branch (`feat/auth-gmail`) as planned, OR do Postgres on its own branch first (e.g. `feat/postgres-migration`) and merge that to main before continuing auth? Single branch is simpler if you trust the slices to land cleanly; split is safer if you want to ship Postgres independently. My recommendation: **single branch** — slice 0 (Postgres) finishes before slice A1, and the merge is a single PR.
6. **Did I parse "Google MCP can help me get the token" correctly in §7?** If you meant something different, tell me what.
7. **`docs/build-log.md` location:** should the build log get an entry for the auth-plan + this branch, even though no code has landed? My recommendation: yes, log decisions as they're made, not just code as it lands. Confirm.

---

## 11. What I will NOT do without your green light (unchanged)

- Pick scope on your behalf.
- Create the Google Cloud Console OAuth client for you (only you can do this, in step §8).
- Touch `client_secret` (we don't have one).
- Add Gmail readonly scope without explicitly asking — that's Option B and a separate decision.
- Build any cloud backend.
- Merge `feat/auth-gmail` to `main` without your review.
- Drop the existing `usage.db` SQLite file — preserve it for backup until you confirm import worked.

---

## 12. Resume sketch for the next session

```bash
# Day-of when you've answered §10:
cd /Volumes/Portal_SSD/pojo/llm-cost-monitor-auth

# Slice 0 (Postgres), then A1 (you do GCP), then A2-A6 (I implement)

# When ready to merge:
cd /Volumes/Portal_SSD/pojo/llm-cost-monitor
git merge feat/auth-gmail        # or open a PR via gh

# When done with the worktree:
git worktree remove ../llm-cost-monitor-auth
```

---

**Ready to discuss. Answer §10, especially Q1 (Postgres scope), Q5 (single branch), and Q6 (Google MCP intent), and I'll start slice 0.**
