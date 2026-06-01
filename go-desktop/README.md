# lcmbar — Go desktop daemon for `llm-cost-monitor`

A single-binary Go reimplementation of the menubar app: a tray-resident
background daemon that aggregates AI provider usage, plus a Cobra CLI that
talks to the daemon over a Unix socket. Built against the AIBar
architecture: centralised cache for "consistency story", trusted-host Bearer
attach, OIDC PKCE auth with JWKS-verified ID tokens, plugin SDK, telemetry,
auto-updater. Everything below works today — see the verification block at
the end for the round-trip you can paste verbatim.

```
cmd/lcmbar/        # GUI build entry point  (binary: lcmbar)
cmd/lcmbar-cli/    # CLI-only entry point   (binary: lcmbar-cli, -tags nogui)
internal/          # config, app, daemon, ipc, provider, auth, ui, plugin, ...
sdk/               # third-party plugin SDK (provider + extension contracts)
proto/             # gRPC contract for plugins (HashiCorp go-plugin)
tools/mockcache/   # central cache server used to demo consistency
```

## Build

```bash
make build      # bin/lcmbar      (full GUI build — Wails wiring lands in T8 follow-up)
make build-cli  # bin/lcmbar-cli  (CLI-only, no Wails, no React)
make test       # provider tests + auth session tests
make tidy       # go mod tidy
```

The CLI build (`-tags nogui`) is for headless servers and CI. Both binaries
expose the full daemon + IPC surface; only the `gui` subcommand differs.

## Filesystem layout

Everything goes under `~/.lcmbar/` (override with `LCMBAR_HOME`):

| Path                   | Purpose                              |
|------------------------|--------------------------------------|
| `config.yaml`          | User-editable Viper config           |
| `.env`                 | Optional dotenv loaded at boot       |
| `logs/lcmbar.log`      | slog JSON, rotation in T10 follow-up |
| `lcmbar.sock`          | Unix socket for IPC, mode 0600       |
| `lcmbar.pid`           | PID of the running daemon            |
| `lcmbar.lock`          | flock target — single-instance       |
| `jwks-cache.json`      | Persisted JWKS for offline boot      |
| `plugins/`             | Installed plugin binaries + manifests|

The daemon creates each directory with mode `0700` on first boot.

## Configuration

`~/.lcmbar/config.yaml` — every key is overridable via env (`LCMBAR_` prefix
with `.` → `_`). Example:

```yaml
app:
  refresh_interval_sec: 300        # auto-refresh ticker
  budget_warning_percent: 80       # fires when usage_percent crosses this
  auto_update_mode: notify-then-auto

providers:
  mockcache:                       # generic central-cache provider
    vendor: cursor
    display_name: Cursor (mock)
    endpoint: http://127.0.0.1:18080
  litellm:
    base_url: http://localhost:4000
    api_key: sk-…                  # virtual key from your LiteLLM proxy

budgets:
  cursor:
    limit_usd: 50
    period: monthly

auth:
  issuer: https://your-keycloak.example.com/realms/lcmbar
  client_id: lcmbar-pkce
  scopes: [openid, email, profile]
  redirect_port: 10001
```

Useful env knobs:

| Variable                 | Effect                                                                 |
|--------------------------|------------------------------------------------------------------------|
| `LCMBAR_HOME`            | Override `~/.lcmbar` (great for isolated test runs).                   |
| `LCMBAR_HEADLESS=1`      | Force in-memory token store (no OS keyring).                           |
| `LCMBAR_LOG_STDERR=1`    | Mirror logs to stderr in addition to the file.                         |
| `LCMBAR_DEBUG=1`         | Set slog level to DEBUG.                                               |
| `LCMBAR_TRUSTED_HOSTS`   | Comma-list (or `*`) of hosts allowed to receive the Bearer token.      |
| `LCMBAR_USER_EMAIL`      | Fallback email used when no PKCE session is loaded (E2E demos).        |
| `LCMBAR_USER_TOKEN`      | Fallback access token (E2E demos only — prefer real OIDC).             |
| `LCMBAR_MOCKCACHE_BIND`  | Bind addr for `tools/mockcache` (default `127.0.0.1:18080`).           |

## Daemon lifecycle

The daemon owns the IPC socket, the auto-refresh ticker, and the auth
session. Most CLI commands auto-start it; you only need explicit lifecycle
control for debugging.

