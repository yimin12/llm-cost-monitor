// Acceptance tests from plan.md Phase 5. Each test exercises the full
// stack: client-side UsageEvent → redaction → SyncQueue → HttpSyncTransport →
// HTTP server → TeamService → Postgres → getOverview. We bind a real
// server on a random port and have the queue talk to it.

import type { AddressInfo } from 'node:net'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { UsageEvent } from '../../src/shared/usage-event'

import type { Pool } from '../db'
import { createApp } from '../http'
import { TeamService } from '../team-service'
import { createServerTestDatabase, dropServerTestDatabase } from './test-helpers'

// Client-side modules
import {
  createTestDatabase as createClientDb,
  dropTestDatabase as dropClientDb,
} from '../../src/main/storage/__tests__/test-helpers'
import { EventRepository } from '../../src/main/storage/event-repository'
import { CursorRepository } from '../../src/main/sync/cursor-repository'
import { NodeIdentityRepository } from '../../src/main/sync/node-identity'
import { SyncQueue } from '../../src/main/sync/sync-queue'
import { HttpSyncTransport } from '../../src/main/sync/transport'

const NOW = Date.now()

function makeEvent(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: 'event-1',
    provider: 'anthropic',
    providerRawTag: 'claude',
    model: 'claude-3-5-sonnet',
    timestamp: NOW,
    project: 'secret-project',
    projectRawSlug: '-Users-me-secret-project',
    sessionId: 'sensitive-session-id',
    messageId: 'sensitive-msg-id',
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

describe('end-to-end acceptance (plan.md Phase 5)', () => {
  let serverPool: Pool
  let serverDbName: string
  let baseUrl: string
  let httpServer: import('node:http').Server

  beforeAll(async () => {
    const created = await createServerTestDatabase()
    serverPool = created.pool
    serverDbName = created.dbName
    const svc = new TeamService(serverPool)
    await svc.ensureTeam('team-A')
    httpServer = createApp({
      service: svc,
      authorize: (req) => {
        const h = req.headers['authorization']
        if (typeof h !== 'string' || !h.startsWith('Bearer ')) return { userId: null }
        return { userId: h.slice('Bearer '.length).trim() || null }
      },
      log: () => {},
    })
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
    const addr = httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    await dropServerTestDatabase(serverPool, serverDbName)
  })

  beforeEach(async () => {
    await serverPool.query('DELETE FROM usage_events')
    await serverPool.query('DELETE FROM daily_aggregates')
    await serverPool.query('DELETE FROM nodes')
    await serverPool.query('DELETE FROM team_members')
    await serverPool.query('DELETE FROM sync_conflicts')
    const svc = new TeamService(serverPool)
    await svc.addMember('team-A', 'user-1')
    await svc.addMember('team-A', 'user-2')
  })

  // Helper: build a fully-wired client (its own DB, repo set, queue) for a
  // given (userId, nodeId). Returns the queue and a helper to close.
  async function makeClient(opts: {
    userId: string
    nodeId: string
    privacyLevel: 'full' | 'redacted' | 'aggregateOnly'
    accessToken?: string
  }) {
    const cli = await createClientDb()
    const events = new EventRepository(cli.pool)
    const cursors = new CursorRepository(cli.pool)
    const nodes = new NodeIdentityRepository(cli.pool, { newId: () => opts.nodeId })
    await nodes.ensure()
    const queue = new SyncQueue({
      events,
      cursors,
      nodes,
      transport: new HttpSyncTransport({ baseUrl }),
      getAccessToken: async () => opts.accessToken ?? opts.userId,
    })
    return {
      pool: cli.pool,
      events,
      queue,
      cleanup: () => dropClientDb(cli.pool, cli.dbName),
      cfg: {
        enabled: true,
        teamId: 'team-A',
        userId: opts.userId,
        privacyLevel: opts.privacyLevel,
      } as const,
    }
  }

  it('two nodes, same user → team totals equal the union, no duplicates', async () => {
    const macClient = await makeClient({ userId: 'user-1', nodeId: 'mac', privacyLevel: 'redacted' })
    const linuxClient = await makeClient({
      userId: 'user-1', nodeId: 'linux', privacyLevel: 'redacted',
    })

    await macClient.events.upsertMany([
      makeEvent({ id: 'm1', timestamp: NOW, computedCostMicroUsd: 1000n }),
      makeEvent({ id: 'm2', timestamp: NOW + 1, computedCostMicroUsd: 500n }),
    ])
    await linuxClient.events.upsertMany([
      makeEvent({ id: 'l1', timestamp: NOW + 2, computedCostMicroUsd: 300n }),
    ])

    const macOut = await macClient.queue.drain(macClient.cfg)
    const linuxOut = await linuxClient.queue.drain(linuxClient.cfg)
    expect(macOut.error).toBeNull()
    expect(linuxOut.error).toBeNull()

    const overviewRes = await fetch(`${baseUrl}/v1/teams/team-A/usage`, {
      headers: { Authorization: 'Bearer user-1' },
    })
    const overview = await overviewRes.json() as { totalEventCount: number; totalCostMicroUsd: string }
    expect(overview.totalEventCount).toBe(3)
    expect(overview.totalCostMicroUsd).toBe('1800')

    await macClient.cleanup()
    await linuxClient.cleanup()
  })

  // Matches the headline example in docs/multi-node-usage-merge-design.md
  // §"Claude Multi-node Example". If this test ever drifts from the doc,
  // either the doc or the merge math is wrong — both directions are bugs.
  it('design example: macbook $0.18 + linux $0.47 = $0.65 across 42k/3k tokens', async () => {
    const mac = await makeClient({ userId: 'user-1', nodeId: 'macbook', privacyLevel: 'redacted' })
    const linux = await makeClient({ userId: 'user-1', nodeId: 'linux-box', privacyLevel: 'redacted' })

    await mac.events.upsertMany([
      makeEvent({
        id: 'mac-1', timestamp: NOW,
        inputTokens: 12000, outputTokens: 900, cacheReadTokens: 8000,
        computedCostMicroUsd: 180_000n,
      }),
    ])
    await linux.events.upsertMany([
      makeEvent({
        id: 'linux-1', timestamp: NOW + 1,
        inputTokens: 30000, outputTokens: 2100, cacheReadTokens: 16000,
        computedCostMicroUsd: 470_000n,
      }),
    ])

    expect((await mac.queue.drain(mac.cfg)).error).toBeNull()
    expect((await linux.queue.drain(linux.cfg)).error).toBeNull()

    const ov = await (await fetch(`${baseUrl}/v1/teams/team-A/usage`, {
      headers: { Authorization: 'Bearer user-1' },
    })).json() as {
      totalCostMicroUsd: string
      totalEventCount: number
      activeNodes: number
      members: { userId: string; inputTokens: number; outputTokens: number }[]
      nodes: { nodeId: string }[]
    }

    // Sums copied verbatim from the design doc — do not adjust without
    // also updating docs/multi-node-usage-merge-design.md.
    expect(ov.totalCostMicroUsd).toBe('650000')   // $0.65
    expect(ov.totalEventCount).toBe(2)
    expect(ov.activeNodes).toBe(2)
    const alice = ov.members.find((m) => m.userId === 'user-1')!
    expect(alice.inputTokens).toBe(42000)
    expect(alice.outputTokens).toBe(3000)
    expect(ov.nodes.map((n) => n.nodeId).sort()).toEqual(['linux-box', 'macbook'])

    await mac.cleanup()
    await linux.cleanup()
  })

  // Two clients fetching /usage at roughly the same time must see the same
  // numbers, ordering, and shape. `generatedAt` is the only field allowed
  // to differ — it's the per-request timestamp, not the data.
  it('read consistency: concurrent /usage requests return identical bodies modulo generatedAt', async () => {
    const c = await makeClient({ userId: 'user-1', nodeId: 'n-1', privacyLevel: 'redacted' })
    await c.events.upsertMany([
      makeEvent({ id: 'e1', timestamp: NOW, computedCostMicroUsd: 100n }),
      makeEvent({ id: 'e2', timestamp: NOW + 1, computedCostMicroUsd: 200n }),
    ])
    await c.queue.drain(c.cfg)

    const headers = { Authorization: 'Bearer user-1' }
    const [a, b] = await Promise.all([
      fetch(`${baseUrl}/v1/teams/team-A/usage`, { headers }).then((r) => r.json()),
      fetch(`${baseUrl}/v1/teams/team-A/usage`, { headers }).then((r) => r.json()),
    ])
    // Strip generatedAt before deep equality.
    const stripGen = (o: unknown): unknown => {
      const cloned = JSON.parse(JSON.stringify(o)) as Record<string, unknown>
      delete cloned['generatedAt']
      return cloned
    }
    expect(stripGen(a)).toEqual(stripGen(b))
    await c.cleanup()
  })

  // Once a row is on the server, a second drain from a *different* SyncQueue
  // instance for the same user/node (e.g. fresh dev rebuild or replay tool)
  // must dedupe via sync_event_id PK, not double-count. Pairs with
  // §"Server Write Path" — "repeated rows become primary-key lookups".
  it('cross-instance replay: re-drain from a fresh queue → duplicates, totals unchanged', async () => {
    const first = await makeClient({
      userId: 'user-1', nodeId: 'replay-node', privacyLevel: 'redacted',
    })
    await first.events.upsertMany([
      makeEvent({ id: 'r1', timestamp: NOW, computedCostMicroUsd: 100n }),
      makeEvent({ id: 'r2', timestamp: NOW + 1, computedCostMicroUsd: 200n }),
    ])
    const out1 = await first.queue.drain(first.cfg)
    expect(out1.accepted).toBe(2)
    expect(out1.duplicates).toBe(0)
    await first.cleanup()

    // Brand-new client DB, same user + node → the outbox build hash will
    // re-derive the same sync_event_ids; server must report duplicates.
    const second = await makeClient({
      userId: 'user-1', nodeId: 'replay-node', privacyLevel: 'redacted',
    })
    await second.events.upsertMany([
      makeEvent({ id: 'r1', timestamp: NOW, computedCostMicroUsd: 100n }),
      makeEvent({ id: 'r2', timestamp: NOW + 1, computedCostMicroUsd: 200n }),
    ])
    const out2 = await second.queue.drain(second.cfg)
    expect(out2.accepted).toBe(0)
    expect(out2.duplicates).toBe(2)

    const ov = await (await fetch(`${baseUrl}/v1/teams/team-A/usage`, {
      headers: { Authorization: 'Bearer user-1' },
    })).json() as { totalEventCount: number; totalCostMicroUsd: string }
    expect(ov.totalEventCount).toBe(2)
    expect(ov.totalCostMicroUsd).toBe('300')
    await second.cleanup()
  })

  it('redacted mode never uploads raw project name, session id, or message id', async () => {
    const c = await makeClient({ userId: 'user-1', nodeId: 'n', privacyLevel: 'redacted' })
    await c.events.upsertMany([makeEvent({ id: 'e1', timestamp: NOW })])
    await c.queue.drain(c.cfg)

    const rows = await serverPool.query<{ project: string | null; session_id: string | null; message_id: string | null }>(
      `SELECT project, session_id, message_id FROM usage_events`,
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]!.project).toBeNull()
    expect(rows.rows[0]!.session_id).toBeNull()
    expect(rows.rows[0]!.message_id).toBeNull()

    await c.cleanup()
  })

  it('aggregateOnly mode uploads daily buckets only, no event-level rows', async () => {
    const c = await makeClient({ userId: 'user-1', nodeId: 'n', privacyLevel: 'aggregateOnly' })
    await c.events.upsertMany([
      makeEvent({ id: 'e1', timestamp: NOW }),
      makeEvent({ id: 'e2', timestamp: NOW + 1, computedCostMicroUsd: 200n }),
    ])
    await c.queue.drain(c.cfg)

    const events = await serverPool.query<{ n: bigint }>(`SELECT COUNT(*)::bigint AS n FROM usage_events`)
    expect(Number(events.rows[0]!.n)).toBe(0)

    const daily = await serverPool.query<{ event_count: bigint; cost: bigint }>(
      `SELECT event_count, cost_micro_usd AS cost FROM daily_aggregates`,
    )
    expect(daily.rows).toHaveLength(1)
    expect(Number(daily.rows[0]!.event_count)).toBe(2)
    expect(Number(daily.rows[0]!.cost)).toBe(1700)

    await c.cleanup()
  })

  it('removed member can no longer upload', async () => {
    const c = await makeClient({ userId: 'user-2', nodeId: 'n', privacyLevel: 'redacted' })
    // user-2 starts as a member; revoke and try to upload.
    const svc = new TeamService(serverPool)
    await svc.revokeMember('team-A', 'user-2')

    await c.events.upsertMany([makeEvent({ id: 'e1', timestamp: NOW })])
    const out = await c.queue.drain(c.cfg)
    // The queue itself doesn't error — the server returns 200 with rejected.
    // But no rows should have landed.
    expect(out.error).toBeNull()
    const rows = await serverPool.query<{ n: bigint }>(`SELECT COUNT(*)::bigint AS n FROM usage_events`)
    expect(Number(rows.rows[0]!.n)).toBe(0)
    await c.cleanup()
  })

  it('retry idempotency: same client drained twice → no double counting', async () => {
    const c = await makeClient({ userId: 'user-1', nodeId: 'n', privacyLevel: 'redacted' })
    await c.events.upsertMany([makeEvent({ id: 'e1', timestamp: NOW })])
    await c.queue.drain(c.cfg)
    await c.queue.drain(c.cfg) // second drain finds nothing
    const r = await fetch(`${baseUrl}/v1/teams/team-A/usage`, {
      headers: { Authorization: 'Bearer user-1' },
    })
    const ov = await r.json() as { totalEventCount: number }
    expect(ov.totalEventCount).toBe(1)
    await c.cleanup()
  })

  it('pricing_snapshot_version is preserved on the server', async () => {
    const c = await makeClient({ userId: 'user-1', nodeId: 'n', privacyLevel: 'redacted' })
    await c.events.upsertMany([
      makeEvent({ id: 'e1', timestamp: NOW, pricingSnapshotVersion: 'snapshot-2026-05' }),
    ])
    await c.queue.drain(c.cfg)
    const row = await serverPool.query<{ v: string }>(
      `SELECT pricing_snapshot_version AS v FROM usage_events`,
    )
    expect(row.rows[0]!.v).toBe('snapshot-2026-05')
    await c.cleanup()
  })
})
