# Desktop TS → Go migration plan

This is the planning doc for the *desktop-side* port of llm-cost-monitor.
The server-side port lives in `go-server/` and has its own milestones in
`go-server/TASKS.md`. This doc covers the Electron/TypeScript main process,
the renderer, and the bundling pipeline.

> **Status: planning only.** No Go desktop code exists yet. The TS desktop
> stays the production target until M3 (cutover). This doc captures the
> mapping so we can dispatch implementation work in parallelizable chunks.

## Why migrate at all

The TS main process is fine. The migration unlocks three things:

1. **Single-binary tray app.** Wails v3 produces a real native bundle
   without shipping a 100 MB Chromium runtime. The renderer stays React;
   only the host changes. This matches the AIBar reference architecture
   the original task plan was built against.
2. **Native filesystem watch + parser performance.** The Claude Code,
   Codex, and Gemini parsers tail JSONL logs that can grow into the
   hundreds of MB. Go reads + dedup runs ~3-5× faster than the Node
   stream + JSON.parse loop in profiling, and parsing is cold-path
   blocking on every refresh.
3. **Shared types with the server.** The Go server already owns
   `internal/sync/payload.go`. The desktop currently re-encodes the same
   shapes in `src/shared/sync.ts`. After migration there is one
   authoritative type definition.

The migration is **not** worth doing for cosmetic reasons. If steps below
turn out painful (the keyring story is the biggest risk — see §4), we
stop and the TS desktop continues shipping.

## Module-by-module mapping

| TS module                                     | Go destination                                       | Hard parts |
| --------------------------------------------- | ---------------------------------------------------- | ---------- |
| `src/main/index.ts`                           | `cmd/desktop/main.go`                                | Wails app lifecycle vs Electron `app.whenReady`; tray icon templating differs across darwin/linux |
| `src/main/ipc.ts`                             | `internal/ui/services/*.go` (Wails Service exports)  | IPC channel names → Wails method names; preserve renderer contract via codegen |
| `src/main/parsers/{claude,codex,gemini}.ts`   | `internal/parsers/{claude,codex,gemini}.go`          | JSONL streaming + dedup-by-message-id (Claude keeps LAST entry for streaming chunks — see masorange research note); both `cache_creation` shapes |
| `src/main/pricing/`                           | `internal/pricing/`                                  | Vendored LiteLLM JSON loader; keep `resources/pricing.json` shared between binaries |
| `src/main/storage/event-repository.ts`        | `internal/storage/event_repository.go`               | Postgres UPSERT + `sync_outbox` transactional write (already wired in TS) |
| `src/main/storage/migrations.ts`              | `internal/storage/migrations.go`                     | Reuse the loop already implemented in `go-server/internal/db/pool.go` |
| `src/main/sync/sync-queue.ts`                 | `internal/sync/queue.go`                             | Outbox watermark advance is a tight loop — same SQL the TS version emits |
| `src/main/sync/outbox-repository.ts`          | `internal/sync/outbox.go`                            | Joined query mapping rebuilds `Event` from `usage_events` row |
| `src/main/sync/redaction.ts`                  | `internal/sync/redaction.go`                         | Three privacy levels; `aggregateOnly` rolls the day bucket on the client |
| `src/main/sync/transport.ts`                  | `internal/sync/transport.go`                         | HTTP client; reuse desktop session as Bearer; same JSON shape as `go-server/internal/sync` |
| `src/main/auth/google-oauth.ts`               | `internal/auth/oauth.go`                             | RFC 8252 loopback PKCE flow; `oauth2/v2` is fine in Go |
| `src/main/auth/id-token-verify.go` (was `.ts`)| `internal/auth/idtoken.go`                           | Reuse jwx like `go-server/internal/auth` |
| `src/main/auth/keychain-store.ts`             | `internal/auth/keyring.go`                           | **Hardest piece.** Electron's `safeStorage` uses Keychain (macOS) / libsecret (linux). In Go we'd use `github.com/zalando/go-keyring`; encryption-at-rest properties match but the migration story for *existing installs* needs care — we cannot read tokens written by `safeStorage` from Go (different KDF). Plan: on first Go-binary launch, drop the existing token, prompt re-login. See §4. |
| `src/main/auth/loopback-server.ts`            | `internal/auth/loopback.go`                          | `net.Listen` on 127.0.0.1; same redirect-URI contract the IdP expects |
| `src/main/providers/`                         | `internal/providers/`                                | Pure functions over parser output; trivial port |
| `src/main/aggregation/`                       | `internal/aggregation/`                              | UTC day bucketing; integer micro-USD; same arithmetic as TS |
| `src/main/watch/`                             | `internal/watch/`                                    | `chokidar` → `fsnotify`. `chokidar` has macOS-FSEvents-specific debouncing that fsnotify lacks. Need a thin debounce wrapper. |
| `src/renderer/`                               | unchanged                                             | Stays React + Vite. Wails v3 binds Go services into the renderer same way Electron exposes preload IPC. The renderer ships unchanged in M2; we only swap the host. |
| `src/shared/`                                 | `internal/shared/` + `internal/sync/`                | Wire types are duplicated today; after migration the Go type is canonical and TS regenerates from it (or we hand-maintain both during transition) |
| `src/main/web-api/`                           | `internal/webapi/`                                   | Tiny localhost JSON API; trivial port |
| `src/main/alerts/`                            | `internal/alerts/`                                   | Notification dispatch via Wails or `github.com/martinlindhe/notify` |
| `src/main/git/`                               | `internal/git/`                                      | Calls `git rev-parse` / `git config` — already shells out, port is mechanical |
| `src/main/settings/`                          | `internal/settings/`                                 | Viper-backed; same `~/.llm-cost-monitor/` directory layout |
| `bin/llm-cost-monitor` (statusline CLI)       | `cmd/statusline/main.go`                             | Cobra CLI subcommand of the same binary; ships under `~/.claude/statusline/` |

