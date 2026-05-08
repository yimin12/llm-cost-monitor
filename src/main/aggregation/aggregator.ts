import type {
  AggregateSnapshot,
  CostByModel,
  CostByProject,
  CostByProvider,
  MonthlyForecast,
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

export function startOfMonthMs(now: Date = new Date()): number {
  const d = new Date(now)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function daysInMonth(now: Date = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
}

export class Aggregator {
  private readonly rangeStmt
  private readonly providerRangeStmt
  private readonly modelRangeStmt
  private readonly projectRangeStmt
  private readonly perDayStmt

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
    // Per-day rollup over a window. Day key uses local-tz day index by flooring
    // (timestamp - tz_offset_ms) to a 24h boundary; we let SQLite group on the
    // computed bucket. The bucket math lives in JS and is passed in as @bucket.
    this.perDayStmt = db.prepare<
      { start: number; end: number; bucket: number },
      { day_idx: bigint; cost: bigint }
    >(`
      SELECT (timestamp / @bucket) AS day_idx,
             COALESCE(SUM(computed_cost_micro_usd), 0) AS cost
      FROM events
      WHERE timestamp >= @start AND timestamp < @end
      GROUP BY day_idx
      ORDER BY day_idx ASC
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

  // Per-day cost rollup (micro-USD) over [startMs, endMs). Returns one entry
  // per day that has at least one event.
  perDayCost(startMs: number, endMs: number): bigint[] {
    const dayMs = 24 * 60 * 60 * 1000
    return this.perDayStmt
      .all({ start: startMs, end: endMs, bucket: dayMs })
      .map((r) => readBigint(r.cost))
  }

  // Linear month-end forecast with a 1σ confidence band.
  // Returns null if < 3 days of data in the month (under-determined).
  forecast(now: Date = new Date()): MonthlyForecast | null {
    const monthStart = startOfMonthMs(now)
    const todayStart = startOfDayMs(now)
    const todayEnd = todayStart + 24 * 60 * 60 * 1000
    const dim = daysInMonth(now)
    const daysElapsed = Math.floor((todayEnd - monthStart) / (24 * 60 * 60 * 1000))

    const perDay = this.perDayCost(monthStart, todayEnd)
    if (perDay.length < 3) return null

    let spent = 0n
    for (const c of perDay) spent += c

    const estimate =
      daysElapsed > 0
        ? (spent * BigInt(dim)) / BigInt(daysElapsed)
        : 0n

    // Stddev over per-day costs. Compute in number-space for sqrt; precision is
    // fine for the band since it's already a guess. Convert back to bigint.
    const perDayN = perDay.map((b) => Number(b))
    const mean = perDayN.reduce((a, b) => a + b, 0) / perDayN.length
    const variance =
      perDayN.reduce((acc, x) => acc + (x - mean) ** 2, 0) / perDayN.length
    const stddev = Math.sqrt(variance)
    const remainingDays = Math.max(0, dim - daysElapsed)
    // Wilson-ish band: 1σ × sqrt(remaining_days). One-sided width.
    const bandFloat = stddev * Math.sqrt(remainingDays)
    const band = BigInt(Math.round(bandFloat))

    return {
      monthStartMs: monthStart,
      daysElapsed,
      daysInMonth: dim,
      spentMicroUsd: spent,
      estimateMicroUsd: estimate,
      confidenceBandMicroUsd: band,
    }
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
      forecast: this.forecast(now),
    }
  }
}
