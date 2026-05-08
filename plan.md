# LLM Cost Monitor — Project Plan

**Created:** 2026-05-05
**Working dir:** `/Volumes/Portal_SSD/pojo/`
**Project folder:** `/Volumes/Portal_SSD/pojo/llm-cost-monitor/`
**Status:** Phase 1 (research) complete. Phase 2 (architecture) revised 2026-05-05 to **Electron + cross-platform (macOS + Linux)** — see [`docs/architecture.md`](./docs/architecture.md). Phase 3 **slices 1–9 done 2026-05-06** (scaffold + ProviderIdentity + shared shapes + PricingTable + SQLite + Claude/Codex/Gemini parsers + AnthropicProvider/OpenAIProvider/GoogleProvider + Aggregator + real dropdown UI + 5-min periodic refresh). **Gemini brought forward from stretch** because the user explicitly asked for it. 42 vitest cases green. As of first-scan 2026-05-06: 700 events stored, $51.44 Claude / $34.01 Codex / $0.02 Gemini. Next: slice 10 (Claude Code hooks-API receiver) + slice 11 (chokidar tail with mtime cache) for true live updates.

---

## 1. Goal

Build a **new** open-source **macOS + Linux** tool that monitors LLM token usage and cost across the providers the user actually uses (Claude Code, OpenAI Codex, Gemini, Kimi, Qwen, etc.). The build is informed by reading existing high-star candidates rather than forking one.

**Success criteria for the MVP:**
- Real-time today / week / month cost numbers for at least Claude Code locally, no login required.
- Per-model and per-project breakdown.
- Local-only data — no telemetry, no cloud sync.
- **Runs as a tray/menubar app on both macOS and Linux** (single Electron app, two installers).

## 2. Why a new tool instead of forking

The existing apps cluster around two extremes:
- **CodexBar (11.7k★)** — polished, multi-provider, but **macOS-only Swift**, closed to specific data sources and UI choices.
- **Small per-tool monitors** — narrow scope, varied code quality, all macOS-only.

None of the five candidates run on Linux. Reading 3–4 of them and rebuilding gives a clean, opinionated **cross-platform** tool with the data sources we actually need.

## 3. Candidates studied (Phase 1, complete)

