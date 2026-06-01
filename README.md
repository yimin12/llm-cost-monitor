# llm-cost-monitor

Open-source **macOS + Linux** tray app that tracks LLM token usage and cost across the providers you actually use — Claude Code, OpenAI Codex, Gemini, Kimi, Qwen, and friends. Local-only telemetry-free; **optional Sign in with Google for identity only — no usage data uploaded** ([`docs/privacy.md`](./docs/privacy.md)). MIT.

**Status (2026-05-06):** Slices 1–9 done. **Working features:**

- Tray icon (macOS menubar) with today's USD cost in the title (`$X.YZ`).
- Dropdown showing **today / 7d / 30d** totals, **per-provider breakdown today + 30d**, **top models today**, **top projects today**, **provider availability**.
- Reads on-disk session logs from **Claude Code** (`~/.claude/projects/`), **OpenAI Codex** (`~/.codex/sessions/`), and **Google Gemini** (`~/.gemini/tmp/*/chats/`).
- Dedupes by message id (Claude), per-call last_token_usage (Codex), per-message id (Gemini).
- Costs computed via 2,250-model LiteLLM pricing snapshot, integer micro-USD throughout.
- **Storage:** **Postgres 17** in dev *and* shipped builds. Schema v1, BIGINT cost as JS bigint via `pg.types.setTypeParser`. The earlier "SQLite for shipped builds" plan is dropped — see [`docs/storage-decision.md`](./docs/storage-decision.md).
- **Refresh** on app start + every 5 minutes + manual button.
- **Team sync (opt-in, dev branch `feat/team-sync`)**: a Node/Postgres
  server in `server/` collects redacted projections of usage events
  for cross-node and team rollups. See [`docs/team-sync.md`](./docs/team-sync.md).
  Strictly off by default; existing installs see no behavior change.
- **Portable backend (`docker compose --profile server up`)**: the
  team-sync server ships as `Dockerfile.server` so private deployments
  drop in with one command. See
  [`docs/docker-portable.md`](./docs/docker-portable.md).

See [`plan.md`](./plan.md) for the project plan and [`docs/architecture.md`](./docs/architecture.md) for the decision record.

## Quickstart (dev — branch `feat/auth-gmail`)

This branch is mid-flight on the Postgres + auth migration. Dev requires
**Docker Desktop** running.

```sh
git clone https://github.com/<owner>/llm-cost-monitor.git
cd llm-cost-monitor
git checkout feat/auth-gmail
npm install
npm run dev      # predev: docker compose up -d postgres + electron-builder rebuild
```

The `predev` hook starts a Postgres 17 container (bound to `127.0.0.1:5433`),
then runs migrations on first connect, then ingests `~/.claude/`, `~/.codex/`,
and `~/.gemini/` into the new database. Click the tray icon to view costs.

Useful db commands:

```sh
npm run db:up      # start postgres only
npm run db:psql    # interactive psql shell against the dev DB
npm run db:logs    # tail postgres logs
npm run db:reset   # nuke + recreate (destroys all stored events)
npm run db:down    # stop, keep volume
```

### Storage decision

Postgres is the only event store, in both dev and shipped builds. The
`better-sqlite3` dependency is **legacy** — it's still listed in
`package.json` because `src/main/providers/cursor/credentials.ts` reads
the **Cursor IDE's** SQLite store (not ours) for an auth token. It is
not used for our event store. Rationale in
[`docs/storage-decision.md`](./docs/storage-decision.md).

> **Linux / GNOME note:** GNOME removed system-tray support. Install the [AppIndicator and KStatusNotifierItem Support](https://extensions.gnome.org/extension/615/appindicator-support/) extension. KDE Plasma, XFCE, Cinnamon, MATE, and LXQt work natively.

## Stack

- **Electron + TypeScript** main process: parsers, file watchers, providers, Postgres-backed storage.
- **React + Vite** renderer: the dropdown UI.
- **`pg`** + Postgres 17 for storage (dev and shipped); **vendored LiteLLM JSON** for pricing (2,250 models). `better-sqlite3` is only used to read the Cursor IDE's own auth-token SQLite store.
- **`electron-builder`** outputs: `.dmg` (macOS) + `.deb` and `.AppImage` (Linux).
- **`electron-updater`** + GitHub Releases for auto-updates.

## Layout

```
llm-cost-monitor/
├── README.md
├── plan.md
├── docs/architecture.md           # decision record D1–D15 (Electron-revised)
├── research/                      # 5 per-repo notes + SYNTHESIS.md
├── Scripts/refresh-pricing.sh     # snapshots LiteLLM model_prices_and_context_window.json
├── bin/                           # statusline CLI (slice 14)
├── src/                           # populated by Phase 3 (Electron tree)
├── resources/pricing.json         # vendored LiteLLM snapshot (moved here in slice 4)
└── legacy-swift/                  # archived pre-pivot SwiftUI scaffold; do not extend
```

## Phase 3 build slices

See [`docs/architecture.md`](./docs/architecture.md) D15 for the full table. Top-level:

1. `eletron-pro` subagent scaffolds the Electron project.
2-3. Port `ProviderIdentity` + `UsageEvent` shapes from `legacy-swift/` to TypeScript.
4. Move `pricing.json` into the new tree; implement `PricingTable` loader.
5. SQLite repository (`better-sqlite3`).
6. Claude Code JSONL parser (masorange-grade dedup, both cache_creation shapes).
7-8. ClaudeProvider + Aggregator.
9. Tray UI + dropdown.
10-11. Hook receiver + chokidar tailer (live session).
12-13. Codex provider + Kimi `CLIQuotaProbe`.
14-16. Statusline CLI + electron-builder/updater + README/Homebrew Cask.

## What lives in `legacy-swift/`

The pre-pivot SwiftUI scaffold (slices 1-4 of the original plan), kept as a reference for the TypeScript port. See [`legacy-swift/README.md`](./legacy-swift/README.md). Do not extend it.

## Design distilled from these candidates

| Repo | Stars | What we extracted |
|---|---|---|
| [steipete/CodexBar](https://github.com/steipete/CodexBar) | 11.7k | `~/.codex/` + `CODEX_HOME` env override; 29-provider catalog as a roadmap |
| [hamed-elfayome/Claude-Usage-Tracker](https://github.com/hamed-elfayome/Claude-Usage-Tracker) | 2.4k | Claude Code statusline-hook integration |
| [tddworks/ClaudeBar](https://github.com/tddworks/ClaudeBar) | 1.1k | The `AIProvider` + `UsageProbe` + `UsageSnapshot` protocol shape |
| [masorange/ClaudeUsageTracker](https://github.com/masorange/ClaudeUsageTracker) | 112 | JSONL dedup-by-message-id; both cache_creation shapes; mtime cache |
| [junhoyeo/tokscale](https://github.com/junhoyeo/tokscale) | 2.6k | Provider canonicalization (`provider_identity.rs`); skip-bad-lines streamer |

Plus [BerriAI/litellm](https://github.com/BerriAI/litellm)'s `model_prices_and_context_window.json` as the authoritative price table (vendored, refreshed in CI).