```bash
lcmbar daemon start --foreground   # blocks; logs to stderr if LCMBAR_LOG_STDERR=1
lcmbar daemon start                # background (re-execs as detached)
lcmbar daemon status               # "alive" / "down"
lcmbar daemon stop                 # IPC quit → SIGTERM fallback
lcmbar daemon restart              # graceful, preserves session
```

Single-instance is enforced via `flock` on `~/.lcmbar/lcmbar.lock`. A second
`daemon start` against the same `LCMBAR_HOME` errors with the live PID.

## Provider status

```bash
lcmbar status                      # auto-starts the daemon if needed
lcmbar status --json               # JSON for scripts
lcmbar status --provider cursor    # one row
lcmbar refresh                     # refresh every configured provider
lcmbar refresh --provider cursor   # refresh one
```

The `Manager` runs one goroutine per provider, swallows individual failures
(returns an error only when *every* provider fails), and retains the last
good snapshot under `staleOnError=true` when a fetch errors.

## Configuration commands

```bash
lcmbar config path                            # ~/.lcmbar/config.yaml
lcmbar config get app.refresh_interval_sec    # 300
lcmbar config set app.refresh_interval_sec 60 # writes to disk
```

`set` coerces `true`/`false` and integers automatically; everything else
stays a string.

## Auth (OIDC PKCE)

```bash
lcmbar auth login    # opens system browser, completes PKCE
lcmbar auth status   # {authenticated, email, expires_at}
lcmbar auth logout   # clears session (keyring + memory)
```

Login spins a loopback listener on `auth.redirect_port` (or a random free
port if `0`), runs the Authorization Code + PKCE flow against `auth.issuer`,
verifies the returned ID token via JWKS, and persists the access/refresh/ID
tokens under the OS keyring (`zalando/go-keyring`). On `LCMBAR_HEADLESS=1`
the in-memory store is used instead.

Refresh is automatic: providers call back into the SessionManager via the
`TokenRefresher` registered at boot, so a 401 from any builtin transparently
triggers a refresh-and-retry. Plugins receive only `AuthSnapshot{Authenticated,
Email, ExpiresAt}` — the access token never leaves the daemon process.

## Mock cache & the consistency story

`tools/mockcache` is a tiny HTTP server with two endpoints:

```
GET  /api/v1/vendors/{vendor}/spend?user_email=…
POST /api/v1/admin/set    {"vendor":..., "email":..., "value":..., "threshold":...}
```

Run it under `make run-mockcache` (or `go run ./tools/mockcache`). It binds
`127.0.0.1:18080` by default.

Because every daemon reads from the *same* cache, two clients on two
machines see byte-identical `spendUsd` and `fetchedAt` — no peer-to-peer
sync. That's the architectural property the design depends on.

## End-to-end smoke test (paste verbatim)

```bash
# 1. Build
make build

# 2. Start the central mock cache
go run ./tools/mockcache &
sleep 1
curl -s http://127.0.0.1:18080/healthz   # {"ok":true}

# 3. Two daemons sharing the same backend
mkdir -p /tmp/lcmbar-{A,B}
for D in A B; do
  cat > /tmp/lcmbar-$D/config.yaml <<'YAML'
app: {refresh_interval_sec: 300, budget_warning_percent: 80}
providers:
  mockcache: {vendor: cursor, display_name: Cursor (mock), endpoint: http://127.0.0.1:18080}
budgets:
  cursor: {limit_usd: 50, period: monthly}
YAML
done

LCMBAR_HOME=/tmp/lcmbar-A LCMBAR_HEADLESS=1 LCMBAR_USER_EMAIL=alice@example.com \
  ./bin/lcmbar daemon start --foreground > /tmp/lcmbar-A.log 2>&1 &
LCMBAR_HOME=/tmp/lcmbar-B LCMBAR_HEADLESS=1 LCMBAR_USER_EMAIL=alice@example.com \
  ./bin/lcmbar daemon start --foreground > /tmp/lcmbar-B.log 2>&1 &
sleep 2

# 4. Push a value, refresh both, observe identical readings
curl -s -X POST http://127.0.0.1:18080/api/v1/admin/set \
  -H 'Content-Type: application/json' \
  -d '{"vendor":"cursor","email":"alice@example.com","value":42.5,"threshold":50}'

for D in A B; do
  LCMBAR_HOME=/tmp/lcmbar-$D LCMBAR_HEADLESS=1 LCMBAR_USER_EMAIL=alice@example.com \
    ./bin/lcmbar refresh
done
for D in A B; do
  echo "--- $D ---"
  LCMBAR_HOME=/tmp/lcmbar-$D LCMBAR_HEADLESS=1 LCMBAR_USER_EMAIL=alice@example.com \
    ./bin/lcmbar status --json
done
# Expected: identical spendUsd=42.5, identical fetchedAt, usagePercent=85.

# 5. Kill the cache, refresh again — last-good values are retained.
pkill -f tools/mockcache
LCMBAR_HOME=/tmp/lcmbar-A LCMBAR_HEADLESS=1 LCMBAR_USER_EMAIL=alice@example.com \
  ./bin/lcmbar status --json
# Look for: "staleOnError":true, error populated, spendUsd=42.5 retained.

# 6. Clean up
for D in A B; do
  LCMBAR_HOME=/tmp/lcmbar-$D LCMBAR_HEADLESS=1 ./bin/lcmbar daemon stop
done
```

