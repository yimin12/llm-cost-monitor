# Architecture decision record

**Status (revised 2026-05-05).** The cross-platform pivot retired the SwiftUI plan in favor of **Electron + macOS/Linux**. The cross-cutting decisions (parser rules, provider identity, pricing strategy, schema) all survive untouched — they're algorithmic, not framework-specific. Only the runtime and packaging change. The original SwiftUI scaffold is archived under [`../legacy-swift/`](../legacy-swift/) for reference.

**Audience.** Future me, contributors, anyone reviewing why this app is shaped the way it is.

---

## D1. Form factor — Electron tray app, macOS + Linux

**Decision (revised).** Electron app with `Tray` integration on both platforms. macOS gets a NSStatusItem-style menubar entry; Linux gets a system tray icon (works on KDE / XFCE / Cinnamon natively; on GNOME requires the `AppIndicator` extension, which we'll document). Single TypeScript codebase, two installers (`.dmg`, `.deb` + `.AppImage`).

**Why the pivot from SwiftUI.** User wants Linux support. SwiftUI doesn't ship on Linux; even Swift-on-Linux needs a separate UI stack. Electron is heavy (~150 MB binary, ~250 MB RAM idle) but pays that tax once for "one codebase, two platforms."

**Why not Tauri / Wails / native Go+systray.** Tauri (Rust + system webview) is genuinely lighter and was the runner-up. We pick Electron because (a) the user has an `eletron-pro` subagent that codifies their conventions for Electron projects, (b) `better-sqlite3` + `chokidar` + Node streams are exactly the right primitives for our pipeline (JSONL files → DB), and (c) Linux tray on Electron is well-trodden, while Tauri's tray story varies by distro.

**Why not the macOS App Store / Linux Snap-only / Windows v1.** App Store sandboxing blocks reading `~/.claude/` without user-gesture pickers. Snap-only excludes RHEL/Arch users. Windows is Phase-4 stretch (mostly comes for free; needs Named-Pipes for the hook receiver instead of Unix sockets).

**Consequences.** ~150 MB binary per platform. Acceptable in 2026.

---

## D2. Module layout (revised)

```
src/
├── main/                    # Electron main process (Node) — NO renderer-only deps here
│   ├── providers/           # One folder per provider; each exports an AIProvider impl
│   │   ├── anthropic/       # Claude Code JSONL + Anthropic Console API + hook receiver
│   │   ├── openai/          # Codex sessions
│   │   ├── google/          # Gemini CLI / sessions
│   │   ├── moonshot/        # Kimi CLIQuotaProbe
│   │   └── alibaba/         # Qwen
│   ├── parsers/             # Generic JSONL streamer; per-provider row decoders
│   ├── pricing/             # PricingTable loader (loads resources/pricing.json once)
│   ├── storage/             # better-sqlite3 repo, migrations, mtime cache
│   ├── watch/               # chokidar tail + Unix-domain socket hook receiver
│   ├── ipc.ts               # contextBridge channel handlers
│   └── tray.ts              # Tray icon, menu, app lifecycle
├── preload/                 # Tiny — only typed contextBridge
├── renderer/                # Web UI (React)
│   ├── components/          # Dropdown, today/7d/30d cards, "Now" panel, top-N tables
│   ├── hooks/               # useUsage(), useActiveSession()
│   └── App.tsx
├── shared/                  # Types reused by main + renderer
│   ├── usage-event.ts       # canonical row shape (D6)
│   ├── provider-identity.ts # canonicalization (D4)
│   ├── snapshot.ts          # UsageSnapshot, UsageQuota, etc.
│   └── ipc-channels.ts      # exhaustive channel name enum
└── bin/
    └── statusline.ts        # tiny CLI that reads <app data>/statusline.json
```

**Why this split.**
- `main/` does all I/O. Renderer never touches the filesystem or spawns processes — that path goes through `contextBridge`.
- `shared/` is import-safe from both processes. No `electron`, no `fs`, no `node:` modules in here.
- Per-provider folders mirror ClaudeBar's `Infrastructure/<Provider>/` layout — adding a new provider stays one-folder-per-provider.

**Why not.** Mixing renderer/main code is the most common Electron security mistake. We use `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on the renderer. All file access goes through typed IPC handlers in `main/ipc.ts`.

---

## D3. Provider abstraction — TypeScript port of ClaudeBar's protocol

**Decision (unchanged shape, ported to TS).** Two interfaces in `src/shared/snapshot.ts`:

```ts
export interface AIProvider {
  /** Canonical id: "anthropic", "openai", "google", "moonshotai", … */
  readonly id: string
  readonly name: string
  readonly cliCommand: string | null
  readonly dashboardUrl: string | null
  isEnabled: boolean

  /** Latest snapshot, null before first refresh. Observed via IPC events. */
  snapshot(): UsageSnapshot | null
  isAvailable(): Promise<boolean>
  refresh(): Promise<UsageSnapshot>
}

export interface UsageProbe {
  probe(): Promise<UsageSnapshot>
  isAvailable(): Promise<boolean>
}
```

A provider composes 1+ probes: `LocalSessionProbe` (JSONL/JSON), `CLIQuotaProbe` (spawn vendor CLI, parse output), `ApiProbe` (vendor billing endpoints). All probes live in `main/providers/<vendor>/probes/`.

**Concurrency.** Probes are `async`. The provider holds a single in-flight refresh promise so concurrent IPC calls fold to one request (`promise-coalescing`).

**Why unchanged from Swift port.** The shape is sound; only the language differs.

---

## D4. Provider identity canonicalization (port from tokscale, then to TS)

**Decision.** `src/shared/provider-identity.ts` exports:

```ts
export function canonicalSegment(segment: string): string | null
export function canonical(raw: string): string | null
export function tags(raw: string): string[]
export function inferred(fromModel: string): string | null
```

Same allowlist + digit-bearing rejection as tokscale's `provider_identity.rs` (and the working Swift port at `legacy-swift/.../ProviderIdentity.swift`). Same negative regression cases must hold:
- `protocol1-fast` does NOT match `o1`
- `metadata-model` does NOT match `meta`
- `metamorphic-v1` does NOT match `meta`
- `gpt-4` is NOT a canonical provider segment
- `vertex_ai` collapses to `anthropic`

Tests live in `src/shared/__tests__/provider-identity.test.ts` (Vitest).

**Why.** Same reasoning as D4 in the SwiftUI version: store `provider` (canonical) and `providerRawTag` (raw) on every `UsageEvent` so re-canonicalization stays local and never requires re-scanning JSONL.

---

## D5. Pricing — vendored LiteLLM JSON, refreshed in CI (unchanged strategy)

**Decision.**
- Ship `resources/pricing.json` = snapshot of [`BerriAI/litellm` `model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) (path is at the repo *root*, not `litellm/`). Latest snapshot loaded into `legacy-swift/.../Resources/pricing.json` is **2,250 models**, ~1.4 MB; eletron-pro should move it to `resources/pricing.json` in the new tree.
- `Scripts/refresh-pricing.sh` is already on disk and works against the correct URL. GitHub Action runs it nightly, opens a PR if changed.
- Loader: `main/pricing/PricingTable.ts` parses once at app startup, caches in memory. Renderer never touches the file directly — costs are computed in main during parse.
- Look-up chain: exact (case-insensitive) → provider-prefixed (`anthropic/<model>`, etc.) → prefix substring → keyword fallback (`opus|sonnet|haiku|gpt|gemini|kimi|qwen|deepseek|glm|grok|mistral|mixtral|llama|o1|o3|o4`) → conservative Sonnet-equivalent default.
- **Math precision.** Cost is stored as **integer micro-USD** (1 USD = 1,000,000) to avoid floating-point drift. JS doesn't have `Decimal` natively; using `BigInt` for arithmetic and converting to `number` only at the display boundary keeps every penny exact.