| # | Repo | Stars | What we extracted |
|---|---|---|---|
| 1 | [steipete/CodexBar](https://github.com/steipete/CodexBar) | 11.7k | `~/.codex/` + `CODEX_HOME` env override; 29-provider catalog as a roadmap |
| 2 | [hamed-elfayome/Claude-Usage-Tracker](https://github.com/hamed-elfayome/Claude-Usage-Tracker) | 2.4k | Statusline-hook integration into Claude Code |
| 3 | [tddworks/ClaudeBar](https://github.com/tddworks/ClaudeBar) | 1.1k | The provider protocol shape (`AIProvider` + `UsageProbe` + `UsageSnapshot`) |
| 4 | [masorange/ClaudeUsageTracker](https://github.com/masorange/ClaudeUsageTracker) | 112 | JSONL dedup-by-message-id, both cache_creation shapes, mtime cache |
| 5 | [junhoyeo/tokscale](https://github.com/junhoyeo/tokscale) | 2.6k | Provider canonicalization (`provider_identity.rs`); skip-bad-lines JSONL streamer |

Bonus reference: [BerriAI/litellm](https://github.com/BerriAI/litellm) — the authoritative `model_prices_and_context_window.json` (2,250+ models) we vendor.

Per-repo notes are in [`research/`](./research/); cross-cutting findings in [`research/SYNTHESIS.md`](./research/SYNTHESIS.md).

## 4. Phases

### Phase 0 — Setup (done)
- [x] Install GitHub MCP server.
- [x] Create project folder with `docs/`, `research/`, `Scripts/`, `bin/`.
- [x] Persist this plan.

### Phase 1 — Research (done, 2026-05-05)
Five per-repo notes plus `research/SYNTHESIS.md` written to disk. See those for the actual learnings.

### Phase 2 — Architecture decision (revised 2026-05-05 for cross-platform)

**Form factor (locked, revised).** ~~SwiftUI menubar app~~ → **Electron app** with `Tray` integration on macOS (menubar) and Linux (system tray). Renderer process renders the dropdown UI as web content; main process hosts the parsers, SQLite store, file watchers, and providers.

**Why the pivot:** the user wants to run the tool on Linux too. SwiftUI doesn't ship on Linux, and Swift-on-Linux would still need a separate UI stack. Electron pays the binary-size tax (~150 MB) to give us **one codebase, two installers**. The `eletron-pro` subagent will guide the actual scaffold post-restart.

**Data sources, paths, schema, parser rules, pricing strategy, provider abstraction shape — all unchanged from the SYNTHESIS.** Only the runtime stack and packaging change. See [`docs/architecture.md`](./docs/architecture.md) for the full revised decision record.

### Phase 3 — MVP build (Electron, slices defined in `docs/architecture.md` D15)
1. ✅ `electron-vite` scaffold + `package.json` + main/preload/renderer split. (done 2026-05-05; tray + ping-IPC dropdown work in `npm run dev`)
2. ✅ Port `ProviderIdentity` to TypeScript with the same regression tests (Vitest). (done 2026-05-05; `src/shared/provider-identity.ts` + `src/shared/__tests__/provider-identity.test.ts` — all 5 negative-case assertions including `protocol1-fast` / `metadata-model` / `metamorphic-v1` ported)
3. ✅ `UsageEvent`, `AIProvider`, `UsageProbe`, `UsageSnapshot` as TS interfaces. (done 2026-05-05; `src/shared/{usage-event,snapshot,provider}.ts` — bigint micro-USD for cost, epoch-ms for timestamps, tagged-union QuotaType, ProbeError class with kind discriminator)
4. ✅ `resources/pricing.json` + `main/pricing/PricingTable.ts` lookup chain + cost math + bundled load. (done 2026-05-05; 14 vitest cases including 1k-input Sonnet 3.5 → 10500 µUSD, fallback never silently $0; renderer shows `pricing snapshot <hash> · <count> models` via `pricing:info` IPC; electron-builder bundles `pricing.json` into `extraResources`)
5. ✅ `better-sqlite3` repository, schema v1 with integer micro-USD storage. (done 2026-05-05; `src/main/storage/{db,event-repository}.ts`, schema_version + events + files + pricing_overrides tables, WAL journal, `defaultSafeIntegers(true)` for bigint round-trip; 8 vitest cases including 2^60 cost preservation; renderer now shows `storage: <n> events`. Native-module ABI flip: `npm run rebuild:electron` before `npm run dev`, `npm run rebuild:node` before `npm test`)
6. ✅ Claude Code JSONL parser (Node streams) with masorange-grade dedup + new cache format. (done 2026-05-06; `src/main/parsers/claude-code.ts` + `jsonl.ts` streamer + `project-name.ts` slug simplifier; 4 fixture tests pass)
6b. ✅ Codex JSONL parser (BONUS, originally slice 12 — pulled forward). `src/main/parsers/codex.ts` reads `event_msg.payload.type=='token_count'` rows, joins with preceding `turn_context.payload.model`. 2 fixture tests.
6c. ✅ Gemini JSONL parser (NEW — was stretch). `src/main/parsers/gemini.ts` reads `~/.gemini/tmp/*/chats/session-*.jsonl`; tool tokens fold into output. 2 fixture tests.
7. ✅ ClaudeProvider, OpenAIProvider, GoogleProvider — implement `AIProvider` from D3, with promise-coalescing `refresh()`. `src/main/providers/{anthropic,openai,google}/index.ts` + `registry.ts`.
8. ✅ Aggregator: today / 7d / 30d / per-provider / top-models / top-projects via SQL `GROUP BY` over the events table. `src/main/aggregation/aggregator.ts`. Output shape in `src/shared/aggregates.ts`.
9. ✅ Real dropdown UI: 3 cost cards (today/7d/30d), per-provider today + 30d rows, top-models, top-projects, refresh button, footer. macOS tray title set to `$X.YZ` from today's total; updates after refresh. `src/renderer/src/App.tsx` + `styles.css`. Refresh-on-startup wired in `src/main/index.ts`.
10. Hooks-API receiver (Unix domain socket) for Claude Code session events.
11. `chokidar`-based JSONL tail as fallback.
12. Codex provider (`~/.codex/`).
13. Kimi `CLIQuotaProbe` (spawn the CLI, parse `/usage`).
14. Statusline CLI (small Node script reading `<app data>/statusline.json`).
15. `electron-updater` + `electron-builder` → `.dmg`, `.deb`, `.AppImage`.
16. README + Homebrew Cask + AUR (stretch).

### Phase 4 — Stretch
- Gemini, Qwen, DeepSeek/Cursor, GLM/Zai providers.
- Charts (sparkline of last 30 days).
- Budget alerts (notify at 80% / 100% of monthly cap).
- CSV export.
- Windows support (mostly free with Electron once Linux works; needs Named-Pipe instead of Unix socket for hooks).

## 5. Project layout (Electron)

```
llm-cost-monitor/
├── README.md
├── plan.md                              # (this file)
├── package.json                         # (created by eletron-pro subagent)
├── docs/
│   └── architecture.md                  # decision record D1–D15 (revised for Electron)
├── research/
│   ├── codexbar.md
│   ├── claude-usage-tracker-masorange.md  ← masorange-claude-usage-tracker.md
│   ├── claudebar-tddworks.md
│   ├── hamed-claude-usage-tracker.md
│   ├── tokscale.md
│   └── SYNTHESIS.md
├── src/                                 # populated by Phase 3
│   ├── main/                            # Electron main process (Node)
│   │   ├── providers/                   # one folder per provider
│   │   ├── parsers/                     # JSONL parsers
│   │   ├── pricing/                     # PricingTable loader
│   │   ├── storage/                     # better-sqlite3 repository
│   │   ├── watch/                       # chokidar tail + hook socket
│   │   └── tray.ts                      # menubar/tray entry
│   ├── preload/                         # context bridge
│   ├── renderer/                        # web UI (React or Vue)
│   └── shared/                          # types reused by main + renderer
│       ├── usage-event.ts               # canonical row shape
│       └── provider-identity.ts         # canonicalization + tests
├── resources/
│   └── pricing.json                     # vendored LiteLLM snapshot (refreshed in CI)
├── Scripts/
│   └── refresh-pricing.sh               # already present; works as-is
├── bin/                                 # statusline CLI
└── legacy-swift/                        # archived pre-pivot SwiftUI scaffold (do not extend)
```

## 6. Decisions (locked / revised 2026-05-05)

1. **Form factor (revised):** Electron app with `Tray` integration, macOS + Linux at MVP, Windows as Phase-4 stretch. Renderer = web UI, main = parsers + DB + file watchers.
2. **Scope:** multi-provider from day 1, same as before. Targets: Anthropic (Claude Code), OpenAI (Codex), Google (Gemini), Moonshot (Kimi), Alibaba (Qwen), DeepSeek, Zhipu (GLM), ByteDance (Doubao). Each behind a `UsageProbe` interface.
3. **License:** MIT.
4. **Metrics to capture:** unchanged — see Phase 1 SYNTHESIS §12 for the canonical `UsageEvent` schema.
5. **Publishing (revised):** public GitHub repo from day 1; **Homebrew Cask** (macOS) + **`.deb` for Debian/Ubuntu** + **`.AppImage`** (universal Linux) as MVP outputs from `electron-builder`. AUR + Snap as stretch. Skip the macOS App Store and Windows Store.

## 7. Immediate next action (after Claude Code restart with `eletron-pro` subagent loaded)

1. Use the `eletron-pro` subagent to scaffold the Electron project at the repo root (`package.json`, `electron-vite.config`, `src/main/`, `src/preload/`, `src/renderer/`, `tsconfig.json`, etc.).
2. Port `ProviderIdentity` from [`legacy-swift/Sources/LLMCostMonitor/Domain/Event/ProviderIdentity.swift`](./legacy-swift/Sources/LLMCostMonitor/Domain/Event/ProviderIdentity.swift) to TypeScript at `src/shared/provider-identity.ts`. Re-create the regression tests in Vitest (especially `protocol1-fast`, `metadata-model`, `metamorphic-v1` must NOT match).
3. Define the canonical `UsageEvent` shape at `src/shared/usage-event.ts` mirroring [`legacy-swift/Sources/LLMCostMonitor/Domain/Event/UsageEvent.swift`](./legacy-swift/Sources/LLMCostMonitor/Domain/Event/UsageEvent.swift). Use integer micro-USD (cents × 10⁴) for cost.
4. `resources/pricing.json` already on disk in `legacy-swift/Sources/LLMCostMonitor/Resources/pricing.json` — move to new location and verify `Scripts/refresh-pricing.sh` still points there.
5. Continue down the slice list in `docs/architecture.md` D15 (revised).
