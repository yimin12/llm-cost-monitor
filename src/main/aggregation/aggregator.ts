import type {
  AggregateSnapshot,
  CostByModel,
  CostByProject,
  CostByProvider,
  RangeTotal,
} from '@shared/aggregates'
import type { DatabaseHandle } from '../storage/db'

interface RangeRow {
  cost: bigint | null
  input_tokens: bigint | null
  output_tokens: bigint | null
  cache_read_tokens: bigint | null
  cache_creation_5m: bigint | null
  cache_creation_1h: bigint | null
  reasoning_tokens: bigint | null
  n: bigint
}

function readBigint(v: bigint | null | undefined): bigint {
  return v ?? 0n
}

function readCount(v: bigint | null | undefined): number {
  return Number(v ?? 0n)
}

// Boundary helpers — `start of today` in local time, etc. We use ms epoch
// throughout; the conversion to "today/yesterday" is local-tz-aware.
export function startOfDayMs(now: Date = new Date()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export class Aggregator {
  private readonly rangeStmt
  private readonly providerRangeStmt
  private readonly modelRangeStmt
  private readonly projectRangeStmt

  constructor(private readonly db: DatabaseHandle) {
    const rangeColumns = `
      COALESCE(SUM(computed_cost_micro_usd), 0) AS cost,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_creation_5m_tokens), 0) AS cache_creation_5m,
      COALESCE(SUM(cache_creation_1h_tokens), 0) AS cache_creation_1h,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COUNT(*) AS n
    `
    this.rangeStmt = db.prepare<{ start: number; end: number }, RangeRow>(`
      SELECT ${rangeColumns}
      FROM events
      WHERE timestamp >= @start AND timestamp < @end
    `)
    this.providerRangeStmt = db.prepare<
      { start: number; end: number },
      { provider: string; cost: bigint; n: bigint }
    >(`
      SELECT provider,
             COALESCE(SUM(computed_cost_micro_usd), 0) AS cost,
             COUNT(*) AS n
      FROM events
      WHERE timestamp >= @start AND timestamp < @end
      GROUP BY provider
      ORDER BY cost DESC
    `)
    this.modelRangeStmt = db.prepare<
      { start: number; end: number; limit: number },
      { model: string; provider: string; cost: bigint; n: bigint }
    >(`
      SELECT model, provider,
             COALESCE(SUM(computed_cost_micro_usd), 0) AS cost,
             COUNT(*) AS n
      FROM events
      WHERE timestamp >= @start AND timestamp < @end
      GROUP BY model, provider
      ORDER BY cost DESC
      LIMIT @limit
    `)
    this.projectRangeStmt = db.prepare<
      { start: number; end: number; limit: number },
      { project: string | null; cost: bigint; n: bigint }
    >(`
      SELECT project,
             COALESCE(SUM(computed_cost_micro_usd), 0) AS cost,
             COUNT(*) AS n
      FROM events
      WHERE timestamp >= @start AND timestamp < @end
      GROUP BY project
      ORDER BY cost DESC
      LIMIT @limit
    `)
  }

  rangeTotal(startMs: number, endMs: number): RangeTotal {
    const row = this.rangeStmt.get({ start: startMs, end: endMs })
    if (row === undefined) {
      return {
        costMicroUsd: 0n,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        eventCount: 0,
      }
    }
    return {
      costMicroUsd: readBigint(row.cost),
      inputTokens: readCount(row.input_tokens),
      outputTokens: readCount(row.output_tokens),
      cacheReadTokens: readCount(row.cache_read_tokens),
      cacheCreationTokens:
        readCount(row.cache_creation_5m) + readCount(row.cache_creation_1h),
      reasoningTokens: readCount(row.reasoning_tokens),
      eventCount: readCount(row.n),
    }
  }

  byProvider(startMs: number, endMs: number): CostByProvider[] {
    return this.providerRangeStmt.all({ start: startMs, end: endMs }).map((r) => ({
      provider: r.provider,
      costMicroUsd: readBigint(r.cost),
      eventCount: readCount(r.n),
    }))
  }

  topModels(startMs: number, endMs: number, limit: number): CostByModel[] {
    return this.modelRangeStmt
      .all({ start: startMs, end: endMs, limit })
      .map((r) => ({
        model: r.model,
        provider: r.provider,
        costMicroUsd: readBigint(r.cost),
        eventCount: readCount(r.n),
      }))
  }

  topProjects(startMs: number, endMs: number, limit: number): CostByProject[] {
    return this.projectRangeStmt
      .all({ start: startMs, end: endMs, limit })
      .map((r) => ({
        project: r.project ?? '(none)',
        costMicroUsd: readBigint(r.cost),
        eventCount: readCount(r.n),
      }))
  }

  snapshot(now: Date = new Date()): AggregateSnapshot {
    const todayStart = startOfDayMs(now)
    const todayEnd = todayStart + 24 * 60 * 60 * 1000
    const sevenDayStart = todayEnd - 7 * 24 * 60 * 60 * 1000
    const thirtyDayStart = todayEnd - 30 * 24 * 60 * 60 * 1000

    return {
      generatedAt: now.getTime(),
      today: this.rangeTotal(todayStart, todayEnd),
      last7d: this.rangeTotal(sevenDayStart, todayEnd),
      last30d: this.rangeTotal(thirtyDayStart, todayEnd),
      byProviderToday: this.byProvider(todayStart, todayEnd),
      byProvider30d: this.byProvider(thirtyDayStart, todayEnd),
      topModelsToday: this.topModels(todayStart, todayEnd, 5),
      topProjectsToday: this.topProjects(todayStart, todayEnd, 5),
    }
  }
}
