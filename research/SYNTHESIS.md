# Cross-repo synthesis — five candidates studied

**Read-order recap:** [masorange](./masorange-claude-usage-tracker.md) → [ClaudeBar](./claudebar-tddworks.md) → [tokscale](./tokscale.md) → [CodexBar](./codexbar.md) → [hamed](./hamed-claude-usage-tracker.md).

This synthesis answers: **what should the LLM Cost Monitor steal, do differently, and ignore?**

---

## TL;DR

Build the menubar app on **ClaudeBar's `AIProvider` + `UsageProbe` + `UsageSnapshot` protocol** with **tokscale's provider canonicalization**, **masorange's JSONL dedup**, **vendored LiteLLM pricing**, **SQLite for history**, and **hamed's statusline-hook integration** as the killer UX. Skip CodexBar's cookie-scraping web-probe pipeline.

---

## 1. Data sources

| Source | File path | Format | Confirmed by | Notes |
|---|---|---|---|---|
| **Claude Code (Anthropic)** | `~/.claude/projects/<slug>/<session>.jsonl` (or `$CLAUDE_CONFIG_DIR/projects`) | JSONL, one row per streaming chunk | masorange, ClaudeBar | Multiple rows per message; **must dedupe by `message.id`** keeping last entry with usage |
| **OpenAI Codex CLI** | `~/.codex/` (or `$CODEX_HOME`) | Per-session JSON inside subdirs | CodexBar (`CodexHomeScope.swift`) | Detailed shape requires reading CodexBar's Codex provider folder later |
| **Gemini CLI** | `~/.gemini/` (assumed; not directly verified yet) | TBD | CodexBar / ClaudeBar provider folders | Likely JSON sessions; CLI also exposes `/usage` we can spawn |
| **Kimi (Moonshot)** | CLI-spawn | Spawn `kimi`, send `/usage`, parse TUI table | ClaudeBar's `KimiCLIUsageProbe` | Same pattern works for any CLI with a usage command |
| **Qwen / Alibaba** | Probably `~/.qwen/` + CLI-spawn | TBD | ClaudeBar `Alibaba/`, CodexBar `Alibaba/`/`KimiK2/` | |
| **DeepSeek / GLM / MiniMax** | Usually used through Cline / Cursor / Continue, not their own CLI | Cursor workspace storage etc. | CodexBar `DeepSeek/`, `Cursor/`, ClaudeBar `MiniMax/`, `Zai/` | Read these from the *aggregator client* (Cursor SQLite, Cline workspace state) |
| **Vendor APIs** (Anthropic Console API, LiteLLM proxy) | HTTPS | JSON | hamed, masorange | Optional override — when user has an API key, prefer vendor-reported spend |
| **Web dashboards** (claude.ai, ChatGPT, Cursor) | Cookie-authed scraping | HTML/JSON | CodexBar | **Skip for MVP** — brittle, security-heavy |

**Decision:** support the local-file sources Day 1; CLI-spawn pattern for "live quota" probes; defer web-dashboard scraping.

---

## 2. JSONL row shape — what to actually parse (Claude Code)

The union of fields seen in masorange + ClaudeBar:

```jsonc
{
  "type":      "assistant",                       // filter on this (ClaudeBar)
  "timestamp": "2026-…Z",                         // ISO8601 with optional fractional seconds
  "model":     "claude-sonnet-4-5",               // sometimes here, sometimes message.model
  "message": {
    "id":      "msg_…",                            // dedup key. Prefix "msg_vrtx" => Vertex
    "role":    "assistant",
    "model":   "...",
    "usage": {
      "input_tokens":             N,
      "cache_read_input_tokens":  N,
      "output_tokens":            N,

      // OLD format (still seen in older sessions):
      "cache_creation_input_tokens": N,

      // NEW format (current):
      "cache_creation": {
        "ephemeral_5m_input_tokens": N,
        "ephemeral_1h_input_tokens": N
      }
    }
  }
}
```

