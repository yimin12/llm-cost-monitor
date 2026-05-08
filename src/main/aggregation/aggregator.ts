import type {
  AggregateSnapshot,
  CostByModel,
  CostByProject,
  CostByProvider,
  MonthlyForecast,
  RangeTotal,
} from '@shared/aggregates'
import type { Pool } from '../storage/connect'
import { namedQuery } from '../storage/db-utils'

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

// Postgres returns SUM(BIGINT) as NUMERIC by default (and `pg` returns NUMERIC
// as string). Cast back to BIGINT so our typeparser yields bigint. Overflow
// risk is theoretical at our scale: max micro-USD per event ≈ 1e9, billions of
// events would still fit in 2^63.
const RANGE_COLUMNS = `
  COALESCE(SUM(computed_cost_micro_usd), 0)::bigint AS cost,
  COALESCE(SUM(input_tokens), 0)::bigint            AS input_tokens,
  COALESCE(SUM(output_tokens), 0)::bigint           AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0)::bigint       AS cache_read_tokens,
  COALESCE(SUM(cache_creation_5m_tokens), 0)::bigint AS cache_creation_5m,
  COALESCE(SUM(cache_creation_1h_tokens), 0)::bigint AS cache_creation_1h,
  COALESCE(SUM(reasoning_tokens), 0)::bigint        AS reasoning_tokens,
  COUNT(*)::bigint                                  AS n
`

export class Aggregator {
  constructor(private readonly pool: Pool) {}

  async rangeTotal(startMs: number, endMs: number): Promise<RangeTotal> {
    const q = namedQuery(
      `SELECT ${RANGE_COLUMNS}
       FROM events
       WHERE timestamp >= @start AND timestamp < @end`,
      { start: BigInt(startMs), end: BigInt(endMs) },
    )
    const r = await this.pool.query<RangeRow>(q.text, q.values)
    const row = r.rows[0]
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

  async byProvider(startMs: number, endMs: number): Promise<CostByProvider[]> {
    const q = namedQuery(
      `SELECT provider,
              COALESCE(SUM(computed_cost_micro_usd), 0)::bigint AS cost,
              COUNT(*)::bigint AS n
       FROM events
       WHERE timestamp >= @start AND timestamp < @end
       GROUP BY provider
       ORDER BY cost DESC`,
      { start: BigInt(startMs), end: BigInt(endMs) },
    )
    const r = await this.pool.query<{ provider: string; cost: bigint; n: bigint }>(
      q.text,
      q.values,
    )
    return r.rows.map((row) => ({
      provider: row.provider,
      costMicroUsd: readBigint(row.cost),
      eventCount: readCount(row.n),
    }))
  }

  async topModels(startMs: number, endMs: number, limit: number): Promise<CostByModel[]> {
    const q = namedQuery(
      `SELECT model, provider,
              COALESCE(SUM(computed_cost_micro_usd), 0)::bigint AS cost,
              COUNT(*)::bigint AS n
       FROM events
       WHERE timestamp >= @start AND timestamp < @end
       GROUP BY model, provider
       ORDER BY cost DESC
       LIMIT @limit`,
      { start: BigInt(startMs), end: BigInt(endMs), limit },
    )
    const r = await this.pool.query<{
      model: string
      provider: string
      cost: bigint
      n: bigint
    }>(q.text, q.values)
    return r.rows.map((row) => ({
      model: row.model,
      provider: row.provider,
      costMicroUsd: readBigint(row.cost),
      eventCount: readCount(row.n),
    }))
  }

  async topProjects(
    startMs: number,
    endMs: number,
    limit: number,
  ): Promise<CostByProject[]> {
    const q = namedQuery(
      `SELECT project,
              COALESCE(SUM(computed_cost_micro_usd), 0)::bigint AS cost,
              COUNT(*)::bigint AS n
       FROM events
       WHERE timestamp >= @start AND timestamp < @end
       GROUP BY project
       ORDER BY cost DESC
       LIMIT @limit`,
      { start: BigInt(startMs), end: BigInt(endMs), limit },
    )
    const r = await this.pool.query<{
      project: string | null
      cost: bigint
      n: bigint
    }>(q.text, q.values)
    return r.rows.map((row) => ({
      project: row.project ?? '(none)',
      costMicroUsd: readBigint(row.cost),
      eventCount: readCount(row.n),
    }))
  }

  // Per-day cost rollup (micro-USD) over [startMs, endMs). Returns one entry
  // per day that has at least one event.
  async perDayCost(startMs: number, endMs: number): Promise<bigint[]> {
    const dayMs = 24 * 60 * 60 * 1000
    const q = namedQuery(
      `SELECT (timestamp / @bucket) AS day_idx,
              COALESCE(SUM(computed_cost_micro_usd), 0)::bigint AS cost
       FROM events
       WHERE timestamp >= @start AND timestamp < @end
       GROUP BY day_idx
       ORDER BY day_idx ASC`,
      { start: BigInt(startMs), end: BigInt(endMs), bucket: BigInt(dayMs) },
    )
    const r = await this.pool.query<{ day_idx: bigint; cost: bigint }>(q.text, q.values)
    return r.rows.map((row) => readBigint(row.cost))
  }

  // Linear month-end forecast with a 1σ confidence band.
  // Returns null if < 3 days of data in the month (under-determined).
  async forecast(now: Date = new Date()): Promise<MonthlyForecast | null> {
    const monthStart = startOfMonthMs(now)
    const todayStart = startOfDayMs(now)
    const todayEnd = todayStart + 24 * 60 * 60 * 1000
    const dim = daysInMonth(now)
    const daysElapsed = Math.floor((todayEnd - monthStart) / (24 * 60 * 60 * 1000))

    const perDay = await this.perDayCost(monthStart, todayEnd)
    if (perDay.length < 3) return null

    let spent = 0n
    for (const c of perDay) spent += c

    const estimate =
      daysElapsed > 0 ? (spent * BigInt(dim)) / BigInt(daysElapsed) : 0n

    const perDayN = perDay.map((b) => Number(b))
    const mean = perDayN.reduce((a, b) => a + b, 0) / perDayN.length
    const variance =
      perDayN.reduce((acc, x) => acc + (x - mean) ** 2, 0) / perDayN.length
    const stddev = Math.sqrt(variance)
    const remainingDays = Math.max(0, dim - daysElapsed)
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

  async snapshot(now: Date = new Date()): Promise<AggregateSnapshot> {
    const todayStart = startOfDayMs(now)
    const todayEnd = todayStart + 24 * 60 * 60 * 1000
    const sevenDayStart = todayEnd - 7 * 24 * 60 * 60 * 1000
    const thirtyDayStart = todayEnd - 30 * 24 * 60 * 60 * 1000

    const [today, last7d, last30d, byProviderToday, byProvider30d, topModelsToday, topProjectsToday, forecast] =
      await Promise.all([
        this.rangeTotal(todayStart, todayEnd),
        this.rangeTotal(sevenDayStart, todayEnd),
        this.rangeTotal(thirtyDayStart, todayEnd),
        this.byProvider(todayStart, todayEnd),
        this.byProvider(thirtyDayStart, todayEnd),
        this.topModels(todayStart, todayEnd, 5),
        this.topProjects(todayStart, todayEnd, 5),
        this.forecast(now),
      ])

    return {
      generatedAt: now.getTime(),
      today,
      last7d,
      last30d,
      byProviderToday,
      byProvider30d,
      topModelsToday,
      topProjectsToday,
      forecast,
    }
  }
}
