import { beforeEach, describe, expect, it } from 'vitest'

import type { UsageEvent } from '@shared/usage-event'
import { openDatabase, type DatabaseHandle } from '../db'
import { EventRepository } from '../event-repository'

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

describe('EventRepository', () => {
  let db: DatabaseHandle
  let repo: EventRepository

  beforeEach(() => {
    db = openDatabase(':memory:')
    repo = new EventRepository(db)
  })

  it('starts empty and reports schema_version 1', () => {
    expect(repo.count()).toBe(0)
    const v = db.prepare<[], { version: bigint }>('SELECT version FROM schema_version').get()
    expect(Number(v?.version)).toBe(1)
  })

  it('round-trips an event including bigint cost', () => {
    const e = makeEvent({ id: 'evt-1' })
    repo.upsert(e)

    const found = repo.findById('evt-1')
    expect(found).not.toBeNull()
    if (found === null) return
    expect(found).toEqual(e)
    expect(typeof found.computedCostMicroUsd).toBe('bigint')
    expect(found.computedCostMicroUsd).toBe(10500n)
  })

  it('upsert is idempotent on conflicting id (last write wins)', () => {
    repo.upsert(makeEvent({ id: 'evt-2', outputTokens: 100, computedCostMicroUsd: 1n }))
    repo.upsert(makeEvent({ id: 'evt-2', outputTokens: 200, computedCostMicroUsd: 2n }))

    expect(repo.count()).toBe(1)
    const found = repo.findById('evt-2')
    expect(found?.outputTokens).toBe(200)
    expect(found?.computedCostMicroUsd).toBe(2n)
  })

  it('upsertMany applies a batch in one transaction', () => {
    const batch = [
      makeEvent({ id: 'b-1', timestamp: 1000 }),
      makeEvent({ id: 'b-2', timestamp: 2000 }),
      makeEvent({ id: 'b-3', timestamp: 3000 }),
    ]
    repo.upsertMany(batch)
    expect(repo.count()).toBe(3)
  })

  it('between returns events in ascending timestamp order, half-open range', () => {
    repo.upsertMany([
      makeEvent({ id: 'a', timestamp: 100, computedCostMicroUsd: 1n }),
      makeEvent({ id: 'b', timestamp: 200, computedCostMicroUsd: 2n }),
      makeEvent({ id: 'c', timestamp: 300, computedCostMicroUsd: 4n }),
      makeEvent({ id: 'd', timestamp: 400, computedCostMicroUsd: 8n }),
    ])
    const slice = repo.between(150, 350)
    expect(slice.map((e) => e.id)).toEqual(['b', 'c'])
  })

  it('costMicroUsdBetween sums bigint costs over the half-open window', () => {
    repo.upsertMany([
      makeEvent({ id: 'a', timestamp: 100, computedCostMicroUsd: 1n }),
      makeEvent({ id: 'b', timestamp: 200, computedCostMicroUsd: 2n }),
      makeEvent({ id: 'c', timestamp: 300, computedCostMicroUsd: 4n }),
      makeEvent({ id: 'd', timestamp: 400, computedCostMicroUsd: 8n }),
    ])
    expect(repo.costMicroUsdBetween(150, 350)).toBe(6n)
    expect(repo.costMicroUsdBetween(0, 1000)).toBe(15n)
    expect(repo.costMicroUsdBetween(500, 600)).toBe(0n)
  })

  it('handles costs above 2^53 without precision loss', () => {
    const huge = (1n << 60n) + 7n
    repo.upsert(makeEvent({ id: 'big', computedCostMicroUsd: huge }))
    const found = repo.findById('big')
    expect(found?.computedCostMicroUsd).toBe(huge)
  })

  it('null-typed columns survive the round-trip', () => {
    repo.upsert(
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
    const found = repo.findById('nulls')
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
