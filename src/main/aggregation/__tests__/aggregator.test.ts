import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { UsageEvent } from '@shared/usage-event'
import type { Pool } from '../../storage/connect'
import { EventRepository } from '../../storage/event-repository'
import { createTestDatabase, dropTestDatabase } from '../../storage/__tests__/test-helpers'
import { Aggregator, startOfDayMs } from '../aggregator'

function makeEvent(partial: Pick<UsageEvent, 'id' | 'timestamp'> & Partial<UsageEvent>): UsageEvent {
  const { id, timestamp, ...rest } = partial
  return {
    id,
    provider: 'anthropic',
    providerRawTag: null,
    model: 'claude-3-5-sonnet-20240620',
    timestamp,
    project: 'demo',
    projectRawSlug: '-demo',
    sessionId: null,
    messageId: null,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    reasoningTokens: null,
    toolCallCount: null,
    latencyMs: null,
    computedCostMicroUsd: 1000n,
    pricingSnapshotVersion: 'test',
    sourceFile: '',
    sourceLineOffset: 0,
    ...rest,
  }
}

describe('Aggregator (Postgres)', () => {
  let pool: Pool
  let dbName: string
  let repo: EventRepository
  let agg: Aggregator
  const now = new Date('2026-05-06T10:00:00.000Z')
  const todayStart = startOfDayMs(now)

  beforeAll(async () => {
    const ctx = await createTestDatabase()
    pool = ctx.pool
    dbName = ctx.dbName
  }, 30_000)

  afterAll(async () => {
    await dropTestDatabase(pool, dbName)
  })

  beforeEach(async () => {
    // CASCADE because sync_outbox has a FK on events.id (slice 6).
    await pool.query('TRUNCATE TABLE events CASCADE')
    repo = new EventRepository(pool)
    agg = new Aggregator(pool)
  })

  it('rangeTotal sums cost + tokens within window', async () => {
    await repo.upsertMany([
      makeEvent({ id: '1', timestamp: todayStart + 1000, computedCostMicroUsd: 1000n, inputTokens: 100, outputTokens: 50 }),
      makeEvent({ id: '2', timestamp: todayStart + 2000, computedCostMicroUsd: 2000n, inputTokens: 200, outputTokens: 100 }),
    ])
    const t = await agg.rangeTotal(todayStart, todayStart + 24 * 3_600_000)
    expect(t.costMicroUsd).toBe(3000n)
    expect(t.inputTokens).toBe(300)
    expect(t.outputTokens).toBe(150)
    expect(t.eventCount).toBe(2)
  })

  it('byProvider groups by provider id, sorted by cost desc', async () => {
    await repo.upsertMany([
      makeEvent({ id: '1', timestamp: todayStart + 1000, provider: 'anthropic', computedCostMicroUsd: 5000n }),
      makeEvent({ id: '2', timestamp: todayStart + 1000, provider: 'openai', computedCostMicroUsd: 1000n }),
      makeEvent({ id: '3', timestamp: todayStart + 1000, provider: 'google', computedCostMicroUsd: 3000n }),
    ])
    const rows = await agg.byProvider(todayStart, todayStart + 24 * 3_600_000)
    expect(rows.map((r) => r.provider)).toEqual(['anthropic', 'google', 'openai'])
    expect(rows.map((r) => r.costMicroUsd)).toEqual([5000n, 3000n, 1000n])
  })

  it('forecast returns null when fewer than 3 days of data', async () => {
    await repo.upsertMany([
      makeEvent({ id: '1', timestamp: todayStart, computedCostMicroUsd: 1000n }),
      makeEvent({ id: '2', timestamp: todayStart - 86_400_000, computedCostMicroUsd: 2000n }),
    ])
    expect(await agg.forecast(now)).toBeNull()
  })

  it('forecast linearly projects MTD to month-end', async () => {
    const may1 = new Date('2026-05-01T12:00:00.000Z')
    const may1Start = startOfDayMs(may1)
    const eventsList = []
    for (let d = 0; d < 6; d++) {
      eventsList.push(
        makeEvent({
          id: `d${d}`,
          timestamp: may1Start + d * 86_400_000 + 1000,
          computedCostMicroUsd: 1_000_000n,
        }),
      )
    }
    await repo.upsertMany(eventsList)
    const sim = new Date('2026-05-06T12:00:00.000Z')
    const f = await agg.forecast(sim)
    expect(f).not.toBeNull()
    if (f === null) return
    expect(f.daysInMonth).toBe(31)
    expect(f.daysElapsed).toBe(6)
    expect(f.spentMicroUsd).toBe(6_000_000n)
    expect(f.estimateMicroUsd).toBe(31_000_000n)
    expect(f.confidenceBandMicroUsd).toBe(0n)
  })

  it('dailySeries returns dense local-calendar days, oldest first', async () => {
    await repo.upsertMany([
      makeEvent({
        id: 'start',
        timestamp: todayStart - 2 * 86_400_000 + 1000,
        computedCostMicroUsd: 1000n,
      }),
      makeEvent({
        id: 'today-am',
        timestamp: todayStart + 1000,
        computedCostMicroUsd: 2000n,
      }),
      makeEvent({
        id: 'today-late',
        timestamp: todayStart + 23 * 3_600_000,
        computedCostMicroUsd: 3000n,
      }),
    ])

    expect(await agg.dailySeries(3, now)).toEqual([1000n, 0n, 5000n])
    const snap = await agg.snapshot(now)
    expect(snap.dailyCostMicroUsd).toHaveLength(365)
  })

  it('providerLastSeen returns MAX(timestamp) per provider', async () => {
    await repo.upsertMany([
      makeEvent({ id: 'a1', timestamp: todayStart + 1000, provider: 'anthropic' }),
      makeEvent({ id: 'a2', timestamp: todayStart + 5000, provider: 'anthropic' }),
      makeEvent({ id: 'o1', timestamp: todayStart + 2000, provider: 'openai' }),
    ])
    const seen = await agg.providerLastSeen()
    expect(seen['anthropic']).toBe(todayStart + 5000)
    expect(seen['openai']).toBe(todayStart + 2000)
    expect(seen['google']).toBeUndefined()
  })

  it('recentSessions groups by (provider, session_id), ordered by lastAt desc', async () => {
    await repo.upsertMany([
      // Session A: anthropic, 2 events spanning 5 minutes
      makeEvent({ id: 'a1', timestamp: todayStart + 1_000, sessionId: 'sess-A', provider: 'anthropic', computedCostMicroUsd: 1000n }),
      makeEvent({ id: 'a2', timestamp: todayStart + 301_000, sessionId: 'sess-A', provider: 'anthropic', computedCostMicroUsd: 2000n }),
      // Session B: openai, single event much later → should sort first
      makeEvent({ id: 'b1', timestamp: todayStart + 600_000, sessionId: 'sess-B', provider: 'openai', computedCostMicroUsd: 5000n }),
      // Event with no session_id — must be excluded
      makeEvent({ id: 'n1', timestamp: todayStart + 1000, sessionId: null, provider: 'google' }),
    ])
    const sessions = await agg.recentSessions(50)
    expect(sessions).toHaveLength(2)
    expect(sessions[0]!.sessionId).toBe('sess-B')
    expect(sessions[0]!.provider).toBe('openai')
    expect(sessions[0]!.eventCount).toBe(1)
    expect(sessions[1]!.sessionId).toBe('sess-A')
    expect(sessions[1]!.eventCount).toBe(2)
    expect(sessions[1]!.costMicroUsd).toBe(3000n)
    expect(sessions[1]!.firstAt).toBe(todayStart + 1_000)
    expect(sessions[1]!.lastAt).toBe(todayStart + 301_000)
  })

  it('recentSessions respects limit', async () => {
    const eventsList = []
    for (let i = 0; i < 5; i++) {
      eventsList.push(
        makeEvent({
          id: `s${i}`,
          timestamp: todayStart + i * 1000,
          sessionId: `sess-${i}`,
          computedCostMicroUsd: 1000n,
        }),
      )
    }
    await repo.upsertMany(eventsList)
    expect(await agg.recentSessions(2)).toHaveLength(2)
    expect(await agg.recentSessions(10)).toHaveLength(5)
  })

  it('snapshot covers today/7d/30d ranges with consistent boundaries', async () => {
    const sixDaysAgo = todayStart - 6 * 24 * 3_600_000
    const eightDaysAgo = todayStart - 8 * 24 * 3_600_000
    const twentyDaysAgo = todayStart - 20 * 24 * 3_600_000
    await repo.upsertMany([
      makeEvent({ id: 'today', timestamp: todayStart + 1000, computedCostMicroUsd: 1000n }),
      makeEvent({ id: '6d', timestamp: sixDaysAgo + 1000, computedCostMicroUsd: 2000n }),
      makeEvent({ id: '8d', timestamp: eightDaysAgo + 1000, computedCostMicroUsd: 4000n }),
      makeEvent({ id: '20d', timestamp: twentyDaysAgo + 1000, computedCostMicroUsd: 8000n }),
    ])
    const snap = await agg.snapshot(now)
    expect(snap.today.costMicroUsd).toBe(1000n)
    expect(snap.last7d.costMicroUsd).toBe(3000n)
    expect(snap.last30d.costMicroUsd).toBe(15000n)
  })
})
