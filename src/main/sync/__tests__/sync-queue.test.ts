import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BatchUpsertResponse, SyncPayload } from '@shared/sync'
import type { UsageEvent } from '@shared/usage-event'

import type { Pool } from '../../storage/connect'
import { EventRepository } from '../../storage/event-repository'
import { createTestDatabase, dropTestDatabase } from '../../storage/__tests__/test-helpers'
import { CursorRepository } from '../cursor-repository'
import { NodeIdentityRepository } from '../node-identity'
import { OutboxRepository } from '../outbox-repository'
import { SyncQueue, type DrainConfig } from '../sync-queue'
import type { SyncTransport } from '../transport'
import { TransportError } from '../transport'

function makeEvent(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: 'event-1',
    provider: 'anthropic',
    providerRawTag: 'claude',
    model: 'claude-3-5-sonnet',
    timestamp: 1_700_000_000_000,
    project: 'lcm',
    projectRawSlug: '-Users-me-lcm',
    sessionId: 'sess',
    messageId: 'msg',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    reasoningTokens: null,
    toolCallCount: null,
    latencyMs: null,
    computedCostMicroUsd: 1500n,
    pricingSnapshotVersion: 'v1',
    sourceFile: '/x.jsonl',
    sourceLineOffset: 0,
    ...over,
  }
}

const cfg: DrainConfig = {
  enabled: true,
  teamId: 'team-A',
  userId: 'user-1',
  privacyLevel: 'redacted',
}

