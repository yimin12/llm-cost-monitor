import { beforeEach, describe, expect, it } from 'vitest'

import type { UsageEvent } from '@shared/usage-event'
import { openDatabase, type DatabaseHandle } from '../../storage/db'
import { EventRepository } from '../../storage/event-repository'
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

describe('Aggregator', () => {
  let db: DatabaseHandle
  let repo: EventRepository
  let agg: Aggregator
  const now = new Date('2026-05-06T10:00:00.000Z')
  const todayStart = startOfDayMs(now)

  beforeEach(() => {
    db = openDatabase(':memory:')
    repo = new EventRepository(db)
    agg = new Aggregator(db)
  })

  it('rangeTotal sums cost + tokens within window', () => {
    repo.upsertMany([
      makeEvent({ id: '1', timestamp: todayStart + 1000, computedCostMicroUsd: 1000n, inputTokens: 100, outputTokens: 50 }),
      makeEvent({ id: '2', timestamp: todayStart + 2000, computedCostMicroUsd: 2000n, inputTokens: 200, outputTokens: 100 }),
    ])
    const t = agg.rangeTotal(todayStart, todayStart + 24 * 3_600_000)
    expect(t.costMicroUsd).toBe(3000n)
    expect(t.inputTokens).toBe(300)
    expect(t.outputTokens).toBe(150)
    expect(t.eventCount).toBe(2)
  })

  it('byProvider groups by provider id, sorted by cost desc', () => {
    repo.upsertMany([
      makeEvent({ id: '1', timestamp: todayStart + 1000, provider: 'anthropic', computedCostMicroUsd: 5000n }),
      makeEvent({ id: '2', timestamp: todayStart + 1000, provider: 'openai', computedCostMicroUsd: 1000n }),
      makeEvent({ id: '3', timestamp: todayStart + 1000, provider: 'google', computedCostMicroUsd: 3000n }),
    ])
    const rows = agg.byProvider(todayStart, todayStart + 24 * 3_600_000)
    expect(rows.map((r) => r.provider)).toEqual(['anthropic', 'google', 'openai'])
    expect(rows.map((r) => r.costMicroUsd)).toEqual([5000n, 3000n, 1000n])
  })

  it('snapshot covers today/7d/30d ranges with consistent boundaries', () => {
    const sixDaysAgo = todayStart - 6 * 24 * 3_600_000
    const eightDaysAgo = todayStart - 8 * 24 * 3_600_000
    const twentyDaysAgo = todayStart - 20 * 24 * 3_600_000
    repo.upsertMany([
      makeEvent({ id: 'today', timestamp: todayStart + 1000, computedCostMicroUsd: 1000n }),
      makeEvent({ id: '6d', timestamp: sixDaysAgo + 1000, computedCostMicroUsd: 2000n }),
      makeEvent({ id: '8d', timestamp: eightDaysAgo + 1000, computedCostMicroUsd: 4000n }),
      makeEvent({ id: '20d', timestamp: twentyDaysAgo + 1000, computedCostMicroUsd: 8000n }),
    ])
    const snap = agg.snapshot(now)
    expect(snap.today.costMicroUsd).toBe(1000n)
    // 7d window includes today + 6d but not 8d.
    expect(snap.last7d.costMicroUsd).toBe(3000n)
    // 30d covers all four.
    expect(snap.last30d.costMicroUsd).toBe(15000n)
  })
})
