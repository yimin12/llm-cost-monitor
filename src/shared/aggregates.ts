// Output shapes for the aggregator. All cost values are integer micro-USD
// (1 USD = 1_000_000) carried as `bigint` across IPC. Renderer converts
// to display USD only at the boundary.

export interface CostByProvider {
  provider: string
  costMicroUsd: bigint
  eventCount: number
}

export interface CostByModel {
  model: string
  provider: string
  costMicroUsd: bigint
  eventCount: number
}

export interface CostByProject {
  project: string
  costMicroUsd: bigint
  eventCount: number
}

export interface RangeTotal {
  costMicroUsd: bigint
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  reasoningTokens: number
  eventCount: number
}

// Month-to-date forecast for the current calendar month. `null` means
// insufficient data (< 3 days of usage in the month).
export interface MonthlyForecast {
  monthStartMs: number
  daysElapsed: number
  daysInMonth: number
  spentMicroUsd: bigint
  // Linear projection: spent / daysElapsed × daysInMonth.
  estimateMicroUsd: bigint
  // ±1σ band over per-day costs scaled to remaining days. Single-sided width
  // in micro-USD. Renderer uses estimate ± confidenceBand.
  confidenceBandMicroUsd: bigint
}

export interface SessionRow {
  sessionId: string
  provider: string
  project: string
  costMicroUsd: bigint
  eventCount: number
  firstAt: number
  lastAt: number
}

export interface AggregateSnapshot {
  generatedAt: number
  today: RangeTotal
  last7d: RangeTotal
  last30d: RangeTotal
  byProviderToday: CostByProvider[]
  byProvider30d: CostByProvider[]
  topModelsToday: CostByModel[]
  topProjectsToday: CostByProject[]
  forecast: MonthlyForecast | null
  // Per-provider month-end forecast — same linear projection as `forecast`,
  // computed independently for each provider that has ≥3 days of activity in
  // the current month. Providers below the threshold are absent from the map.
  forecastByProvider: Record<string, MonthlyForecast>
  // Last 14 calendar days of cost in micro-USD, oldest → newest. Today is the
  // last entry; days with no events are 0n. Drives the hero sparkline.
  dailyCostMicroUsd: bigint[]
  // Most recent activity timestamp per provider (ms epoch). Empty when no
  // events for that provider exist.
  providerLastSeen: Record<string, number>
  // Most recent N sessions ordered by last activity DESC. Drives Sessions tab.
  recentSessions: SessionRow[]
}
