// One billable LLM API call, normalized across providers.
// Schema rationale: docs/architecture.md D6.
// Cost is stored as integer micro-USD (1 USD = 1_000_000) via bigint
// to avoid floating-point drift across token×price arithmetic.

export interface UsageEvent {
  readonly id: string
  readonly provider: string
  readonly providerRawTag: string | null
  readonly model: string
  readonly timestamp: number

  readonly project: string | null
  readonly projectRawSlug: string | null
  readonly sessionId: string | null
  readonly messageId: string | null

  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheCreation5mTokens: number
  readonly cacheCreation1hTokens: number
  readonly reasoningTokens: number | null
  readonly toolCallCount: number | null
  readonly latencyMs: number | null

  readonly computedCostMicroUsd: bigint
  readonly pricingSnapshotVersion: string

  readonly sourceFile: string
  readonly sourceLineOffset: number
}

export const MICRO_USD_PER_USD = 1_000_000n

export function totalContextTokens(e: UsageEvent): number {
  return (
    e.inputTokens + e.cacheReadTokens + e.cacheCreation5mTokens + e.cacheCreation1hTokens
  )
}

export function totalTokens(e: UsageEvent): number {
  return (
    e.inputTokens +
    e.outputTokens +
    e.cacheReadTokens +
    e.cacheCreation5mTokens +
    e.cacheCreation1hTokens
  )
}

export function microUsdToUsd(micro: bigint): number {
  return Number(micro) / 1_000_000
}

export function usdToMicroUsd(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000))
}
