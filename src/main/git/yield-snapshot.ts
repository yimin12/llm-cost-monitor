import type { YieldScoreSnapshot } from '@shared/ipc-channels'

import type { Aggregator } from '../aggregation/aggregator'
import type { SettingsStore } from '../settings/store'
import { scanYield } from './git-scanner'

// Build the YieldScoreSnapshot the IPC handler + the loopback HTTP
// server both return. Kept in one place so the wire shape and the
// "track-git-activity off → empty snapshot" branch can't drift apart.

export type YieldPeriod = '7d' | '30d' | '90d'

const PERIOD_MS: Record<YieldPeriod, number> = {
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
  '90d': 90 * 24 * 3600_000,
}

export interface YieldSnapshotDeps {
  aggregator: Aggregator
  settings: SettingsStore
}

export async function buildYieldSnapshot(
  deps: YieldSnapshotDeps,
  period: YieldPeriod = '30d',
): Promise<YieldScoreSnapshot> {
  const now = Date.now()
  const windowStartMs = now - PERIOD_MS[period]
  const enabled = deps.settings.get().privacy?.trackGitActivity === true
  if (!enabled) {
    return {
      period,
      windowStartMs,
      generatedAt: now,
      durationMs: 0,
      totalCommits: 0,
      totalMerges: 0,
      costMicroUsd: '0',
      microPerCommit: null,
      repos: [],
      enabled: false,
    }
  }
  const [scan, total] = await Promise.all([
    scanYield(windowStartMs),
    deps.aggregator.rangeTotal(windowStartMs, now),
  ])
  const microPerCommit =
    scan.totalCommits > 0
      ? (total.costMicroUsd / BigInt(scan.totalCommits)).toString()
      : null
  return {
    period,
    windowStartMs,
    generatedAt: scan.scannedAt,
    durationMs: scan.durationMs,
    totalCommits: scan.totalCommits,
    totalMerges: scan.totalMerges,
    costMicroUsd: total.costMicroUsd.toString(),
    microPerCommit,
    repos: scan.repos,
    enabled: true,
  }
}
