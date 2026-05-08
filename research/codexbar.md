# steipete/CodexBar — research note

**Repo:** https://github.com/steipete/CodexBar — 11.7k★, MIT-ish, the most-popular candidate.
**Stack:** Swift Package, multi-target: `CodexBar` (app), `CodexBarCLI`, `CodexBarCore` (logic), `CodexBarClaudeWatchdog` (process supervisor), `CodexBarClaudeWebProbe`, `CodexBarMacros`/`CodexBarMacroSupport`, `CodexBarWidget`. Sparkle auto-updater (`appcast.xml`).

CodexBar's edge over the others is **breadth of provider coverage** (29 providers under `Sources/CodexBarCore/Providers/`), but the architectural style is heavier and more web-scrape-oriented than ClaudeBar.

## Where usage data comes from

Per-provider strategy is mixed:

- **OpenAI Codex / ChatGPT desktop:** scans `~/.codex/` (env override **`CODEX_HOME`**, see `CodexHomeScope.swift` — exactly our pattern with `CLAUDE_CONFIG_DIR`).
- **Web-only providers** (no CLI): scrape the vendor's billing dashboard via stored browser cookies. Whole pipeline lives in `CodexBarCore`:
  - `BrowserDetection.swift`, `BrowserCookieAccessGate.swift`, `BrowserCookieImportOrder.swift`, `CookieHeaderCache.swift`, `CookieHeaderNormalizer.swift` — pull cookies from Chrome/Safari/Firefox/Edge in priority order, normalize, cache.
  - Uses WebKit (`Sources/CodexBarCore/WebKit/`) to talk to dashboards that need a JS context.
- **Local-CLI providers** (Kimi/Qwen/Mistral/etc.): one folder per provider under `Sources/CodexBarCore/Providers/<Name>/`. Strategy varies by provider; some launch the CLI and parse output (like ClaudeBar's pattern), some read on-disk session JSON.
- **Claude Code:** `Providers/Claude/`. Has a separate `CodexBarClaudeWebProbe` target (Sandboxed WKWebView used for the claude.ai dashboard) and a session scanner. `PiSessionCostScanner.swift` (30 KB) scans Claude/Codex/etc. session JSONL.
- **VertexAI / Bedrock:** dedicated provider folders.

`Providers/Providers.swift` (5 KB) is the registry; `ProviderDescriptor.swift` (5 KB) describes a provider; `ProviderFetchPlan.swift` (7 KB) drives the per-provider fetch.

The 29 providers: `Abacus, Alibaba, Amp, Antigravity, Augment, Claude, Codebuff, Codex, Copilot, Cursor, DeepSeek, Factory, Gemini, JetBrains, Kilo, Kimi, KimiK2, Kiro, MiniMax, Mistral, Ollama, OpenCode, OpenCodeGo, OpenRouter, Perplexity, Synthetic, VertexAI, Warp, Windsurf, Zai`.

## CodexBarClaudeWatchdog — what it actually is

A *process supervisor*, not a parser. `main.swift` (3.3 KB) does `posix_spawnp` of a child binary, sets a process group, watches for SIGTERM/SIGINT/SIGHUP, kills the child tree on parent death. Used to wrap the WebKit probe so it can be force-killed on timeout. Not directly relevant to our build, but a useful reference if our scrapers misbehave.

## Pricing strategy

`ProviderCostSnapshot.swift` is just the *result* shape — `used`, `limit`, `currencyCode`, `period` ("Monthly"), `resetsAt`, `nextRegenAmount`. Each provider returns its own `ProviderCostSnapshot`. The actual *prices* come from each vendor's dashboard response, not a vendored table — CodexBar reads spend numbers directly from the source (e.g., Claude.ai shows you a $/limit; CodexBar parses that). For local-CLI providers, the math is per-provider.

This is a different philosophy from ours: "ask the vendor what they're charging" vs "compute it from tokens × price table". Theirs is more accurate per-vendor; ours is more uniform. We should do **token×price** but keep the option to override with vendor-reported spend (like masorange does with Looker).

## UI pattern

Menubar item shows the most-stressed provider's percentage / spend. Dropdown shows each provider as a row with its limit + reset timer. They use Swift Macros (`CodexBarMacros`) for boilerplate reduction.

## Steal

1. **`CODEX_HOME` env override pattern** — confirms our `CLAUDE_CONFIG_DIR` plan is the right idiom.
2. **`ProviderDescriptor` + `ProviderFetchPlan`** as a more configurable alternative to ClaudeBar's protocol-only model. Worth peeking at if our adapter matrix grows.
3. **`ProviderCostSnapshot` shape** — `used / limit / currencyCode / period / resetsAt / nextRegenAmount`. We can add `nextRegenAmount` to our `UsageQuota` for credit-regenerating providers (Cursor).
4. **The 29-provider list** as a roadmap — confirms which providers users care about.
5. **Browser-cookie scraping infrastructure** — *only* if we ever want to support web-dashboard-only providers (Cursor, Copilot personal). Don't chase this for MVP; it's a security/permissions tarpit.

## Skip

1. **Browser-cookie scraping** for MVP. Brittle, requires keychain access, breaks every time vendors change their dashboard markup. Save for later.
2. **The `*WebProbe` / WKWebView path.** Same reasoning. We're a *local-data* tool by design.
3. **The watchdog supervisor.** We don't need to wrap a child process for MVP.
4. **Macro-heavy code generation** — premature. Stick to plain Swift.
5. **Multi-target Swift Package.** One target is fine for MVP; we can split later.

## Source file index

| File | Role |
|---|---|
| `Sources/CodexBarCore/CodexHomeScope.swift` (740 B) | `CODEX_HOME` env resolution — confirms `~/.codex/` |
| `Sources/CodexBarCore/Providers/Providers.swift` (5 KB) | Provider registry |
| `Sources/CodexBarCore/Providers/ProviderDescriptor.swift` (5 KB) | Provider metadata |
| `Sources/CodexBarCore/Providers/ProviderFetchPlan.swift` (7 KB) | Fetch orchestration |
| `Sources/CodexBarCore/ProviderCostSnapshot.swift` (1 KB) | Result shape — `used/limit/currencyCode/period/resetsAt/nextRegenAmount` |
| `Sources/CodexBarCore/PiSessionCostScanner.swift` (30 KB) | Project-init session scanner |
| `Sources/CodexBarCore/UsageFetcher.swift` (40 KB) | Top-level fetch coordinator |
| `Sources/CodexBarCore/CostUsageModels.swift` (27 KB) | Cost data shapes |
| `Sources/CodexBarCore/Providers/<Name>/...` | One folder per provider (29) |
| `Sources/CodexBarCore/BrowserDetection.swift` (9 KB) etc. | Browser cookie pipeline (skip for MVP) |
| `Sources/CodexBarClaudeWatchdog/main.swift` (3 KB) | Standalone process supervisor (curiosity only) |