## Plugins (T9, scaffold today)

Third-party plugins implement `sdk.ProviderPlugin` or `sdk.ExtensionPlugin`
in their own binary, then call `sdk.Serve(...)` (or `ServeExtension(...)`).
The contract is in `proto/provider.proto`. The daemon never hands access
tokens to plugins; instead it injects `sdk.AuthSnapshot` and (for outbound
HTTP) a `DaemonClient` that proxies authenticated requests through the
daemon.

`internal/plugin/` holds the host-side `Host` + `Registry` types. The gRPC
dispatch and HashiCorp go-plugin handshake (`MagicCookieKey="LCMBAR_PLUGIN"`)
land in the T9 follow-up; the type surface is stable.

## GUI (T8, scaffold today)

`internal/ui/services/` already exposes the full Wails-binding surface
(`DashboardService`, `SettingsService`, `AuthService`, `PluginService`,
`UpdateService`). The Wails 3 init + React frontend get added in the T8
follow-up; the Go bindings are ready for `wails3 generate bindings`.

`lcmbar gui` runs the GUI; `lcmbar-cli gui` returns a clear "not built with
GUI" error.

## Telemetry, logging, updater (T10, scaffold today)

| Package                  | Status                                                                  |
|--------------------------|-------------------------------------------------------------------------|
| `internal/logging`       | slog JSON to `~/.lcmbar/logs/lcmbar.log`. Lumberjack rotation: T10 follow-up. |
| `internal/telemetry`     | Fire-and-forget HTTPS POST. No-op when no endpoint configured.          |
| `internal/updater`       | `Check()` against a `latest.json` manifest. Atomic install: T10 follow-up. |

Privacy contract for telemetry: no PII beyond `telemetry_user_id` (UUID),
no tokens, no email addresses. `Track` always runs in a goroutine and never
blocks the caller.

## Testing

```bash
make test                       # full suite
go test ./internal/provider/... # manager / store / budget notifier
go test ./internal/auth/...     # session manager + skew window
```

`internal/provider/manager_test.go` covers parallel refresh, retry timing
(`SetRetryPolicy` with tiny delays), stale-on-error retention, silent skip
of `ErrNotConfigured`, and budget-notifier dedup.

## Status of the AIBar 10-task plan

| Task | Status | Notes |
|------|--------|-------|
| T1 — Project skeleton | done | Two binaries, Make/Taskfile-style targets. |
| T2 — Config + paths   | done | Viper, `LCMBAR_HOME`, dotenv. |
| T3 — Provider core    | done | Manager / Store / RetryPolicy / BudgetNotifier; tests pass. |
| T4 — Builtin providers + mock cache | done | Generic mock-cache + LiteLLM; mockcache server. |
| T5 — Daemon + IPC     | done | flock single-instance, Unix socket mode 0600, JSON framing. |
| T6 — Cobra CLI        | done | `daemon`, `status`, `refresh`, `auth`, `config`, `version`. |
| T7 — OIDC PKCE auth   | done | PKCE flow, JWKS cache, SessionManager, IPC handlers, builtin wiring. |
| T8 — Wails GUI        | scaffold | Service surface ready; React + Wails wiring is the follow-up. |
| T9 — Plugin system    | scaffold | Proto + SDK + Host/Registry types ready; gRPC dispatch is the follow-up. |
| T10 — Telemetry/logging/updater | scaffold | Types + entry points ready; lumberjack and atomic install are the follow-up. |
