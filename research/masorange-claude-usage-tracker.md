# masorange/ClaudeUsageTracker — research note

**Repo:** https://github.com/masorange/ClaudeUsageTracker — 112★, MIT-ish "Personal Use License (Non-Commercial)" (so we can't fork; can read).
**Stack:** SwiftUI, flat-file Xcode project at repo root, macOS menubar app.
**Closest fit to our scope** of any candidate. Reading order: `ClaudeUsageManager.swift` (parser, 37 KB) → `PricingManager.swift` (6 KB) → `LiteLLMManager.swift` (20 KB).

## Where usage data comes from

- **Path:** `~/.claude/projects/<slug>/<session>.jsonl`. Honors `CLAUDE_CONFIG_DIR` env var → `$CLAUDE_CONFIG_DIR/projects`. Tilde expansion done explicitly.
- **Discovery:** `FileManager.contentsOfDirectory` over `~/.claude/projects`, then each subdir, filtering `*.jsonl`.
- **JSONL row shape** (the union of fields it actually reads):
  ```jsonc
  {
    "timestamp": "2026-…Z",          // ISO8601 with fractional seconds
    "model":     "claude-sonnet-4-5", // sometimes on outer, sometimes message["model"]
    "message": {
      "id":   "msg_…",                  // dedup key; prefix "msg_vrtx" = Vertex/work account
      "role": "assistant",
      "model": "...",
      "usage": {
        "input_tokens":             N,
        "cache_read_input_tokens":  N,
        "output_tokens":            N,
        // OLD: "cache_creation_input_tokens": N
        // NEW:
        "cache_creation": {
          "ephemeral_5m_input_tokens": N,
          "ephemeral_1h_input_tokens": N
        }
      }
    }
  }
  ```
- **Dedup (critical):** Claude Code writes multiple JSONL entries per API call (streaming chunks). Strategy in `ClaudeUsageManager`:
  - Walk lines; for any entry with `message.id` AND `usage`, keep the **last** entry per id (later chunk = more complete usage). Pass-through entries that lack usage (user messages, tool calls).
- **Turn grouping:** Consecutive assistant messages within 10 s are grouped as one "turn" — but `processTurn` then bills each message individually. The grouping is cosmetic; we can drop it.
- **Account filtering:** `msg_vrtx` prefix → "work", else "personal". Exposed as `AccountFilter.{all, workOnly, personalOnly}`.
- **Per-file mtime cache:** `fileModificationCache: [path: Date]` + `fileResultsCache: [path: parsed]`. Skips re-parsing files that haven't changed since last load — big win for users with many sessions.

## Pricing strategy

- **Hardcoded**, not LiteLLM. `PricingManager.modelPricing: [String: ModelPricing]` literal dictionary, USD per 1 M tokens. Models include `claude-opus-4-6/4-5`, `claude-sonnet-4-6/4-5`, `claude-haiku-4-5-20251001`, plus Gemini 2.5/3 family.
- Prices listed are **Vertex regional** (Anthropic base × 1.1 multiplier — `vertexRegionalMultiplier = 1.1`).
- **Cache prices derived:** `cacheCreation = input × 1.25`, `cacheRead = input × 0.10`.
- **Long-context tier:** if `contextSize > 200_000`, switch to `longContext` table (Sonnet long: `6 / 22.5 / 7.5 / 0.6`).
- **Lookup:** exact match → substring match → fallback to Sonnet defaults.
- Pricing overrides persisted in `UserDefaults` (key `standardContextPricing` / `longContextPricing`) so users can hand-tune.

## What `LiteLLMManager.swift` actually does (non-obvious)

It's NOT a pricing source — it's a client for masorange's **internal** LiteLLM proxy at `https://llm.tools.cloud.masorange.es` (their corporate gateway). Talks to `/user/daily/activity`, `/user/info`, `/key/info`. Returns authoritative spend per day/per model. Only relevant if you have an `sk-…` key for that gateway, which we don't.

**Lesson:** the name "LiteLLMManager" misled me — for pricing we still need to vendor the LiteLLM JSON ourselves (or use AgentOps `tokencost` table).

## Storage

- UserDefaults for: API key, pricing overrides, daily-activity cache.
- No SQLite. No FSEvents. Refresh is on-demand or timer-driven. Fine at 100k events; will hurt at higher volumes.

## UI pattern

- SwiftUI menubar app entry in `ClaudeUsageTrackerApp.swift`. Main view in `MainView.swift` (55 KB — didn't fully read).
- Title bar: a `$` figure (today/month).
- Dropdown: monthly history table, model breakdown, project breakdown, currency picker (`CurrencyManager.swift`).
- Multi-language (`LocalizationManager.swift`, en/es).

## Steal

1. **JSONL dedup by `message.id`, keep the last usage-bearing entry.** Without this we double-count streaming chunks.
2. **Both `cache_creation_input_tokens` (old) and `cache_creation.ephemeral_{5m,1h}_input_tokens` (new) shapes** — handle both.
3. **Per-file mtime cache** keyed on filesystem mtime. Cheap correctness for incremental refresh.
4. **Vertex prefix bucketing** (`msg_vrtx*` → work account) — useful if user has corporate Anthropic via Vertex.
5. **`CLAUDE_CONFIG_DIR` env override** — Anthropic's official override; bake it in from day 1.
6. **Long-context price tier at 200 k threshold** — Anthropic does charge differently above 200 k input tokens.
7. **Project-slug → human name** (`-Users-foo-Documents-PERSONAL-bar` → `bar`) — slash-encoded dirnames need a stripper.
8. **Cache-creation derived multipliers** (input × 1.25, input × 0.10) as a fallback when the JSON pricing table doesn't enumerate cache prices.

## Skip

1. **Hardcoded model pricing dictionary.** Rots fast (their Opus 4.6 and Sonnet 4.6 entries already exist alongside 4.5). Vendor LiteLLM `model_prices_and_context_window.json` and refresh in CI instead.
2. **The 10-second turn-grouping heuristic** — useless given each message is billed individually anyway.
3. **The Looker Studio cost-override path** — masorange's internal corporate dashboard. Not generalizable.
4. **UserDefaults as the only store** — fine for a couple thousand sessions, but we want SQLite for charts/queries.

## Source file index

| File | Size | Role |
|---|---|---|
| `ClaudeUsageManager.swift` | 37 KB | The whole JSONL parser, dedup, turn grouping, mtime cache, monthly/project/model aggregation |
| `PricingManager.swift` | 6 KB | Hardcoded model→price dict, long-context tier switch, UserDefaults persistence |
| `LiteLLMManager.swift` | 20 KB | Client for masorange's internal LiteLLM proxy (NOT a pricing fetcher) |
| `ClaudeUsageTrackerApp.swift` | 8 KB | App entry, menubar wiring |
| `MainView.swift` | 55 KB | Big monolithic SwiftUI view — only worth skimming for the menubar layout |
| `CurrencyManager.swift` | 3 KB | FX conversion (likely fetches rates) |
| `LookerStudioManager.swift` | 7 KB | Their internal scraper — skip |
| `LookerAuthWindow.swift` | 48 KB | Same — skip |
| `SettingsView.swift` | 19 KB | Preferences UI |
| `UpdateManager.swift` | 4 KB | Sparkle-style updater |
