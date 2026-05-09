import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { UsageEvent } from '@shared/usage-event'
import type { Pool } from '../connect'
import { EventRepository } from '../event-repository'
import { createTestDatabase, dropTestDatabase } from './test-helpers'

function makeEvent({ id, ...partial }: Partial<UsageEvent> & Pick<UsageEvent, 'id'>): UsageEvent {
  return {
    id,
    provider: 'anthropic',
    providerRawTag: null,
    model: 'claude-3-5-sonnet-20240620',
    timestamp: 1_700_000_000_000,
    project: 'demo',
    projectRawSlug: '-Users-demo',
    sessionId: 'sess-1',
    messageId: 'msg-1',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    reasoningTokens: null,
    toolCallCount: null,
    latencyMs: null,
    computedCostMicroUsd: 10500n,
    pricingSnapshotVersion: 'abc123',
    sourceFile: '/tmp/fake.jsonl',
    sourceLineOffset: 0,
    ...partial,
  }
}

describe('EventRepository (Postgres)', () => {
  let pool: Pool
  let dbName: string
  let repo: EventRepository

  beforeAll(async () => {
    const ctx = await createTestDatabase()
    pool = ctx.pool
    dbName = ctx.dbName
  }, 30_000)

  afterAll(async () => {
    await dropTestDatabase(pool, dbName)
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE events')
    repo = new EventRepository(pool)
  })

  it('starts empty and reports current schema version', async () => {
    expect(await repo.count()).toBe(0)
    const r = await pool.query<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_version',
    )
    // Current latest migration; bump as new ones land.
    expect(r.rows[0]?.version).toBeGreaterThanOrEqual(2)
  })

  it('round-trips an event including bigint cost', async () => {
    const e = makeEvent({ id: 'evt-1' })
    await repo.upsert(e)

    const found = await repo.findById('evt-1')
    expect(found).not.toBeNull()
    if (found === null) return
    expect(found).toEqual(e)
    expect(typeof found.computedCostMicroUsd).toBe('bigint')
    expect(found.computedCostMicroUsd).toBe(10500n)
  })

  it('upsert is idempotent on conflicting id (last write wins)', async () => {
    await repo.upsert(makeEvent({ id: 'evt-2', outputTokens: 100, computedCostMicroUsd: 1n }))
    await repo.upsert(makeEvent({ id: 'evt-2', outputTokens: 200, computedCostMicroUsd: 2n }))

    expect(await repo.count()).toBe(1)
    const found = await repo.findById('evt-2')
    expect(found?.outputTokens).toBe(200)
    expect(found?.computedCostMicroUsd).toBe(2n)
  })

  it('upsertMany applies a batch in one transaction', async () => {
    const batch = [
      makeEvent({ id: 'b-1', timestamp: 1000 }),
      makeEvent({ id: 'b-2', timestamp: 2000 }),
      makeEvent({ id: 'b-3', timestamp: 3000 }),
    ]
    await repo.upsertMany(batch)
    expect(await repo.count()).toBe(3)
  })

  it('between returns events in ascending timestamp order, half-open range', async () => {
    await repo.upsertMany([
      makeEvent({ id: 'a', timestamp: 100, computedCostMicroUsd: 1n }),
      makeEvent({ id: 'b', timestamp: 200, computedCostMicroUsd: 2n }),
      makeEvent({ id: 'c', timestamp: 300, computedCostMicroUsd: 4n }),
      makeEvent({ id: 'd', timestamp: 400, computedCostMicroUsd: 8n }),
    ])
    const slice = await repo.between(150, 350)
    expect(slice.map((e) => e.id)).toEqual(['b', 'c'])
  })

  it('costMicroUsdBetween sums bigint costs over the half-open window', async () => {
    await repo.upsertMany([
      makeEvent({ id: 'a', timestamp: 100, computedCostMicroUsd: 1n }),
      makeEvent({ id: 'b', timestamp: 200, computedCostMicroUsd: 2n }),
      makeEvent({ id: 'c', timestamp: 300, computedCostMicroUsd: 4n }),
      makeEvent({ id: 'd', timestamp: 400, computedCostMicroUsd: 8n }),
    ])
    expect(await repo.costMicroUsdBetween(150, 350)).toBe(6n)
    expect(await repo.costMicroUsdBetween(0, 1000)).toBe(15n)
    expect(await repo.costMicroUsdBetween(500, 600)).toBe(0n)
  })

  it('handles costs above 2^53 without precision loss', async () => {
    const huge = (1n << 60n) + 7n
    await repo.upsert(makeEvent({ id: 'big', computedCostMicroUsd: huge }))
    const found = await repo.findById('big')
    expect(found?.computedCostMicroUsd).toBe(huge)
  })

  it('null-typed columns survive the round-trip', async () => {
    await repo.upsert(
      makeEvent({
        id: 'nulls',
        providerRawTag: null,
        project: null,
        projectRawSlug: null,
        sessionId: null,
        messageId: null,
        reasoningTokens: null,
        toolCallCount: null,
        latencyMs: null,
      }),
    )
    const found = await repo.findById('nulls')
    expect(found?.providerRawTag).toBeNull()
    expect(found?.project).toBeNull()
    expect(found?.projectRawSlug).toBeNull()
    expect(found?.sessionId).toBeNull()
    expect(found?.messageId).toBeNull()
    expect(found?.reasoningTokens).toBeNull()
    expect(found?.toolCallCount).toBeNull()
    expect(found?.latencyMs).toBeNull()
  })
})
