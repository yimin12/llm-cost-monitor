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
import { OutboxRepository } from '../../src/main/sync/outbox-repository'
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
    await serverPool.query('DELETE FROM event_daily_rollup')
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
    const outbox = new OutboxRepository(cli.pool)
    const cursors = new CursorRepository(cli.pool)
    const nodes = new NodeIdentityRepository(cli.pool, { newId: () => opts.nodeId })
    await nodes.ensure()
    const queue = new SyncQueue({
      outbox,
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

  // Many-members-one-team. Mirrors the curl-based LAN demo: alice runs
  // two machines, bob runs one, all on team-A. Every member of the team
  // (and every machine fetching /usage) must see the same team-wide
  // total and the same per-member breakdown. Asserts both the merged
  // sums and the per-row identity columns.
  it('team dashboard: team total + each member shown separately, identical for every viewer', async () => {
    const aliceMac = await makeClient({
      userId: 'user-1', nodeId: 'macbook', privacyLevel: 'redacted',
    })
    const aliceLinux = await makeClient({
      userId: 'user-1', nodeId: 'linux-alice', privacyLevel: 'redacted',
    })
    const bobLinux = await makeClient({
      userId: 'user-2', nodeId: 'linux-bob', privacyLevel: 'redacted',
    })

    await aliceMac.events.upsertMany([
      makeEvent({
        id: 'a-mac-1', timestamp: NOW,
        inputTokens: 12000, outputTokens: 900, computedCostMicroUsd: 180_000n,
      }),
    ])
    await aliceLinux.events.upsertMany([
      makeEvent({
        id: 'a-linux-1', timestamp: NOW + 1,
        inputTokens: 30000, outputTokens: 2100, computedCostMicroUsd: 470_000n,
      }),
    ])
    await bobLinux.events.upsertMany([
      makeEvent({
        id: 'b-linux-1', timestamp: NOW + 2,
        inputTokens: 8000, outputTokens: 600, computedCostMicroUsd: 250_000n,
      }),
    ])

    expect((await aliceMac.queue.drain(aliceMac.cfg)).error).toBeNull()
    expect((await aliceLinux.queue.drain(aliceLinux.cfg)).error).toBeNull()
    expect((await bobLinux.queue.drain(bobLinux.cfg)).error).toBeNull()

    // Both members fetch the team dashboard.
    const [aliceView, bobView] = await Promise.all([
      fetch(`${baseUrl}/v1/teams/team-A/usage`, {
        headers: { Authorization: 'Bearer user-1' },
      }).then((r) => r.json()),
      fetch(`${baseUrl}/v1/teams/team-A/usage`, {
        headers: { Authorization: 'Bearer user-2' },
      }).then((r) => r.json()),
    ])

    // Team-wide totals visible to every member.
    type Overview = {
      totalCostMicroUsd: string
      totalEventCount: number
      activeMembers: number
      currentUserRole: string | null
      members: { userId: string; costMicroUsd: string; eventCount: number;
                 inputTokens: number; outputTokens: number }[]
    }
    for (const ov of [aliceView, bobView] as Overview[]) {
      expect(ov.totalCostMicroUsd).toBe('900000')   // 180k + 470k + 250k
      expect(ov.totalEventCount).toBe(3)
      expect(ov.activeMembers).toBe(2)

      // Per-member rows — alice's 2 nodes merge into one row.
      const alice = ov.members.find((m) => m.userId === 'user-1')!
      const bob   = ov.members.find((m) => m.userId === 'user-2')!
      expect(alice.costMicroUsd).toBe('650000')     // 180k + 470k
      expect(alice.eventCount).toBe(2)
      expect(alice.inputTokens).toBe(42000)         // 12k + 30k
      expect(alice.outputTokens).toBe(3000)         // 900 + 2100
      expect(bob.costMicroUsd).toBe('250000')
      expect(bob.eventCount).toBe(1)
      expect(bob.inputTokens).toBe(8000)
      expect(bob.outputTokens).toBe(600)
    }

    // Identity-sensitive columns: viewer-specific role, otherwise identical.
    expect((aliceView as Overview).currentUserRole).toBe('admin')  // first member auto-admin
    expect((bobView   as Overview).currentUserRole).toBe('member')

    // Strip viewer-specific bits and confirm everything else is byte-equal.
    // currentUserMonth* fields are scoped to the requesting user (drives the
    // per-account month-end forecast on each client), so they intentionally
    // differ between alice's and bob's views — same as currentUserRole.
    const stripViewerFields = (o: unknown): unknown => {
      const cloned = JSON.parse(JSON.stringify(o)) as Record<string, unknown>
      delete cloned['generatedAt']
      delete cloned['currentUserRole']
      delete cloned['currentUserMonthCostMicroUsd']
      delete cloned['currentUserMonthByProvider']
      return cloned
    }
    expect(stripViewerFields(aliceView)).toEqual(stripViewerFields(bobView))

    // …but the per-user fields themselves should reflect each viewer's
    // own spend (alice's two nodes merged, bob's single node).
    type PerUser = {
      currentUserMonthCostMicroUsd: string | null
      currentUserMonthByProvider: { provider: string; costMicroUsd: string; eventCount: number }[]
    }
    const aliceMtd = (aliceView as Overview & PerUser)
    const bobMtd = (bobView as Overview & PerUser)
    expect(aliceMtd.currentUserMonthCostMicroUsd).toBe('650000') // 180k + 470k
    expect(bobMtd.currentUserMonthCostMicroUsd).toBe('250000')

    await aliceMac.cleanup()
    await aliceLinux.cleanup()
    await bobLinux.cleanup()
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

  // ─── Concurrency invariants ─────────────────────────────────────────
  // Pairs with the consistency story in docs/multi-node-usage-merge-
  // design.md. Each test fires Promise.all over two clients to actually
  // exercise the parallel-write path the design assumes — not just two
  // sequential drains pretending to be concurrent.

  it('concurrency A: two users same team, parallel batches → both land, no interference', async () => {
    const aliceCli = await makeClient({ userId: 'user-1', nodeId: 'mac', privacyLevel: 'redacted' })
    const bobCli   = await makeClient({ userId: 'user-2', nodeId: 'linux', privacyLevel: 'redacted' })

    await aliceCli.events.upsertMany([
      makeEvent({ id: 'a1', timestamp: NOW, computedCostMicroUsd: 100n }),
      makeEvent({ id: 'a2', timestamp: NOW + 1, computedCostMicroUsd: 200n }),
    ])
    await bobCli.events.upsertMany([
      makeEvent({ id: 'b1', timestamp: NOW + 2, computedCostMicroUsd: 300n }),
    ])

    // Fire both drains at the same time. They touch disjoint rows (PK
    // includes user_id), so neither should block the other beyond
    // membership/teams metadata.
    const [aliceOut, bobOut] = await Promise.all([
      aliceCli.queue.drain(aliceCli.cfg),
      bobCli.queue.drain(bobCli.cfg),
    ])
    expect(aliceOut.error).toBeNull()
    expect(bobOut.error).toBeNull()

    const ov = await (await fetch(`${baseUrl}/v1/teams/team-A/usage`, {
      headers: { Authorization: 'Bearer user-1' },
    })).json() as {
      totalCostMicroUsd: string
      totalEventCount: number
      members: { userId: string; costMicroUsd: string; eventCount: number }[]
    }
    expect(ov.totalCostMicroUsd).toBe('600')  // 100 + 200 + 300
    expect(ov.totalEventCount).toBe(3)
    expect(ov.members.find((m) => m.userId === 'user-1')!.costMicroUsd).toBe('300')
    expect(ov.members.find((m) => m.userId === 'user-2')!.costMicroUsd).toBe('300')

    await aliceCli.cleanup()
    await bobCli.cleanup()
  })

  it('concurrency B: same user two nodes, parallel batches → merged, no race loss', async () => {
    // Two nodes share user, day, provider, model AND project_hash, so
    // both batches will try to UPSERT the *same* event_daily_rollup row
    // (PK is keyed by node_id so actually different rows — but the
    // dashboard SUMs across them, which is what we assert).
    const mac   = await makeClient({ userId: 'user-1', nodeId: 'mac',   privacyLevel: 'redacted' })
    const linux = await makeClient({ userId: 'user-1', nodeId: 'linux', privacyLevel: 'redacted' })

    // 25 events per node — enough to make the batch UPSERT take some
    // wall time and increase the chance of interleaving.
    const macEvents = Array.from({ length: 25 }, (_, i) =>
      makeEvent({ id: `m-${i}`, timestamp: NOW + i, computedCostMicroUsd: 10n }),
    )
    const linuxEvents = Array.from({ length: 25 }, (_, i) =>
      makeEvent({ id: `l-${i}`, timestamp: NOW + 100 + i, computedCostMicroUsd: 20n }),
    )
    await mac.events.upsertMany(macEvents)
    await linux.events.upsertMany(linuxEvents)

    const [m, l] = await Promise.all([
      mac.queue.drain(mac.cfg),
      linux.queue.drain(linux.cfg),
    ])
    expect(m.error).toBeNull()
    expect(l.error).toBeNull()

    const ov = await (await fetch(`${baseUrl}/v1/teams/team-A/usage`, {
      headers: { Authorization: 'Bearer user-1' },
    })).json() as { totalCostMicroUsd: string; totalEventCount: number }
    // 25 × 10 + 25 × 20 = 750. If row locking dropped a write we'd be
    // short. If a write got double-applied we'd be over.
    expect(ov.totalCostMicroUsd).toBe('750')
    expect(ov.totalEventCount).toBe(50)

    await mac.cleanup()
    await linux.cleanup()
  })

  it('concurrency C: two clients race the SAME batch → 3 rows total, never 6', async () => {
    // Two fresh clients each prepare the same three UsageEvents
    // (same user, same node, same local ids → same sync_event_ids
    // after redaction). Fire both drains in parallel; whichever
    // transaction COMMITs first plants the row, the loser sees
    // ON CONFLICT DO NOTHING for that row. Net result: 3 rows
    // total, accepted_total + duplicates_total = 6, never two of
    // either side.
    const make = async () => {
      const c = await makeClient({ userId: 'user-1', nodeId: 'n', privacyLevel: 'redacted' })
      await c.events.upsertMany([
        makeEvent({ id: 'r1', timestamp: NOW,     computedCostMicroUsd: 100n }),
        makeEvent({ id: 'r2', timestamp: NOW + 1, computedCostMicroUsd: 200n }),
        makeEvent({ id: 'r3', timestamp: NOW + 2, computedCostMicroUsd: 300n }),
      ])
      return c
    }
    const a = await make()
    const b = await make()
    const [outA, outB] = await Promise.all([a.queue.drain(a.cfg), b.queue.drain(b.cfg)])
    expect(outA.error).toBeNull()
    expect(outB.error).toBeNull()
    expect(outA.accepted + outA.duplicates + outB.accepted + outB.duplicates).toBe(6)
    expect(outA.accepted + outB.accepted).toBe(3)   // exactly 3 rows landed
    expect(outA.duplicates + outB.duplicates).toBe(3) // the other 3 attempts collided

    const ov = await (await fetch(`${baseUrl}/v1/teams/team-A/usage`, {
      headers: { Authorization: 'Bearer user-1' },
    })).json() as { totalCostMicroUsd: string; totalEventCount: number }
    expect(ov.totalEventCount).toBe(3)
    expect(ov.totalCostMicroUsd).toBe('600')   // 100 + 200 + 300, no double-count
    await a.cleanup()
    await b.cleanup()
  })

  it('concurrency D: read fires mid-write → never observes a partial transaction', async () => {
    // Drain that takes long enough to interleave with a read. We pile
    // 200 events into one batch and issue many parallel GETs while it
    // commits. Every GET must return a snapshot whose totalEventCount
    // matches its totalCostMicroUsd / 100 — i.e. half-written rollups
    // can never escape the transaction boundary.
    const cli = await makeClient({ userId: 'user-1', nodeId: 'big', privacyLevel: 'redacted' })
    const evts = Array.from({ length: 200 }, (_, i) =>
      makeEvent({ id: `big-${i}`, timestamp: NOW + i, computedCostMicroUsd: 100n }),
    )
    await cli.events.upsertMany(evts)

    const headers = { Authorization: 'Bearer user-1' }
    const readers = Array.from({ length: 20 }, () =>
      (async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 50))
        const ov = await (await fetch(`${baseUrl}/v1/teams/team-A/usage`, { headers })).json() as {
          totalCostMicroUsd: string; totalEventCount: number
        }
        return ov
      })(),
    )
    const [drainOut, ...snapshots] = await Promise.all([
      cli.queue.drain(cli.cfg),
      ...readers,
    ])
    expect(drainOut.error).toBeNull()

    for (const ov of snapshots) {
      // Snapshot must be either "before commit" (0 events / 0 cost) or
      // "after commit" (200 / 20000). No in-between.
      const eventCount = ov.totalEventCount
      const cost = Number(ov.totalCostMicroUsd)
      const isBefore = eventCount === 0 && cost === 0
      const isAfter  = eventCount === 200 && cost === 20000
      expect(isBefore || isAfter).toBe(true)
    }

    // Final read must show the committed state.
    const final = await (await fetch(`${baseUrl}/v1/teams/team-A/usage`, { headers })).json() as {
      totalCostMicroUsd: string; totalEventCount: number
    }
    expect(final.totalEventCount).toBe(200)
    expect(final.totalCostMicroUsd).toBe('20000')

    await cli.cleanup()
  })
})