**Why unchanged.** The SwiftUI version proved the snapshot loads end-to-end (`pricing snapshot 246413ab150e, 2250 models loaded`). The TS port should produce the same `snapshotVersion` for the same bytes.

---

## D6. UsageEvent schema (unchanged, ported to TS)

```ts
export interface UsageEvent {
  id: string                        // sha256(provider|sessionId|messageId|timestamp).slice(0, 24)
  provider: string                  // canonical
  providerRawTag?: string           // unmodified source tag
  model: string                     // raw, e.g. "claude-sonnet-4-5-20250929"
  timestamp: number                 // Unix epoch ms (NOT seconds — JS friendlier)
  project?: string                  // simplified project name
  projectRawSlug?: string           // original slug
  sessionId?: string
  messageId?: string                // dedup key
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreation5mTokens: number
  cacheCreation1hTokens: number
  reasoningTokens?: number
  toolCallCount?: number
  latencyMs?: number
  computedCostMicroUsd: bigint      // integer micro-USD (1 USD = 1_000_000)
  pricingSnapshotVersion: string    // SHA prefix of resources/pricing.json
  sourceFile: string
  sourceLineOffset: number
}
```

Identical to the Swift schema except `Decimal` → `bigint` micro-USD and `Date` → `number` (epoch ms). The table column types for SQLite are integer for everything except text fields and the cost.