describe('SyncQueue', () => {
  let pool: Pool
  let dbName: string

  beforeAll(async () => {
    const created = await createTestDatabase()
    pool = created.pool
    dbName = created.dbName
  })

  afterAll(async () => {
    await dropTestDatabase(pool, dbName)
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM sync_audit')
    await pool.query('DELETE FROM sync_cursor')
    await pool.query('DELETE FROM sync_outbox')
    await pool.query('DELETE FROM events')
    await pool.query('DELETE FROM local_node')
  })

  function makeQueue(transport: SyncTransport, now: () => number = () => 1_800_000_000_000) {
    const events = new EventRepository(pool)
    const cursors = new CursorRepository(pool)
    const outbox = new OutboxRepository(pool)
    const nodes = new NodeIdentityRepository(pool, { newId: () => 'node-test', now })
    const queue = new SyncQueue({
      outbox,
      cursors,
      nodes,
      transport,
      getAccessToken: async () => 'token-xyz',
      now,
    })
    return { queue, events, cursors, outbox, nodes }
  }

  it('does nothing when sync is disabled', async () => {
    const transport: SyncTransport = { batchUpsert: vi.fn() }
    const { queue } = makeQueue(transport)
    const out = await queue.drain({ ...cfg, enabled: false })
    expect(out.uploaded).toBe(0)
    expect(transport.batchUpsert).not.toHaveBeenCalled()
  })

  it('uploads pending events and advances the cursor on success', async () => {
    const seenPayloads: SyncPayload[][] = []
    const transport: SyncTransport = {
      batchUpsert: vi.fn(async (_teamId, payloads, _token): Promise<BatchUpsertResponse> => {
        seenPayloads.push([...payloads])
        return {
          accepted: payloads.map((p: SyncPayload) => (p.kind === 'event' ? p.sync_event_id : `${p.date}|${p.provider}|${p.model}`)),
          duplicates: [],
          rejected: [],
          cursor: 1_700_000_001_000,
        }
      }),
    }
    const { queue, events, cursors } = makeQueue(transport)
    await events.upsertMany([
      makeEvent({ id: 'a', timestamp: 1_700_000_000_000 }),
      makeEvent({ id: 'b', timestamp: 1_700_000_000_500 }),
    ])

    const out = await queue.drain(cfg)
    expect(out.uploaded).toBe(2)
    expect(out.accepted).toBe(2)
    expect(out.error).toBeNull()
    expect(out.newCursorMs).toBe(1_700_000_000_500)

    const cur = await cursors.get('team-A', 'user-1')
    expect(cur?.lastAcknowledgedTimestampMs).toBe(1_700_000_000_500)

    // Verify auth header was attempted with the access token
    expect(transport.batchUpsert).toHaveBeenCalledWith('team-A', expect.any(Array), 'token-xyz')

    // After advancing, a second drain finds nothing pending
    const second = await queue.drain(cfg)
    expect(second.uploaded).toBe(0)
  })

  it('does NOT advance the cursor on transport error and surfaces the message', async () => {
    const transport: SyncTransport = {
      batchUpsert: vi.fn(async () => {
        throw new TransportError('server', 'boom', 503)
      }),
    }
    const { queue, events, cursors } = makeQueue(transport)
    await events.upsertMany([makeEvent({ id: 'a', timestamp: 100 })])

    const out = await queue.drain(cfg)
    expect(out.error).toContain('boom')
    expect(out.uploaded).toBe(0)

    const cur = await cursors.get('team-A', 'user-1')
    expect(cur?.lastAcknowledgedTimestampMs ?? 0).toBe(0)
    expect(cur?.lastError).toContain('boom')

    // Retry succeeds, advances cursor (idempotency: same events re-sent
    // because cursor wasn't bumped)
    transport.batchUpsert = vi.fn(async () => ({ accepted: ['x'], duplicates: [], rejected: [], cursor: 100 }))
    const retry = await queue.drain(cfg)
    expect(retry.uploaded).toBe(1)
    const cur2 = await cursors.get('team-A', 'user-1')
    expect(cur2?.lastAcknowledgedTimestampMs).toBe(100)
    expect(cur2?.lastError).toBeNull()
  })

  it('caps batch size and re-runs to drain the rest', async () => {
    const calls: number[] = []
    const transport: SyncTransport = {
      batchUpsert: vi.fn(async (_t, payloads): Promise<BatchUpsertResponse> => {
        calls.push(payloads.length)
        return {
          accepted: payloads.map((p: SyncPayload) => (p.kind === 'event' ? p.sync_event_id : 'd')),
          duplicates: [],
          rejected: [],
          cursor: 0,
        }
      }),
    }
    const { queue, events } = makeQueue(transport)
    // 600 events with monotonic timestamps; MAX_BATCH_SIZE is 500
    const evs: UsageEvent[] = []
    for (let i = 0; i < 600; i++) {
      evs.push(makeEvent({ id: `e${i}`, timestamp: 1_000 + i }))
    }
    await events.upsertMany(evs)

    const first = await queue.drain(cfg)
    expect(first.uploaded).toBe(500)

    const second = await queue.drain(cfg)
    expect(second.uploaded).toBe(100)

    expect(calls).toEqual([500, 100])
  })

  it('coalesces concurrent drain() calls', async () => {
    let started = 0
    let resolved = 0
    const transport: SyncTransport = {
      batchUpsert: vi.fn(async (_t, payloads): Promise<BatchUpsertResponse> => {
        started++
        await new Promise((r) => setTimeout(r, 30))
        resolved++
        return {
          accepted: payloads.map((p: SyncPayload) => (p.kind === 'event' ? p.sync_event_id : 'd')),
          duplicates: [],
          rejected: [],
          cursor: 0,
        }
      }),
    }
    const { queue, events } = makeQueue(transport)
    await events.upsertMany([makeEvent({ id: 'a', timestamp: 100 })])

    const [a, b, c] = await Promise.all([queue.drain(cfg), queue.drain(cfg), queue.drain(cfg)])
    expect(started).toBe(1)
    expect(resolved).toBe(1)
    expect(a.uploaded).toBe(b.uploaded)
    expect(b.uploaded).toBe(c.uploaded)
  })

  it('uploads daily aggregates in aggregateOnly mode (no event ids leak)', async () => {
    let captured: SyncPayload[] = []
    const transport: SyncTransport = {
      batchUpsert: vi.fn(async (_t, payloads): Promise<BatchUpsertResponse> => {
        captured = [...payloads]
        return {
          accepted: payloads.map((p: SyncPayload) => (p.kind === 'daily' ? `${p.date}|${p.provider}|${p.model}` : 'x')),
          duplicates: [],
          rejected: [],
          cursor: 0,
        }
      }),
    }
    const { queue, events } = makeQueue(transport)
    await events.upsertMany([
      makeEvent({ id: 'event-1', timestamp: Date.UTC(2026, 4, 8, 1, 0) }),
      makeEvent({ id: 'event-2', timestamp: Date.UTC(2026, 4, 8, 2, 0) }),
    ])

    const out = await queue.drain({ ...cfg, privacyLevel: 'aggregateOnly' })
    expect(out.uploaded).toBe(1) // collapsed into one bucket
    expect(captured.every((p) => p.kind === 'daily')).toBe(true)
    const json = JSON.stringify(captured)
    expect(json).not.toContain('event-1')
    expect(json).not.toContain('event-2')
  })

  it('reports status for an enabled but never-synced cursor', async () => {
    const transport: SyncTransport = { batchUpsert: vi.fn() }
    const { queue, events } = makeQueue(transport)
    await events.upsertMany([
      makeEvent({ id: 'a', timestamp: 1_000 }),
      makeEvent({ id: 'b', timestamp: 2_000 }),
    ])

    const status = await queue.getStatus(cfg)
    expect(status.enabled).toBe(true)
    expect(status.configured).toBe(true)
    expect(status.pendingCount).toBe(2)
    expect(status.lastSyncAt).toBeNull()
    expect(status.nodeId).toBe('node-test')
  })

  it('reports status when sync is disabled (no events queried, but nodeId present)', async () => {
    const transport: SyncTransport = { batchUpsert: vi.fn() }
    const { queue } = makeQueue(transport)

    const status = await queue.getStatus({ ...cfg, enabled: false })
    expect(status.enabled).toBe(false)
    expect(status.pendingCount).toBe(0)
    expect(status.nodeId).toBe('node-test')
  })

  // Regression: under the old timestamp-cursor strategy, a MAX_BATCH_SIZE
  // cap landing inside a same-millisecond burst would advance the cursor
  // past the burst, dropping the tail. With the outbox, seq is unique per
  // row so the second drain still sees the remaining rows.
  it('does not skip same-millisecond events at a batch boundary', async () => {
    const transport: SyncTransport = {
      batchUpsert: vi.fn(async (_t, payloads): Promise<BatchUpsertResponse> => ({
        accepted: payloads.map((p: SyncPayload) => (p.kind === 'event' ? p.sync_event_id : 'd')),
        duplicates: [],
        rejected: [],
        cursor: 0,
      })),
    }
    const { queue, events } = makeQueue(transport)
    // 600 events, ALL with the same timestamp.
    const evs: UsageEvent[] = []
    for (let i = 0; i < 600; i++) {
      evs.push(makeEvent({ id: `e${i}`, timestamp: 1_700_000_000_000 }))
    }
    await events.upsertMany(evs)

    const first = await queue.drain(cfg)
    expect(first.uploaded).toBe(500)

    const second = await queue.drain(cfg)
    expect(second.uploaded).toBe(100)

    const third = await queue.drain(cfg)
    expect(third.uploaded).toBe(0)
  })
})
