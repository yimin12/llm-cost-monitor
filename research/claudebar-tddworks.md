# tddworks/ClaudeBar — research note

**Repo:** https://github.com/tddworks/ClaudeBar — 1.1k★. Swift Package + Tuist + Codecov; production-grade architecture.
**Stack:** SwiftUI menubar app, clean **Domain / Infrastructure / App** layering.
**The blueprint.** Of all 5 candidates this is the closest to what we want to build, *especially* its provider abstraction. Not the pricing model — that's hardcoded — but the protocol shape and adapter lineup.

## Provider abstraction (the steal)

`Sources/Domain/Provider/AIProvider.swift` defines:

```swift
public protocol AIProvider: AnyObject, Sendable, Identifiable where ID == String {
    var id: String { get }                 // "claude", "codex", "gemini"
    var name: String { get }
    var cliCommand: String { get }
    var dashboardURL: URL? { get }
    var statusPageURL: URL? { get }
    var isEnabled: Bool { get set }
    var isSyncing: Bool { get }            // @Observable
    var snapshot: UsageSnapshot? { get }   // @Observable
    var lastError: Error? { get }
    func isAvailable() async -> Bool
    @discardableResult func refresh() async throws -> UsageSnapshot
}

@Mockable
public protocol UsageProbe: Sendable {
    func probe() async throws -> UsageSnapshot
    func isAvailable() async -> Bool
}
```

Two layers: `AIProvider` is the rich, observable domain object users see; `UsageProbe` is the swappable infrastructure adapter that actually fetches data. This separation is exactly what we need.

`UsageSnapshot` (the unified data model) carries:
- `quotas: [UsageQuota]` (session, weekly, model-specific)
- `costUsage: CostUsage?` (for Claude API accounts)
- `dailyUsageReport: DailyUsageReport?` (for local-JSONL providers)
- `bedrockUsage: BedrockUsageSummary?`
- `extensionMetrics: [ExtensionMetric]?` — **escape hatch** for arbitrary metrics from third-party probes
- `accountTier`, `accountEmail`, `loginMethod`
- Helpers: `overallStatus`, `lowestQuota`, `paceAwareOverallStatus(burnRateThreshold:)`, `isStale` (>5 min), `ageDescription` ("3m ago"). `static func empty(for:)`.

## Per-provider adapters (29 providers under `Sources/Infrastructure/`)

| Provider | Strategy | Notable file |
|---|---|---|
| **Claude** (`/Claude/`) | JSONL scan + API + hooks | `SessionJSONLParser.swift`, `ClaudeDailyUsageAnalyzer.swift`, `ClaudeAPIUsageProbe.swift`, `ClaudeUsageProbe.swift` (40 KB), `ClaudePassProbe.swift` |
| **Codex** | Per-session scanner | `Sources/Infrastructure/Codex/...` |
| **Gemini** | CLI-spawn + parse | similar shape to Kimi |
| **Kimi** (Moonshot) | **Spawn `kimi` CLI, send `/usage`, parse the TUI output** | `KimiCLIUsageProbe.swift` (6.8 KB) — see snippet below |
| **Alibaba** (Qwen) | CLI-spawn | `Sources/Infrastructure/Alibaba/...` |
| **MiniMax**, **Zai** (GLM), **Mistral**, **Cursor**, **Copilot**, **AmpCode**, **Antigravity**, **Bedrock**, **Kiro** | one folder each | various |

## Kimi CLI probe trick (worth stealing)

The CLI-spawn-and-parse pattern is the cleverest thing in the whole repo. Excerpt from `KimiCLIUsageProbe.parse(_:)`:

```swift
// Sample CLI output (after Kimi’s /usage):
// │  Weekly limit  ━━━━━━━━━━━━━━━━━━━━  100% left  (resets in 6d 23h 22m)
// │  5h limit      ━━━━━━━━━━━━━━━━━━━━   75% left  (resets in 4h 22m)

for line in text.components(separatedBy: .newlines) {
    guard line.lowercased().contains("% left") else { continue }
    let quotaType: QuotaType = line.lowercased().contains("weekly") ? .weekly : .session
    let percentMatch = line.range(of: #"(\d+)%\s+left"#, options: .regularExpression)
    let resetMatch   = line.range(of: #"\(resets\s+in\s+(.+?)\)"#, options: .regularExpression)
    quotas.append(UsageQuota(percentRemaining: …, quotaType: quotaType, providerId: "kimi",
                             resetsAt: …, resetText: …))
}
```

It launches `kimi` via a `CLIExecutor` with auto-responses (`["💫": "/usage\r"]`), grabs stdout, regex-parses two lines. We can use this exact pattern for **every CLI tool that has a `/usage` or similar command** — Kimi, Qwen, Gemini CLI, Codex CLI, Claude (`claude /status`), etc. No JSONL knowledge required.

