import type {
  AggregateSnapshot,
  CostByModel,
  CostByProject,
  CostByProvider,
  MonthlyForecast,
  RangeTotal,
  SessionRow,
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

const DAY_MS = 24 * 60 * 60 * 1000
const DAILY_SERIES_DAYS = 14
const RECENT_SESSIONS_LIMIT = 50

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
  // per day that has at least one event. Day index is computed relative to
  // `originMs` so late-evening local events don't spill into the next UTC day.
  async perDayCost(
    startMs: number,
    endMs: number,
    originMs: number = 0,
  ): Promise<{ dayIdx: number; cost: bigint }[]> {
    const q = namedQuery(
      `SELECT FLOOR((timestamp - @origin) / @bucket)::bigint AS day_idx,
              COALESCE(SUM(computed_cost_micro_usd), 0)::bigint AS cost
       FROM events
       WHERE timestamp >= @start AND timestamp < @end
       GROUP BY day_idx
       ORDER BY day_idx ASC`,
      {
        start: BigInt(startMs),
        end: BigInt(endMs),
        bucket: BigInt(DAY_MS),
        origin: BigInt(originMs),
      },
    )
    const r = await this.pool.query<{ day_idx: bigint; cost: bigint }>(q.text, q.values)
    return r.rows.map((row) => ({
      dayIdx: Number(row.day_idx),
      cost: readBigint(row.cost),
    }))
  }

  // Dense daily-cost series over the last `days` calendar days, oldest first;
  // today is the last entry. Days with no events are 0n. Local-tz aware.
  async dailySeries(days: number, now: Date = new Date()): Promise<bigint[]> {
    const todayStart = startOfDayMs(now)
    const start = todayStart - (days - 1) * DAY_MS
    const end = todayStart + DAY_MS
    const out = new Array<bigint>(days).fill(0n)
    const rows = await this.perDayCost(start, end, start)
    for (const row of rows) {
      if (row.dayIdx >= 0 && row.dayIdx < days) {
        out[row.dayIdx] = row.cost
      }
    }
    return out
  }

  // Most recent activity per provider. Drives the Providers tab "last seen"
  // column. Providers with zero events are absent from the result.
  async providerLastSeen(): Promise<Record<string, number>> {
    const r = await this.pool.query<{ provider: string; last_at: bigint }>(
      `SELECT provider, MAX(timestamp)::bigint AS last_at
       FROM events
       GROUP BY provider`,
    )
    const out: Record<string, number> = {}
    for (const row of r.rows) out[row.provider] = Number(row.last_at)
    return out
  }

  // Most-recent N sessions, grouped by (provider, session_id) so the same
  // session_id can never collide across providers. Events without a
  // session_id are excluded since they don't belong to a session.
  async recentSessions(limit: number): Promise<SessionRow[]> {
    const q = namedQuery(
      // project is folded with MAX() — within one (provider, session_id) the
      // project string is effectively constant; MAX picks a deterministic
      // representative without requiring it in the GROUP BY clause.
      `SELECT session_id,
              provider,
              COALESCE(MAX(project), '(none)') AS project,
              COALESCE(SUM(computed_cost_micro_usd), 0)::bigint AS cost,
              COUNT(*)::bigint AS n,
              MIN(timestamp)::bigint AS first_at,
              MAX(timestamp)::bigint AS last_at
       FROM events
       WHERE session_id IS NOT NULL
       GROUP BY provider, session_id
       ORDER BY last_at DESC
       LIMIT @limit`,
      { limit },
    )
    const r = await this.pool.query<{
      session_id: string
      provider: string
      project: string | null
      cost: bigint
      n: bigint
      first_at: bigint
      last_at: bigint
    }>(q.text, q.values)
    return r.rows.map((row) => ({
      sessionId: row.session_id,
      provider: row.provider,
      project: row.project ?? '(none)',
      costMicroUsd: readBigint(row.cost),
      eventCount: readCount(row.n),
      firstAt: Number(row.first_at),
      lastAt: Number(row.last_at),
    }))
  }

  // Per-day cost rollup grouped by provider. Drives forecastByProvider.
  // Same day-bucketing convention as perDayCost.
  private async perDayCostByProvider(
    startMs: number,
    endMs: number,
    originMs: number,
  ): Promise<Map<string, bigint[]>> {
    const q = namedQuery(
      `SELECT provider,
              FLOOR((timestamp - @origin) / @bucket)::bigint AS day_idx,
              COALESCE(SUM(computed_cost_micro_usd), 0)::bigint AS cost
       FROM events
       WHERE timestamp >= @start AND timestamp < @end
       GROUP BY provider, day_idx
       ORDER BY provider, day_idx ASC`,
      {
        start: BigInt(startMs),
        end: BigInt(endMs),
        bucket: BigInt(DAY_MS),
        origin: BigInt(originMs),
      },
    )
    const r = await this.pool.query<{ provider: string; day_idx: bigint; cost: bigint }>(
      q.text,
      q.values,
    )
    const out = new Map<string, bigint[]>()
    for (const row of r.rows) {
      const list = out.get(row.provider) ?? []
      list.push(readBigint(row.cost))
      out.set(row.provider, list)
    }
    return out
  }

  // Per-provider month-end forecast. Mirrors `forecast` but partitioned by
  // provider — only providers with ≥3 active days in the month appear.
  async forecastByProvider(now: Date = new Date()): Promise<Record<string, MonthlyForecast>> {
    const monthStart = startOfMonthMs(now)
    const todayStart = startOfDayMs(now)
    const todayEnd = todayStart + DAY_MS
    const dim = daysInMonth(now)
    const daysElapsed = Math.floor((todayEnd - monthStart) / DAY_MS)
    const byProvider = await this.perDayCostByProvider(monthStart, todayEnd, monthStart)

    const out: Record<string, MonthlyForecast> = {}
    for (const [provider, perDay] of byProvider) {
      if (perDay.length < 3) continue
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
      const band = BigInt(Math.round(stddev * Math.sqrt(remainingDays)))
      out[provider] = {
        monthStartMs: monthStart,
        daysElapsed,
        daysInMonth: dim,
        spentMicroUsd: spent,
        estimateMicroUsd: estimate,
        confidenceBandMicroUsd: band,
      }
    }
    return out
  }

  // Linear month-end forecast with a 1σ confidence band.
  // Returns null if < 3 days of data in the month (under-determined).
  async forecast(now: Date = new Date()): Promise<MonthlyForecast | null> {
    const monthStart = startOfMonthMs(now)
    const todayStart = startOfDayMs(now)
    const todayEnd = todayStart + DAY_MS
    const dim = daysInMonth(now)
    const daysElapsed = Math.floor((todayEnd - monthStart) / DAY_MS)

    const perDay = (await this.perDayCost(monthStart, todayEnd)).map((r) => r.cost)
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
    const todayEnd = todayStart + DAY_MS
    const sevenDayStart = todayEnd - 7 * DAY_MS
    const thirtyDayStart = todayEnd - 30 * DAY_MS
    const sixMonthStart = todayEnd - 180 * DAY_MS
    const oneYearStart = todayEnd - 365 * DAY_MS

    const [
      today,
      last7d,
      last30d,
      last6m,
      last1y,
      byProviderToday,
      byProvider30d,
      byProvider6m,
      byProvider1y,
      topModelsToday,
      topProjectsToday,
      forecast,
      dailyCostMicroUsd,
      providerLastSeen,
      recentSessions,
      forecastByProvider,
    ] = await Promise.all([
      this.rangeTotal(todayStart, todayEnd),
      this.rangeTotal(sevenDayStart, todayEnd),
      this.rangeTotal(thirtyDayStart, todayEnd),
      this.rangeTotal(sixMonthStart, todayEnd),
      this.rangeTotal(oneYearStart, todayEnd),
      this.byProvider(todayStart, todayEnd),
      this.byProvider(thirtyDayStart, todayEnd),
      this.byProvider(sixMonthStart, todayEnd),
      this.byProvider(oneYearStart, todayEnd),
      this.topModels(todayStart, todayEnd, 5),
      this.topProjects(todayStart, todayEnd, 5),
      this.forecast(now),
      this.dailySeries(DAILY_SERIES_DAYS, now),
      this.providerLastSeen(),
      this.recentSessions(RECENT_SESSIONS_LIMIT),
      this.forecastByProvider(now),
    ])

    return {
      generatedAt: now.getTime(),
      today,
      last7d,
      last30d,
      last6m,
      last1y,
      byProviderToday,
      byProvider30d,
      byProvider6m,
      byProvider1y,
      topModelsToday,
      topProjectsToday,
      forecast,
      forecastByProvider,
      dailyCostMicroUsd,
      providerLastSeen,
      recentSessions,
    }
  }
}
