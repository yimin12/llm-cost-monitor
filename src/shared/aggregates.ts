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

export interface AggregateSnapshot {
  generatedAt: number
  today: RangeTotal
  last7d: RangeTotal
  last30d: RangeTotal
  byProviderToday: CostByProvider[]
  byProvider30d: CostByProvider[]
  topModelsToday: CostByModel[]
  topProjectsToday: CostByProject[]
}