---

## D7. JSONL parser rules (unchanged algorithm)

`src/main/parsers/claude-code.ts`:

1. **Discovery.** Glob `<CLAUDE_CONFIG_DIR ?? ~/.claude>/projects/<slug>/*.jsonl`. Tilde-expand. Empty env values treated as unset.
2. **Per-file mtime cache.** Consult SQLite `files` table; skip files whose mtime hasn't changed since `last_parsed_at`.
3. **Streaming.** Use `readline` over a `fs.createReadStream` — never `fs.readFileSync` on a session JSONL (some are 100s of MB after long Claude Code sessions).
4. **Per-line `try { JSON.parse(line) } catch { continue }`** — Claude Code writes JSONL incrementally; partial lines happen.
5. **Filter.** Keep entries with `message.usage` present (broader than ClaudeBar's `type === 'assistant'`-only rule; matches masorange's behavior).
6. **Dedup.** Within a file, group by `message.id`; keep the **last** entry per id (later streaming chunks have more complete usage).
7. **Cache-creation normalization.**
   - If `usage.cache_creation_input_tokens` (old) is non-zero → assign all to `cacheCreation5mTokens`, leave 1h at 0.
   - Else read `usage.cache_creation.ephemeral_5m_input_tokens` and `…ephemeral_1h_input_tokens`.
8. **Provider tag.** Read `model` from outer or `message.model`; run through `canonical(...)` for the canonical id.
9. **Project name.** Strip masorange-style slug (port `simplifyProjectName`).
10. **Output.** `UsageEvent[]` plus a `(filepath, mtime, last_parsed_at, last_offset)` cache update.

Codex / Gemini parsers follow the same shape with different field-extraction in step 5.

---

## D8. Live-session tracking (unchanged two-tier strategy)

1. **Primary — Claude Code hooks API.** `main/watch/hook-server.ts` listens on a Unix-domain socket at `<app data>/hooks.sock`. The user adds a small POST-script (we ship it under `bin/`) to `~/.claude/settings.json` `hooks` array. Events: `sessionStart`, `sessionEnd`, `taskCompleted`, `subagentStart`, `subagentStop`, `stop`. Drives an in-memory `activeSession` state.
2. **Fallback — `chokidar` tail.** Watches `~/.claude/projects/**/*.jsonl`. On change, parse new lines (track byte offset in the `files` table). Same parser, just streamed.

For "current model + context %": use the last assistant `usage`, sum `(input + cache_read + cache_creation*)` ÷ pricing-table `context_window`.

**Why unchanged.** Same logic; Node implementation:
- Unix-domain socket: `net.createServer({ allowHalfOpen: true })` — same code path on macOS and Linux.
- File watching: `chokidar` (cross-platform; uses FSEvents on macOS, inotify on Linux).
- `DispatchSourceFileSystemObject` / Swift APIs gone with the Swift code.

---