## Claude Code JSONL parser

`SessionJSONLParser.swift` (4 KB) is much simpler than masorange's: one filter (`json["type"] == "assistant"`), reads `message.usage.{input,output,cache_creation_input,cache_read_input}_tokens`. **No deduplication.** Scans only files modified in the last 2 days for `analyzeToday`.

Note: it uses the **OLD** `cache_creation_input_tokens` field only; doesn't handle the new `cache_creation.ephemeral_5m_input_tokens` shape that masorange decodes. We need both.

## Pricing

`Sources/Infrastructure/Claude/ModelPricing.swift` — same anti-pattern as masorange: hardcoded dictionary. Uses `Decimal` (better than masorange's `Double`). Includes a clever fallback chain: exact match → prefix match → keyword (`opus`/`haiku`) → default (Sonnet rate). Also exposes `savings(for: record)` — what cache-read tokens would have cost without caching.

## Live session tracking

`Sources/Domain/Session/SessionMonitor.swift`:
- `@MainActor @Observable` class
- Subscribes to `SessionEvent` from Claude Code's hook system (`HookEventReceiver`)
- Events: `.sessionStart`, `.sessionEnd`, `.taskCompleted`, `.subagentStart/Stop`, `.stop`
- Maintains `activeSession: ClaudeSession?` and a sliding window of `recentSessions`
- **The trick:** uses Claude Code's official **hooks API** to receive events instead of tailing JSONL. Cleaner than polling.

## Storage

Reads from filesystem; runtime state in memory; user prefs presumably via `ProviderSettingsRepository.swift` (10 KB) → `MultiAccountSettingsRepository.swift`. Doesn't appear to use SQLite.

## UI

Title bar: per-provider quota indicator (lowest %). Dropdown: per-provider cards with quota bars + reset timers. Pace-aware status (burn-rate thresholds).

## Steal

1. **`AIProvider` + `UsageProbe` two-layer protocol** — port verbatim. Best abstraction in the field.
2. **`UsageSnapshot` aggregate** — quotas + costUsage + dailyUsageReport + extensionMetrics escape hatch.
3. **`extensionMetrics: [ExtensionMetric]`** — generic key/value/unit triplet for arbitrary metrics. Means new providers don't need their own DB columns.
4. **`isStale` (>5 min) + `ageDescription`** — basic UX for refresh state.
5. **CLI-spawn + parse pattern** for Kimi/Qwen/Gemini CLI/Claude `/status`. Way easier than reverse-engineering each tool's on-disk JSON format.
6. **Hook-based session monitoring** via Claude Code's own hooks API instead of file tailing. Lower CPU, fewer race conditions, official surface.
7. **Pace-aware status** (`paceAwareOverallStatus(burnRateThreshold:)`) — flags users approaching limits before they hit them.
8. **`Decimal` over `Double` for money** — masorange uses Double; ClaudeBar uses Decimal. We use Decimal.
9. **`savings(for:)`** showing cache savings — nice marketing-friendly stat.

## Skip

1. **Hardcoded pricing dict** — same problem as masorange, vendor LiteLLM JSON.
2. **No JSONL dedup** — they may double-count streaming chunks. Use masorange's dedup-by-message-id.
3. **No `cache_creation` new-format support** — must handle ephemeral_5m / 1h split.
4. **29-provider Tuist project** is overkill for an MVP. Start with 4-5; defer the rest until adapters are mature.

## Source file index

| File | Role |
|---|---|
| `Sources/Domain/Provider/AIProvider.swift` (2 KB) | The protocol |
| `Sources/Domain/Provider/UsageSnapshot.swift` (4.5 KB) | Unified data shape |
| `Sources/Domain/Provider/UsageQuota.swift` (8.7 KB) | Quota model |
| `Sources/Domain/Provider/QuotaStatus.swift` / `QuotaType.swift` | Enums |
| `Sources/Domain/Session/SessionMonitor.swift` (3 KB) | Live session state machine |
| `Sources/Domain/Session/HookEventReceiver.swift` | Claude Code hooks listener |
| `Sources/Infrastructure/Claude/SessionJSONLParser.swift` (4 KB) | Simple JSONL parser |
| `Sources/Infrastructure/Claude/ClaudeDailyUsageAnalyzer.swift` (5.5 KB) | Today/yesterday aggregator with mtime filter |
| `Sources/Infrastructure/Claude/ModelPricing.swift` (3 KB) | Hardcoded pricing |
| `Sources/Infrastructure/Kimi/KimiCLIUsageProbe.swift` (6.8 KB) | CLI-spawn + regex parse |
| `Sources/Infrastructure/Kimi/KimiUsageProbe.swift` (10 KB) | Probably the API path |
