// Point-in-time snapshot of one provider's state.
// Carries quotas + today/yesterday cost + vendor-reported spend +
// a generic extensionMetrics escape hatch — same shape as ClaudeBar's UsageSnapshot.

export const QuotaStatus = {
  Healthy: 0,
  Warning: 1,
  Critical: 2,
  Exhausted: 3,
} as const
export type QuotaStatus = (typeof QuotaStatus)[keyof typeof QuotaStatus]

export function quotaStatusFromPercentRemaining(percent: number): QuotaStatus {
  if (percent < 5) return QuotaStatus.Exhausted
  if (percent < 20) return QuotaStatus.Critical
  if (percent < 50) return QuotaStatus.Warning
  return QuotaStatus.Healthy
}

export type QuotaType =
  | { readonly kind: 'session' }
  | { readonly kind: 'daily' }
  | { readonly kind: 'weekly' }
  | { readonly kind: 'monthly' }
  | { readonly kind: 'modelSpecific'; readonly model: string }

export function quotaTypeDisplayName(t: QuotaType): string {
  switch (t.kind) {
    case 'session':
      return 'Session'
    case 'daily':
      return 'Daily'
    case 'weekly':
      return 'Weekly'
    case 'monthly':
      return 'Monthly'
    case 'modelSpecific':
      return t.model
  }
}

export interface UsageQuota {
  readonly providerId: string
  readonly quotaType: QuotaType
  readonly percentRemaining: number
  readonly resetsAt: number | null
  readonly resetText: string | null
}

export function quotaId(q: UsageQuota): string {
  return `${q.providerId}/${quotaTypeDisplayName(q.quotaType)}`
}

export function quotaStatus(q: UsageQuota): QuotaStatus {
  return quotaStatusFromPercentRemaining(q.percentRemaining)
}

export interface DailyStat {
  readonly date: number
  readonly totalCostMicroUsd: bigint
  readonly totalTokens: number
  readonly inputTokens: number
  readonly outputTokens: number
  // 5m + 1h flattened, for display only.
  readonly cacheCreationTokens: number
  readonly cacheReadTokens: number
  readonly sessionCount: number
}

export function emptyDailyStat(date: number): DailyStat {
  return {
    date,
    totalCostMicroUsd: 0n,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    sessionCount: 0,
  }
}

export interface DailyUsageReport {
  readonly today: DailyStat
  readonly yesterday: DailyStat
}

// Vendor-reported spend (overrides token×price math when available).
export interface CostUsage {
  readonly usedMicroUsd: bigint
  readonly limitMicroUsd: bigint | null
  readonly period: string | null
  readonly resetsAt: number | null
  readonly nextRegenAmountMicroUsd: bigint | null
  readonly updatedAt: number
}

// Generic key/value/unit triple — escape hatch for provider-specific metrics
// (Bedrock token credits, OpenRouter rate-limit headers, etc.).
export interface ExtensionMetric {
  readonly key: string
  readonly value: number
  readonly unit: string | null
  readonly display: string | null
}

export interface UsageSnapshot {
  readonly providerId: string
  readonly quotas: readonly UsageQuota[]
  readonly dailyUsageReport: DailyUsageReport | null
  readonly costUsage: CostUsage | null
  readonly extensionMetrics: readonly ExtensionMetric[]
  readonly accountEmail: string | null
  readonly accountTier: string | null
  readonly capturedAt: number
}

export function emptySnapshot(providerId: string): UsageSnapshot {
  return {
    providerId,
    quotas: [],
    dailyUsageReport: null,
    costUsage: null,
    extensionMetrics: [],
    accountEmail: null,
    accountTier: null,
    capturedAt: Date.now(),
  }
}

export function overallStatus(s: UsageSnapshot): QuotaStatus {
  let worst: QuotaStatus = QuotaStatus.Healthy
  for (const q of s.quotas) {
    const st = quotaStatus(q)
    if (st > worst) worst = st
  }
  return worst
}

export function lowestQuota(s: UsageSnapshot): UsageQuota | null {
  let lowest: UsageQuota | null = null
  for (const q of s.quotas) {
    if (lowest === null || q.percentRemaining < lowest.percentRemaining) lowest = q
  }
  return lowest
}

export function snapshotAgeMs(s: UsageSnapshot, nowMs: number = Date.now()): number {
  return nowMs - s.capturedAt
}

export function isSnapshotStale(s: UsageSnapshot, nowMs: number = Date.now()): boolean {
  return snapshotAgeMs(s, nowMs) > 300_000
}