## D9. Storage — Postgres in dev, better-sqlite3 in shipped builds (revised 2026-05-07)

**Decision (revised again on `feat/auth-gmail`).** Dev runs **PostgreSQL 17 in Docker** (bound to `127.0.0.1:5433`, container `llm-cost-monitor-postgres`). Shipped builds (`.dmg` / `.AppImage`) keep **better-sqlite3** so end users don't need Docker. Both back ends share the same logical schema (events / files / pricing_overrides / schema_version) and the same `EventRepository` API surface — async on Postgres, async-wrapped sync on SQLite. See [`docs/auth-plan.md`](./auth-plan.md) §3 for the full reasoning.

**The Postgres-flavored DDL** (canonical now; the SQLite version becomes a parallel implementation when the shipped path lands):

See [`migrations/0001_init.sql`](../migrations/0001_init.sql) for the canonical Postgres DDL. Differences from the legacy SQLite version: `INTEGER` → `BIGINT` everywhere we store epoch-ms or 64-bit counters; `INSERT … VALUES (1) ON CONFLICT (version) DO NOTHING` for idempotent re-runs; PG-flavored `CREATE TABLE IF NOT EXISTS` syntax.

**Why `pg` (node-postgres).** Mature, every codebase uses it, has built-in pool. We override the BIGINT type-parser (`pg.types.setTypeParser(20, BigInt)`) so JS bigint flows through unchanged. SUM(BIGINT) returns NUMERIC by default, so all aggregates explicitly `::bigint` cast — see `src/main/aggregation/aggregator.ts`.

**Why keep `better-sqlite3` for shipped builds.** Distributing Postgres-in-Docker as a runtime dep would make the `.dmg` / `.AppImage` workflow miserable. SQLite preserves the "just runs" property. A backend-selection layer (interface + factory based on `process.env.NODE_ENV` or `app.isPackaged`) is the next storage slice; for now, `feat/auth-gmail` is dev-only.

**Why not Prisma / Drizzle / Knex.** ORMs are friction for a 4-table schema with stable, simple queries. Plain SQL with a tiny `@name → $N` named-param translator (`src/main/storage/db-utils.ts`) keeps the SQL readable and the runtime debuggable.

---

## D10. Path conventions (extended for Linux)

| Setting | macOS | Linux | Override env |
|---|---|---|---|
| Claude logs | `~/.claude/projects/**/*.jsonl` | `~/.claude/projects/**/*.jsonl` (Anthropic uses `~/.claude/` on both) | `CLAUDE_CONFIG_DIR` |
| Codex logs | `~/.codex/**` | `~/.codex/**` | `CODEX_HOME` |
| Gemini logs | `~/.gemini/**` | `~/.gemini/**` | `GEMINI_HOME` (assumed) |
| App data (DB, cache) | `~/Library/Application Support/llm-cost-monitor/` | `${XDG_DATA_HOME:-~/.local/share}/llm-cost-monitor/` | `LLM_COST_MONITOR_HOME` |
| App config | (same as data) | `${XDG_CONFIG_HOME:-~/.config}/llm-cost-monitor/` | (same env) |
| SQLite | `<app data>/usage.db` | `<app data>/usage.db` | (same env) |
| Statusline file | `<app data>/statusline.json` | `<app data>/statusline.json` | (same env) |
| Hook socket | `<app data>/hooks.sock` | `<app data>/hooks.sock` | (same env) |

Use Electron's `app.getPath('userData')` for the app-data root — it returns the right place on each platform automatically. Empty env values treated as unset (tokscale defensive idiom).