**Parsing rules:**
1. Filter `type == "assistant"` (ClaudeBar) OR fall back to `message.usage` presence (masorange) — masorange's broader rule is safer.
2. **Dedupe by `message.id`**, keeping the last usage-bearing entry.
3. Handle both cache_creation shapes: try `usage.cache_creation_input_tokens`, else sum `usage.cache_creation.ephemeral_5m_input_tokens` + `ephemeral_1h_input_tokens`.
4. **Skip malformed lines** silently (tokscale's rule). JSONL is written incrementally; partial lines happen.
5. **Per-file mtime cache**: read `(filepath → mtime, parsed-result)` from disk (SQLite), skip files where mtime hasn't changed.

---

## 3. Pricing strategy — the only place to break with all 5 candidates

All 5 candidates **hardcode** model prices in code (masorange + ClaudeBar + likely the others). They all rot — masorange's table already lists Sonnet 4.6 next to 4.5; ClaudeBar's lists Opus 4 alongside 4.6.

**Our approach:**
1. **Vendor LiteLLM's `model_prices_and_context_window.json`** (~3000 models, all token kinds, all providers) at `Resources/pricing.json`.
2. **Refresh nightly via a CI job** — small script does `curl https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/model_prices_and_context_window.json | jq | git commit`. No runtime network dependency.
3. **Fallback chain** (port from ClaudeBar): exact match → prefix match → keyword (`opus` / `sonnet` / `haiku` / `gpt` / `gemini`) → default.
4. **Vendor-reported override** (port from hamed/masorange): when the user has an Anthropic Console API key configured, use their spend numbers as the source of truth and treat token×price as the offline fallback / per-project allocator.
5. **Use `Decimal`, not `Double`** (ClaudeBar) — money math.
6. **Long-context tier at >200 k input tokens** (masorange) — Anthropic genuinely charges differently above 200 k.

---

## 4. Provider abstraction — ClaudeBar wins, cleanly

Adopt verbatim, with one change:

```swift
public protocol AIProvider: AnyObject, Sendable, Identifiable where ID == String {
    var id: String { get }                 // canonical: "anthropic", "openai", "google", "moonshotai", …
    var name: String { get }
    var isEnabled: Bool { get set }
    var isSyncing: Bool { get }
    var snapshot: UsageSnapshot? { get }
    var lastError: Error? { get }
    func isAvailable() async -> Bool
    @discardableResult func refresh() async throws -> UsageSnapshot
}

public protocol UsageProbe: Sendable {
    func probe() async throws -> UsageSnapshot
    func isAvailable() async -> Bool
}
```

**Change vs. ClaudeBar:** use **canonical provider IDs** (port tokscale's `provider_identity.rs`). `vertex` and `vertex_ai` collapse to `anthropic`; `gemini` collapses to `google`; etc. One Swift function (`ProviderIdentity.canonical(rawTag:)` + `ProviderIdentity.inferred(fromModel:)`) drives every per-provider rollup.

`UsageSnapshot` carries:
- `quotas: [UsageQuota]` (session, weekly, model-specific)
- `costUsage: CostUsage?` (vendor-reported spend when available)
- `dailyUsageReport: DailyUsageReport?` (today/yesterday from local JSONL)
- `extensionMetrics: [ExtensionMetric]?` (escape hatch — generic key/value/unit triples)
- `accountTier`, `accountEmail`, `loginMethod`, `capturedAt`

**Two probe families** (both implement `UsageProbe`):
1. **`LocalSessionProbe`** — reads on-disk JSONL/JSON (Claude Code, Codex, Gemini sessions). Returns `dailyUsageReport`.
2. **`CLIQuotaProbe`** — spawns the vendor's CLI with a usage subcommand, parses output (Kimi, Qwen, Claude `/status`). Returns `quotas`. ClaudeBar's `KimiCLIUsageProbe.parse(_:)` is the prototype.

Optional third: `APIProbe` (Anthropic Console API, LiteLLM proxies) — set `costUsage`.

---

## 5. Live session tracking

Two mechanisms; use them in tandem.

1. **Claude Code's hooks API** (ClaudeBar's `SessionMonitor` + `HookEventReceiver`) — register for `sessionStart / sessionEnd / taskCompleted / subagentStart / subagentStop / stop`. Cleaner than file tailing, official surface.
2. **JSONL tail with `DispatchSourceFileSystemObject`** as fallback for providers without hooks (Codex, Kimi, etc.). Watch the most recently modified session file, parse new lines incrementally.

For "current model + context used + remaining":
- Tail latest JSONL, grab last assistant `usage`, sum (`input + cache_read + cache_creation`), compare to model's `context_window` from LiteLLM JSON → `% remaining`.

---

## 6. Storage — SQLite, not UserDefaults

masorange uses UserDefaults; ClaudeBar uses in-memory; hamed has a dedicated `UsageHistoryService` (likely SQLite). We pick **SQLite** at `~/Library/Application Support/llm-cost-monitor/usage.db`:

- `events` table: `(provider, model, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_5m, cache_creation_1h, project, session_id, raw_path, raw_line_offset, computed_cost_usd)`
- `files` table: `(path, mtime, last_parsed_at)` for the mtime cache
- `pricing_overrides` table: `(model, input_per_m, output_per_m, cache_write_per_m, cache_read_per_m, source: 'litellm'|'user'|'api')`
- `aggregates_daily` view (or materialized table refreshed on writes): `(date, provider, model, project, cost_usd, tokens)` for fast dropdown queries.

Plain SQLite is enough; no need for SwiftData / Core Data.

---

## 7. UI — minimum viable menubar

**Title bar (default):** `$X today` (today's cost). Optionally append context % when an active session is detected: `$X.XX  ▮▮▮▯▯ 62%`.
**Dropdown:**
- Header: today / 7-day / 30-day cost; data source badge ("local" / "API")
- "Now" section if active: model name, $session, context% remaining, time-since-start
- Top 3 models (cost) and top 3 projects (cost) — links to expanded views
- Per-provider summary row (one line per enabled provider, showing today's spend or quota %)
- Footer: refresh button, settings, quit

**Customization to ship later** (lessons from hamed's heavyweight `MenuBarIconConfig`): icon colors, hide-zero-spend, format (cost vs quota%). MVP can hardcode "show today's $".

---

## 8. Statusline integration — the differentiator

Steal from hamed's `StatuslineService`. Ship a small script (`bin/llm-cost-monitor-statusline.sh`) that reads from a known socket/file the app updates every few seconds and prints `cost  context  model` for Claude Code's `~/.claude/statusline.sh`. Users get live numbers *inside the terminal* without leaving their session. Defer to v0.2 if MVP timeline tight, but architect for it now.

---

## 9. Updates / distribution

CodexBar uses Sparkle (`appcast.xml`). hamed has its own `UpdateManager` over GitHub Releases. We pick **Sparkle 2** with appcast hosted on GitHub Pages — well-trodden Swift path, signed updates, no MAS friction.

Distribution: **Homebrew tap** + signed DMG attached to GitHub releases. Skip Mac App Store (notarization-only, not sandboxed-app-store) until v1.

---

## 10. Path conventions to bake in

| Setting | Value | Override env | Inspired by |
|---|---|---|---|
| Claude Code logs | `~/.claude/projects/**/*.jsonl` | `CLAUDE_CONFIG_DIR` | masorange, plan.md |
| Codex logs | `~/.codex/**` | `CODEX_HOME` | CodexBar |
| Gemini logs | `~/.gemini/**` | `GEMINI_HOME` (assumed) | tokscale, ClaudeBar |
| Kimi logs / spawn | CLI-spawn `kimi` | n/a | ClaudeBar |
| App data | `~/Library/Application Support/llm-cost-monitor/` | `LLM_COST_MONITOR_HOME` | tokscale paths.rs lessons |
| Cache | `<app data>/cache/` | (same) | tokscale |
| SQLite db | `<app data>/usage.db` | (same) | hamed |
| Statusline socket/file | `<app data>/statusline.json` | (same) | hamed |

Empty-string env values are treated as unset (tokscale defensive idiom).

---

## 11. What we explicitly skip for MVP

1. **Browser-cookie scraping** of vendor dashboards (CodexBar's biggest infrastructure).
2. **Web-probe / WKWebView** path.
3. **Watchdog supervisor processes**.
4. **Multi-language localization** (masorange's en/es).
5. **Network request logger** (hamed).
6. **Peak-hours analytics** (hamed).
7. **Looker Studio / corporate dashboard scrapers** (masorange).
8. **Year-in-review "Wrapped"** (tokscale).
9. **The full 29-provider catalog** — start with Claude / Codex / Gemini / Kimi / Qwen, defer the rest.
10. **Macros / multi-target Swift Package** — single target until clarity.

---

## 12. UsageEvent schema (proposed; finalize in `docs/architecture.md`)

```swift
struct UsageEvent: Codable, Sendable, Identifiable {
    let id: String                       // SHA256(provider + sessionId + messageId + timestamp)
    let provider: String                 // canonical: "anthropic", "openai", "google", …
    let providerRawTag: String?          // unmodified source tag, for debugging
    let model: String                    // raw, e.g. "claude-sonnet-4-5-20250929"
    let timestamp: Date                  // UTC ISO8601
    let project: String?                 // simplified project name (e.g. "llm-cost-monitor")
    let projectRawSlug: String?          // original "-Users-foo-Documents-bar"
    let sessionId: String?
    let messageId: String?               // for dedup

    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheCreation5mTokens: Int       // both shapes normalized into this
    let cacheCreation1hTokens: Int       // 0 if old format
    let reasoningTokens: Int?            // OpenAI o-series

    let toolCallCount: Int?
    let latencyMs: Int?                  // when present in source
    let computedCostUsd: Decimal         // applied at parse time using pricing snapshot
    let pricingSnapshotVersion: String   // git sha of vendored litellm json

    let sourceFile: String               // absolute path
    let sourceLineOffset: Int            // for re-fetching
}
```

Rationale: dedup-by-id; canonical + raw provider tags so we can re-canonicalize without re-scanning; both cache-creation tiers; pricing snapshot version for reproducibility ("why does today's cost differ from yesterday's?" → "we updated pricing").

---

## 13. Build order (refines plan.md §3)

1. Scaffold a single-target SwiftUI menubar app with `Domain` / `Infrastructure` / `App` folders.
2. Port `provider_identity` from tokscale to Swift.
3. Define `UsageEvent`, `UsageSnapshot`, `AIProvider`, `UsageProbe`.
4. Implement `LocalSessionProbe` for Claude Code with masorange-grade dedup + new-cache-format support.
5. Vendor LiteLLM JSON; `Pricing.cost(for: UsageEvent)` returns `Decimal`.
6. SQLite schema + repository for `events` + `files` mtime cache.
7. Aggregator: today / 7d / 30d / per-model / per-project.
8. Menubar UI (header + dropdown).
9. Add `ClaudeAPIProbe` (Anthropic Console) as optional override.
10. Add `CLIQuotaProbe` for Kimi (validate the CLI-spawn pattern).
11. Wire Codex `LocalSessionProbe` (`~/.codex/`) — same shape as Claude.
12. Statusline integration script.
13. Sparkle updater + GitHub release pipeline.
14. README + Homebrew tap.

Stretch (v0.2+): Gemini, Qwen, DeepSeek/Cursor, GLM/Zai. Charts. Budget alerts. CSV export.