## Phased delivery

### M0 — Build system + skeleton

- [ ] `go.mod` rooted at repo root scope `github.com/yimin12/llm-cost-monitor/go-desktop`.
      Reuse the same module path you've adopted in `go-server` so internal
      cross-package imports work.
- [ ] `cmd/desktop/main.go` boots Wails v3 with an empty window. Tray icon
      stub, no real services wired yet.
- [ ] `Taskfile.yml` add `task desktop:build` / `task desktop:dev` per the
      existing layout in this repo's research notes (the AIBar reference
      template).
- [ ] Renderer stays at `frontend/` (or `src/renderer/` — pick one;
      Wails defaults to `frontend/`). Vite + React + Tailwind unchanged.

### M1 — Parsers + pricing + storage (read-only path)

This milestone lets the Go binary *read* events the TS binary previously
wrote. No new writes, no sync, no auth — pure tail-and-display.

- [ ] Port parsers under `internal/parsers/`. Same JSONL streaming +
      dedup invariants. Conformance test: parse the same fixtures the TS
      `__tests__` use; output bytes must match.
- [ ] Port `pricing/`. Loader reads `resources/pricing.json` (shared with
      TS desktop; the file is already vendored).
- [ ] Port `storage/event_repository.go` (read-only methods first;
      writes follow in M2). Reuse `go-server/internal/db.Open` for the
      pool; same DSN env (`LCM_DATABASE_URL`).
- [ ] Wails service `DashboardService.GetTotalSpend()` returns the same
      `TotalSpendResponse` shape as the TS IPC equivalent.
- [ ] Renderer reads via Wails bindings; no changes to React components.

### M2 — Auth, sync, writes

This is where the keyring migration story lands.

- [ ] Port `auth/` with `oauth.go`, `idtoken.go`, `loopback.go`,
      `keyring.go`. **First-run logic in `keyring.go`**: detect a stale
      token written by Electron `safeStorage` (we can probe the keychain
      service name; it differs by `electron.safeStorage` adding a
      `[Electron]` suffix on macOS), drop it, prompt re-login.
- [ ] Port `storage/migrations.go`. Reuse the runner already in
      `go-server/internal/db/pool.go` — copy or extract into a small
      shared package (`internal/dbmig`) imported by both binaries.
- [ ] Port `sync/outbox.go`, `sync/queue.go`, `sync/transport.go`,
      `sync/redaction.go`. Same shape as the TS implementation; the Go
      server expects identical wire messages, so the conformance test is
      "TS sync-queue.test.ts fixtures replayed through Go produce the
      same `BatchUpsertRequest` body bytes".
- [ ] Wire writes through `event_repository.go.Upsert` so Claude/Codex/
      Gemini logs land in Postgres from the Go binary too.

### M3 — UI + tray + cutover

- [ ] Port `ipc.ts` channels to Wails methods on dedicated services
      (`DashboardService`, `SettingsService`, `AuthService`, `SyncService`).
      Renderer's `window.api.*` calls switch to `runtime.Call` via
      Wails-generated bindings.
- [ ] Port `tray-icons.ts`. macOS template image, linux AppIndicator.
- [ ] Port `statusline-export.ts` to `cmd/statusline/main.go`. Cobra
      subcommand of the desktop binary; `--statusline` flag picks the
      mode at startup.
- [ ] Replace `electron-builder` with the Wails packaging pipeline.
      `.app` (macOS), `.deb` + `.AppImage` (linux). Reuse current icon
      assets under `resources/icons/`.
- [ ] Auto-update: drop `electron-updater`. Use the existing GitHub
      Releases feed; replace the updater client with a small Go
      equivalent that diffs versions and atomically swaps the binary.
- [ ] Cutover: ship one Go release alongside one TS release; run both
      in shadow for one cycle; if telemetry agrees, deprecate the TS
      build.

