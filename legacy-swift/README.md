# legacy-swift/ — superseded SwiftUI scaffold

This directory holds the pre-pivot SwiftUI menubar implementation (slices 1-4 of the original plan). It was working end-to-end (`swift run LLMCostMonitor` printed `pricing snapshot 246413ab150e, 2250 models loaded`) before the project pivoted to **Electron + cross-platform Linux/Mac** on 2026-05-05.

**Why archived, not deleted.** The Swift code captures concrete, tested decisions that the TypeScript port should mirror:
- `Sources/LLMCostMonitor/Domain/Event/ProviderIdentity.swift` — provider canonicalization (port from tokscale's `provider_identity.rs`). Algorithm and the regression test cases are language-independent.
- `Sources/LLMCostMonitor/Domain/Event/UsageEvent.swift` — canonical schema. Port verbatim to a TypeScript interface.
- `Sources/LLMCostMonitor/Domain/Provider/{AIProvider,UsageProbe,UsageSnapshot,UsageQuota,QuotaType,QuotaStatus}.swift` — protocol shape (becomes TS interfaces).
- `Sources/LLMCostMonitor/Infrastructure/Pricing/PricingTable.swift` — LiteLLM JSON loader, fallback chain, Decimal-precision cost math (port to integer-micro-USD math in TS).
- `Tests/LLMCostMonitorTests/ProviderIdentityTests.swift` — every regression case here (especially `protocol1-fast` / `metadata-model` / `metamorphic-v1` not matching) must hold in the TS port too.

**Do not extend.** New work happens in the Electron tree at the project root. The plan and architecture record (`../plan.md`, `../docs/architecture.md`) are the active source of truth.