**Linux tray gotcha.** GNOME removed system-tray support; users on GNOME need the [`AppIndicator and KStatusNotifierItem Support`](https://extensions.gnome.org/extension/615/appindicator-support/) extension. Document in the README. KDE Plasma, XFCE, Cinnamon, MATE, LXQt all work natively.

---

## D11. UI — same wireframe, web-rendered (revised)

Tray icon: PNG/template image; on macOS use `nativeImage.setTemplateImage(true)` so it adapts to dark/light mode.

**Tray title (default).** `$3.14` (today's cost). When an active session is detected: `$3.14  62%`. Set via `tray.setTitle(...)` on macOS; on Linux, use `tray.setToolTip(...)` since most tray implementations don't render text next to the icon.

**Dropdown.** Implemented as a `BrowserWindow` (frameless, transparent, `alwaysOnTop`) anchored to the tray icon. Positioning helper handles macOS menubar coords vs Linux tray coords. UI sections:
1. **Today / 7d / 30d** cost cards.
2. **Active session** (only if hooks/tail report one).
3. **Top models** (3 rows, today).
4. **Top projects** (3 rows, today).
5. **Per-provider** (1 row per enabled provider).
6. **Footer:** refresh / settings / quit.

**Renderer stack.** React + Vite (via `electron-vite`). Tailwind for styling. `chart.js` for the eventual sparkline (Phase 4). No state-management library; Zustand if we need it later.

**Settings window.** Separate `BrowserWindow`. Configures provider toggles, pricing overrides, custom paths.

---

## D12. Statusline integration (architected now, ship v0.2)

Same architecture as the SwiftUI plan. `bin/statusline.ts` compiled to a tiny standalone CLI via `pkg` or shipped as `node bin/statusline.js`. Reads `<app data>/statusline.json` (atomically written by main process every few seconds during an active session) and prints one line.

Schema (v1):
```json
{
  "version": 1,
  "today_usd": 3.1415,
  "session_usd": 0.27,
  "model": "claude-sonnet-4-5",
  "context_used": 52319,
  "context_window": 200000,
  "captured_at": "2026-05-05T19:30:00Z"
}
```

Users add to `~/.claude/settings.json`:
```json
{ "statusLine": { "type": "command", "command": "/path/to/llm-cost-monitor-statusline" } }
```

---

## D13. Updates + distribution (revised)

- **Updates.** [`electron-updater`](https://www.electron.build/auto-update) with GitHub Releases as the update channel. Same UX as Sparkle on macOS; works on Linux too (`.AppImage` self-update, `.deb` notify-only).
- **Code signing.**
  - macOS: Developer ID + notarization ($99/yr Apple Developer account).
  - Linux: GPG-sign the `.deb` and `.AppImage`'s update channel; AppImage doesn't need a signing identity to run.
- **Distribution outputs from `electron-builder`:**
  - macOS: `.dmg` (Intel + arm64 universal binary).
  - Linux: `.deb` (Debian/Ubuntu/derivatives) + `.AppImage` (universal).
  - GitHub Release attaches all of the above.
- **Tap / repos:**
  - **Homebrew Cask** for macOS: `brew install --cask <owner>/tap/llm-cost-monitor`.
  - **AUR** package for Arch (stretch).
  - **Snap / Flatpak** as Phase-4 stretch — both add ~1 day of packaging work.
- **No App Store. No Snap-only. No Windows v1.**

---

## D14. License + privacy (revised 2026-05-08 for Sign in with Google)

- **License:** MIT.
- **Telemetry:** none. No analytics SDKs. No crash reporters that phone home. Opt-in error reporting opens GitHub Issues only.
- **Data location:** all on the user's machine. Postgres (dev) and SQLite (shipped) both bind to localhost; encrypted refresh token in OS Keychain via `safeStorage`.
- **Network calls actually made:**
  - (a) `electron-updater` update check (configurable, future slice 15)
  - (b) **OAuth round-trips with Google when the user explicitly signs in** — `accounts.google.com/o/oauth2/v2/auth`, `oauth2.googleapis.com/token`, `www.googleapis.com/oauth2/v3/certs`. The `id_token` is verified locally; the `refresh_token` is encrypted via `safeStorage` and used to silently mint a new `access_token` on each launch. **No usage data is uploaded.**
  - (c) optional vendor API calls when the user pastes an API key for a provider (none yet implemented)
- **Pricing JSON:** vendored, no remote fetch at runtime.
- **Privacy doc:** [`docs/privacy.md`](./privacy.md) is the single source of truth for the trust statement, mirroring CLI Pulse §10's structure.

---

## D15. Build sequence (revised for Electron)

| # | Slice | Done when |
|---|---|---|
| 1 | `eletron-pro` subagent scaffolds: `package.json`, `electron-vite.config.ts`, `tsconfig.json`, `src/{main,preload,renderer,shared}/` with a "hello tray" main + an empty React renderer + IPC plumbing | `npm run dev` opens a tray icon and shows an empty dropdown |
| 2 | Port `provider-identity.ts` from `legacy-swift/.../ProviderIdentity.swift` + Vitest regression suite | All test cases including `protocol1-fast` / `metadata-model` / `metamorphic-v1` pass |
| 3 | Define `usage-event.ts`, `snapshot.ts`, `provider.ts` in `src/shared/` | TypeScript strict mode passes |
| 4 | Move `legacy-swift/Sources/LLMCostMonitor/Resources/pricing.json` → `resources/pricing.json`; update `Scripts/refresh-pricing.sh` path. Implement `main/pricing/PricingTable.ts` (load + lookup + cost) | Vitest cost test against Sonnet 3.5 sample matches expected |
| 5 | `main/storage/db.ts` opens better-sqlite3 at `app.getPath('userData')/usage.db` with schema v1 + migrations runner | Round-trip insert/select test passes |
| 6 | `main/parsers/claude-code.ts` with masorange-grade dedup + new cache_creation format + skip-bad-lines | Property test against synthetic JSONL fixtures, plus a one-shot scan of the user's real `~/.claude/projects/` produces non-empty output |
| 7 | `main/providers/anthropic/index.ts` (LocalSessionProbe → DB upsert → emit IPC `usage:updated` event) | Refresh button in dropdown shows real numbers |
| 8 | `main/aggregation/aggregator.ts` (today / 7d / 30d / top models / top projects via SQL `GROUP BY`) | Aggregates match `tokscale today` against same data within $0.01 (or within fallback-pricing tolerance) |
| 9 | Tray title + dropdown UI at the wireframe in D11 | Visible, clickable, shows real numbers; cross-checked on Linux KDE + macOS |
| 10 | `main/watch/hook-server.ts` Unix-socket receiver + bundled `bin/claude-hook.sh` POST script | Live session card ticks while a Claude Code session runs |
| 11 | `main/watch/jsonl-tailer.ts` (chokidar fallback) | Same as 10 with hooks disabled |
| 12 | `main/providers/openai/index.ts` (Codex sessions, `~/.codex/`) | Codex usage shows up |
| 13 | `main/providers/moonshot/cli-quota-probe.ts` (spawn `kimi`, regex-parse `/usage`) | If `kimi` is on PATH, weekly/5h quotas appear |
| 14 | `bin/statusline.ts` + atomic `<app data>/statusline.json` writer in main | `cat <app data>/statusline.json && /path/to/statusline` print live numbers |
| 15 | `electron-builder` config + `electron-updater` wiring + `Scripts/refresh-pricing.sh` GitHub Action | `npm run dist` produces signed `.dmg`, `.deb`, `.AppImage` artifacts |
| 16 | README + Homebrew Cask formula + Linux install instructions | `brew install --cask` works; `.AppImage` runs on a clean Ubuntu VM |

Stretch (v0.2+): Gemini, Qwen, DeepSeek-via-Cursor, GLM/Zai. Charts. Budget alerts. CSV export. AUR. Windows.

---

## What changed from the SwiftUI version of this doc

- **D1, D2, D9, D10, D11, D12, D13, D15** — rewritten for Electron, cross-platform, TS, better-sqlite3, electron-updater, electron-builder, GNOME-tray gotcha, Linux paths.
- **D3, D4, D5, D6, D7, D8, D14** — algorithmic / strategic decisions, unchanged. The Swift implementations under `legacy-swift/` are a faithful reference for the TS ports.
- The working `swift run LLMCostMonitor` smoke test (loading 2,250 LiteLLM models) is preserved as proof that the bundled `pricing.json` parses correctly. The same JSON file moves to `resources/` in slice 4.