## Hard parts in detail

### 1. Wails-vs-CLI-only build split

The current TS codebase has no CLI build — `bin/llm-cost-monitor` is a
node script that talks to the running tray app. The Go port should mirror
the AIBar build-tag pattern:

- `main.go` (default tag) → Wails GUI app
- `cmd/desktop/main.go -tags nogui` → headless daemon (no Wails import)
- `cmd/statusline/main.go` → tiny CLI that reads the same Postgres DB
  directly (no IPC, no daemon dependency)

The reason: Wails pulls a Webkit/Chromium binding at link time, which
inflates binary size and breaks `go install` on servers. The `nogui` tag
keeps the headless surface lean.

### 2. fsnotify vs chokidar debouncing

`chokidar` collapses bursts of FSEvents on macOS into a single change
event with a configurable polling fallback. `fsnotify` does not. Without
debouncing, the Claude Code parser will re-read the same JSONL three
times per session save, defeating the parser-side mtime cache.

Mitigation: implement a ~250 ms trailing-debounce per path inside
`internal/watch/`. Same constant the chokidar config uses today
(`awaitWriteFinish: { stabilityThreshold: 250 }`).

### 3. Keyring migration

Electron's `safeStorage` writes to the Keychain (macOS) under the service
name `<bundle-id>` with a generic-password class. `go-keyring` writes
under the same class but cannot decrypt entries Electron sealed because
Electron's wrapper adds a per-key derivation step that's not exposed via
Apple APIs.

We **cannot transparently migrate the existing token**. Plan:

1. On first Go-binary launch, the keyring entry from the TS install is
   ignored (the user is treated as logged out).
2. The renderer shows a one-time "We've upgraded — please sign in again"
   banner with the existing Sign-in-with-Google flow.
3. The new token is written to the same keyring service name. From then
   on, both binaries can read it (the TS binary stays compatible until
   we cut over).

### 4. electron-builder vs Wails packaging

`electron-builder` produces signed/notarized `.dmg` and `.deb` artifacts
with a `latest-mac.yml` / `latest-linux.yml` feed for `electron-updater`.
Wails v3 has its own packaging task with similar capabilities (`task
package`, `task notarize`). The migration is a one-time CI workflow swap;
no logic changes.

The risky bit is the auto-update feed. `electron-updater` and the Wails
updater write incompatible feed shapes. During cutover (M3) we'll publish
*both* feeds from the same release so users on the TS build still get
TS updates and users on the Go build see Go updates. After two stable
releases on Go we delete the TS feed.

### 5. Shared types between Go server, Go desktop, TS renderer

After M3:

- Go server and Go desktop import `internal/sync/payload.go` directly.
- The renderer (still TS) imports types from a generated
  `frontend/bindings/payload.ts` produced by Wails' codegen. Same
  contract, regenerated on every build.

During M0–M2 the TS shared types in `src/shared/sync.ts` stay the
authoritative copy. Once the renderer is talking to Wails bindings (M3),
we delete `src/shared/sync.ts` and let the bindings generator own it.

## Out of scope

- Replacing the renderer with a Go-native UI (Fyne, Gio, etc.). The
  React + Tailwind UI is fine; Wails just changes the host.
- Cross-compiling to Windows. Current desktop is macOS + linux only;
  windows is a separate ask.
- Reintroducing SQLite. Closed by `docs/storage-decision.md`.
- Writing a Go statusline before M3. The current node-based statusline
  works; rewriting earlier means dual-maintaining for no user benefit.

## Open questions

- Wails v3 is still beta as of 2026-05; v2 is stable. Do we tolerate v3
  pre-release risk for the better service-binding ergonomics, or stay on
  v2?
- Do we ship one binary that includes both desktop + statusline (toggled
  via subcommand), or two binaries side-by-side? AIBar ships one; the
  precedent is good but the binary is ~30 MB even stripped, which makes
  the statusline hot-path heavier than the current node script.
- Can we delete `better-sqlite3` after M3? The Cursor IDE token reader
  is the only remaining caller (see `docs/storage-decision.md`). If we
  don't port that path, yes.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Keyring re-login annoys existing users | High | Medium | One-time banner; cluster releases so the prompt only fires once |
| fsnotify burst handling regressions | Medium | High | Conformance tests over recorded FSEvents traces from the TS suite |
| Wails v3 beta blocks ship | Medium | High | Ship M0 on v2; reassess at M2 |
| Auto-updater feed split breaks rollback | Low | High | Publish dual feeds for two releases minimum |
| Go binary size kills statusline cold start | Low | Medium | Use `nogui` build tag for the statusline subcommand to drop Wails |

## Decision log

- **2026-05-31**: Plan written. Confirmed Postgres-only storage stance
  carries over (`docs/storage-decision.md`). Confirmed renderer stays
  React. Confirmed phased delivery (M0–M3) over big-bang.
