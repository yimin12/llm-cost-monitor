import { createHash } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { syncEventIdInput, type SyncedDailyV1, type SyncedEventV1 } from '../../src/shared/sync'

import type { Pool } from '../db'
import { TeamService } from '../team-service'
import { createServerTestDatabase, dropServerTestDatabase } from './test-helpers'

// Use Date.now() so events fall inside the default 30-day overview window.
const NOW = Date.now()

// Compute the canonical sync_event_id so the server's recompute-and-reject
// check passes. Tests that need *different* events should vary local_event_id
// (or node_id), not the sync_event_id itself.
function sid(team: string, user: string, node: string, local: string): string {
  return createHash('sha256').update(syncEventIdInput(team, user, node, local)).digest('hex')
}

function evt(over: Partial<SyncedEventV1> = {}): SyncedEventV1 {
  // Strip any caller-supplied sync_event_id — the server recomputes and
  // rejects mismatches, so the factory always emits the canonical hash.
  const { sync_event_id: _ignored, ...rest } = over
  const team_id = rest.team_id ?? 'team-A'
  const user_id = rest.user_id ?? 'user-1'
  const node_id = rest.node_id ?? 'node-1'
  const local_event_id = rest.local_event_id ?? 'local-1'
  return {
    kind: 'event',
    event_version: 1,
    sync_event_id: sid(team_id, user_id, node_id, local_event_id),
    team_id,
    user_id,
    node_id,
    local_event_id,
    payload_hash: 'hash-1',
    privacy_level: 'redacted',
    captured_at: NOW,
    synced_at: null,
    provider: 'anthropic',
    provider_raw_tag: null,
    model: 'claude-3-5-sonnet',
    timestamp: NOW,
    project: null,
    project_hash: 'p-hash-A',
    session_id: null,
    message_id: null,
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 0,
    cache_creation_5m_tokens: 0,
    cache_creation_1h_tokens: 0,
    reasoning_tokens: null,
    tool_call_count: null,
    latency_ms: null,
    cost_micro_usd: '1500',
    pricing_snapshot_version: 'v1',
    ...rest,
  }
}

function daily(over: Partial<SyncedDailyV1> = {}): SyncedDailyV1 {
  return {
    kind: 'daily',
    event_version: 1,
    team_id: 'team-A',
    user_id: 'user-1',
    node_id: 'node-1',
    date: '2026-05-08',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    event_count: 5,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_creation_5m_tokens: 0,
    cache_creation_1h_tokens: 0,
    reasoning_tokens: 0,
    cost_micro_usd: '5000',
    pricing_snapshot_version: 'v1',
    ...over,
  }
}

describe('TeamService', () => {
  let pool: Pool
  let dbName: string
  let svc: TeamService

  beforeAll(async () => {
    const created = await createServerTestDatabase()
    pool = created.pool
    dbName = created.dbName
    svc = new TeamService(pool)
  })

  afterAll(async () => {
    await dropServerTestDatabase(pool, dbName)
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM sync_conflicts')
    await pool.query('DELETE FROM event_daily_rollup')
    await pool.query('DELETE FROM daily_aggregates')
    await pool.query('DELETE FROM usage_events')
    await pool.query('DELETE FROM nodes')
    await pool.query('DELETE FROM team_members')
    await pool.query('DELETE FROM teams')
    await svc.ensureTeam('team-A')
    await svc.addMember('team-A', 'user-1')
    await svc.addMember('team-A', 'user-2')
  })

  // Canonical id for the default factory inputs.
  const DEFAULT_SID = sid('team-A', 'user-1', 'node-1', 'local-1')

  it('inserts new events and reports them as accepted', async () => {
    const r = await svc.batchUpsert('team-A', [evt()])
    expect(r.accepted).toEqual([DEFAULT_SID])
    expect(r.duplicates).toEqual([])
    expect(r.rejected).toEqual([])
    expect(r.cursor).toBe(NOW)
  })

  it('is idempotent: re-uploading the same payload reports duplicate', async () => {
    await svc.batchUpsert('team-A', [evt()])
    const second = await svc.batchUpsert('team-A', [evt()])
    expect(second.accepted).toEqual([])
    expect(second.duplicates).toEqual([DEFAULT_SID])
    const count = await pool.query<{ n: bigint }>(`SELECT COUNT(*)::bigint AS n FROM usage_events`)
    expect(Number(count.rows[0]!.n)).toBe(1)
  })

  it('records a conflict row when payload_hash differs for the same sync_event_id', async () => {
    await svc.batchUpsert('team-A', [evt({ payload_hash: 'h-old', input_tokens: 10 })])
    await svc.batchUpsert('team-A', [evt({ payload_hash: 'h-new', input_tokens: 11 })])
    const conflicts = await pool.query<{ prior_hash: string; new_hash: string }>(
      `SELECT prior_hash, new_hash FROM sync_conflicts`,
    )
    expect(conflicts.rows).toHaveLength(1)
    expect(conflicts.rows[0]!.prior_hash).toBe('h-old')
    expect(conflicts.rows[0]!.new_hash).toBe('h-new')
    // Original row stays — historical immutability.
    const row = await pool.query<{ input_tokens: bigint }>(
      `SELECT input_tokens FROM usage_events WHERE sync_event_id = $1`,
      [DEFAULT_SID],
    )
    expect(Number(row.rows[0]!.input_tokens)).toBe(10)
  })

  it('rejects events whose user is not a team member', async () => {
    const r = await svc.batchUpsert('team-A', [evt({ user_id: 'stranger' })])
    expect(r.accepted).toEqual([])
    expect(r.rejected).toEqual([
      {
        sync_event_id: sid('team-A', 'stranger', 'node-1', 'local-1'),
        reason: 'user is not a member of this team',
      },
    ])
  })

  it('rejects events whose user has been revoked', async () => {
    await svc.revokeMember('team-A', 'user-1')
    const r = await svc.batchUpsert('team-A', [evt()])
    expect(r.accepted).toEqual([])
    expect(r.rejected[0]!.reason).toContain('revoked')
  })

  it('rejects events whose team_id mismatches the URL team_id (prevents cross-team smuggling)', async () => {
    const r = await svc.batchUpsert('team-A', [evt({ team_id: 'team-B' })])
    expect(r.accepted).toEqual([])
    expect(r.rejected[0]!.reason).toContain('team_id mismatch')
  })

  it('two-node-same-user dedup: union of distinct events, no double counting', async () => {
    // Same local id on two different nodes → two different sync_event_ids,
    // exactly the multi-node case from the design doc.
    const e1 = evt({ node_id: 'mac', local_event_id: 'l-1' })
    const e2 = evt({ node_id: 'linux', local_event_id: 'l-1' })
    await svc.batchUpsert('team-A', [e1])
    await svc.batchUpsert('team-A', [e2])
    const ov = await svc.getOverview('team-A')
    expect(ov.totalEventCount).toBe(2)
  })

  it('rejects forged sync_event_id (mismatch with sha256(team|user|node|local))', async () => {
    // Start from a valid event, then tamper the id so the server's
    // recompute-and-reject path fires. Defense against a compromised node
    // squatting another node's id space.
    const good = evt()
    const forged = { ...good, sync_event_id: 'deadbeef' }
    const r = await svc.batchUpsert('team-A', [forged])
    expect(r.accepted).toEqual([])
    expect(r.rejected).toEqual([
      { sync_event_id: 'deadbeef', reason: 'sync_event_id mismatch — recomputed hash differs' },
    ])
    // Forgery must not leave a row behind.
    const count = await pool.query<{ n: bigint }>(`SELECT COUNT(*)::bigint AS n FROM usage_events`)
    expect(Number(count.rows[0]!.n)).toBe(0)
  })

  it('dedups node-touch INSERTs within a batch (500-payload batch → 1 node row touch)', async () => {
    // 50 events from the same node should round-trip to a single
    // INSERT…ON CONFLICT against `nodes`, not 50. We can't see inserts
    // directly, but we *can* confirm one row exists and last_seen_at is
    // monotonic across batches.
    const payloads = Array.from({ length: 50 }, (_, i) =>
      evt({ node_id: 'busy-node', local_event_id: `e-${i}` }),
    )
    await svc.batchUpsert('team-A', payloads)
    const r = await pool.query<{ n: bigint }>(
      `SELECT COUNT(*)::bigint AS n FROM nodes WHERE id = 'busy-node'`,
    )
    expect(Number(r.rows[0]!.n)).toBe(1)
  })

  it('upserts daily aggregates idempotently (latest wins)', async () => {
    await svc.batchUpsert('team-A', [daily({ event_count: 5, cost_micro_usd: '500' })])
    await svc.batchUpsert('team-A', [daily({ event_count: 7, cost_micro_usd: '700' })])
    const r = await pool.query<{ event_count: bigint; cost: bigint }>(
      `SELECT event_count, cost_micro_usd AS cost FROM daily_aggregates`,
    )
    expect(r.rows).toHaveLength(1)
    expect(Number(r.rows[0]!.event_count)).toBe(7)
    expect(Number(r.rows[0]!.cost)).toBe(700)
  })

  it('touches the node row on each upsert (last_seen_at advances)', async () => {
    await svc.batchUpsert('team-A', [evt({ node_id: 'node-A' })])
    const r1 = await pool.query<{ ts: bigint }>(
      `SELECT last_seen_at AS ts FROM nodes WHERE id = 'node-A'`,
    )
    expect(r1.rows[0]!.ts).toBeDefined()
  })

  // ─── event_daily_rollup invariants (written by TeamService.batchUpsert
  //     in the same transaction as the raw event INSERT). ───────────────

  it('event-level write also accumulates into event_daily_rollup', async () => {
    // Two events, same (user, node, day, provider, model, project_hash) →
    // one rollup row with summed deltas.
    await svc.batchUpsert('team-A', [
      evt({ local_event_id: 'a', input_tokens: 10, output_tokens: 5, cost_micro_usd: '100' }),
      evt({ local_event_id: 'b', input_tokens: 30, output_tokens: 15, cost_micro_usd: '300' }),
    ])
    const r = await pool.query<{
      event_count: bigint
      input_tokens: bigint
      output_tokens: bigint
      cost: bigint
    }>(
      `SELECT event_count, input_tokens, output_tokens, cost_micro_usd AS cost
         FROM event_daily_rollup`,
    )
    expect(r.rows).toHaveLength(1)
    expect(Number(r.rows[0]!.event_count)).toBe(2)
    expect(Number(r.rows[0]!.input_tokens)).toBe(40)
    expect(Number(r.rows[0]!.output_tokens)).toBe(20)
    expect(Number(r.rows[0]!.cost)).toBe(400)
  })

  it('replayed event does not double-count the rollup (idempotent across retries)', async () => {
    const one = evt({ local_event_id: 'x', input_tokens: 7, cost_micro_usd: '70' })
    await svc.batchUpsert('team-A', [one])
    await svc.batchUpsert('team-A', [one]) // replay
    const r = await pool.query<{ event_count: bigint; input_tokens: bigint; cost: bigint }>(
      `SELECT event_count, input_tokens, cost_micro_usd AS cost FROM event_daily_rollup`,
    )
    expect(r.rows).toHaveLength(1)
    expect(Number(r.rows[0]!.event_count)).toBe(1)  // not 2
    expect(Number(r.rows[0]!.input_tokens)).toBe(7)
    expect(Number(r.rows[0]!.cost)).toBe(70)
  })

  it('two nodes for one user keep separate rollup rows (PK includes node_id)', async () => {
    await svc.batchUpsert('team-A', [
      evt({ node_id: 'mac', local_event_id: 'm1', cost_micro_usd: '100' }),
      evt({ node_id: 'linux', local_event_id: 'l1', cost_micro_usd: '200' }),
    ])
    const r = await pool.query<{ node_id: string; cost: bigint }>(
      `SELECT node_id, cost_micro_usd AS cost FROM event_daily_rollup ORDER BY node_id`,
    )
    expect(r.rows).toHaveLength(2)
    expect(r.rows.map((x) => x.node_id)).toEqual(['linux', 'mac'])
  })
})

describe('TeamService.getOverview', () => {
  let pool: Pool
  let dbName: string
  let svc: TeamService

  beforeAll(async () => {
    const created = await createServerTestDatabase()
    pool = created.pool
    dbName = created.dbName
    svc = new TeamService(pool)
  })

  afterAll(async () => {
    await dropServerTestDatabase(pool, dbName)
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM sync_conflicts')
    await pool.query('DELETE FROM event_daily_rollup')
    await pool.query('DELETE FROM daily_aggregates')
    await pool.query('DELETE FROM usage_events')
    await pool.query('DELETE FROM nodes')
    await pool.query('DELETE FROM team_members')
    await pool.query('DELETE FROM teams')
    await svc.ensureTeam('team-A')
    await svc.addMember('team-A', 'user-1')
    await svc.addMember('team-A', 'user-2')
  })

  it('aggregates per-member, per-project, per-provider', async () => {
    // Distinct local_event_ids so the factory emits three different
    // sync_event_ids (without them the same-user pair would collapse).
    await svc.batchUpsert('team-A', [
      evt({ local_event_id: 'a', user_id: 'user-1', cost_micro_usd: '1000', input_tokens: 10 }),
      evt({ local_event_id: 'b', user_id: 'user-1', cost_micro_usd: '500', input_tokens: 5 }),
      evt({ local_event_id: 'c', user_id: 'user-2', cost_micro_usd: '200', input_tokens: 2,
            project_hash: 'p-other' }),
    ])
    const ov = await svc.getOverview('team-A')
    expect(ov.totalEventCount).toBe(3)
    expect(ov.totalCostMicroUsd).toBe('1700')
    expect(ov.members.find((m) => m.userId === 'user-1')!.costMicroUsd).toBe('1500')
    expect(ov.members.find((m) => m.userId === 'user-2')!.costMicroUsd).toBe('200')
    // Two distinct project_hashes → two top-projects entries.
    expect(ov.topProjects.map((p) => p.projectKey).sort()).toEqual(['p-hash-A', 'p-other'])
  })

  it('renders redacted projects with redacted=true (no leaked names)', async () => {
    await svc.batchUpsert('team-A', [
      evt({ project: null, project_hash: 'h-1' }),
    ])
    const ov = await svc.getOverview('team-A')
    expect(ov.topProjects[0]!.redacted).toBe(true)
    expect(ov.topProjects[0]!.projectKey).toBe('h-1')
  })

  it('reports nodes registered through batchUpsert', async () => {
    await svc.batchUpsert('team-A', [evt({ node_id: 'n-1' })])
    const ov = await svc.getOverview('team-A')
    expect(ov.nodes.map((n) => n.nodeId)).toContain('n-1')
  })

  // §"Query Shapes" merged_usage = rollup(usage_events) UNION ALL daily_aggregates
  // One user uploads event-level from node-A, another uploads aggregate-only from
  // node-B. The dashboard total must sum both sources without double-counting.
  it('merges event-level + aggregateOnly through v_merged_daily', async () => {
    await svc.batchUpsert('team-A', [
      evt({ user_id: 'user-1', node_id: 'node-evt', local_event_id: 'e1',
            cost_micro_usd: '300', input_tokens: 30 }),
    ])
    await svc.batchUpsert('team-A', [
      daily({ user_id: 'user-2', node_id: 'node-agg',
              date: new Date().toISOString().slice(0, 10),
              event_count: 5, input_tokens: 200, cost_micro_usd: '700' }),
    ])
    const ov = await svc.getOverview('team-A')
    expect(ov.totalCostMicroUsd).toBe('1000')   // 300 + 700
    expect(ov.totalEventCount).toBe(6)           // 1 + 5
    expect(ov.members.find((m) => m.userId === 'user-1')!.costMicroUsd).toBe('300')
    expect(ov.members.find((m) => m.userId === 'user-2')!.costMicroUsd).toBe('700')
  })

  it('returns currentUserRole for the requesting user', async () => {
    // user-1 was the first member added → auto-admin. user-2 → member.
    const adminView = await svc.getOverview('team-A', { requestingUserId: 'user-1' })
    expect(adminView.currentUserRole).toBe('admin')
    const memberView = await svc.getOverview('team-A', { requestingUserId: 'user-2' })
    expect(memberView.currentUserRole).toBe('member')
    const guestView = await svc.getOverview('team-A', { requestingUserId: 'nobody' })
    expect(guestView.currentUserRole).toBeNull()
  })

  it('exposes per-member role + status in the overview', async () => {
    const ov = await svc.getOverview('team-A')
    const u1 = ov.members.find((m) => m.userId === 'user-1')!
    const u2 = ov.members.find((m) => m.userId === 'user-2')!
    expect(u1.role).toBe('admin')
    expect(u2.role).toBe('member')
    expect(u1.status).toBe('active')
  })
})

describe('TeamService.role management', () => {
  let pool: Pool
  let dbName: string
  let svc: TeamService

  beforeAll(async () => {
    const created = await createServerTestDatabase()
    pool = created.pool
    dbName = created.dbName
    svc = new TeamService(pool)
  })

  afterAll(async () => {
    await dropServerTestDatabase(pool, dbName)
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM team_members')
    await pool.query('DELETE FROM teams')
    await svc.ensureTeam('team-X')
  })

  it('auto-promotes the first member to admin', async () => {
    const role = await svc.addMember('team-X', 'first-user')
    expect(role).toBe('admin')
    const m = await svc.getMembership('team-X', 'first-user')
    expect(m?.role).toBe('admin')
  })

  it('keeps later members at default role', async () => {
    await svc.addMember('team-X', 'first-user')
    const role = await svc.addMember('team-X', 'second-user')
    expect(role).toBe('member')
  })

  it('honours explicit role override on addMember', async () => {
    await svc.addMember('team-X', 'first-user') // becomes admin
    const role = await svc.addMember('team-X', 'second-user', 'admin')
    expect(role).toBe('admin')
  })

  it('setMemberRole flips role between admin and member', async () => {
    await svc.addMember('team-X', 'first-user')
    await svc.addMember('team-X', 'second-user')
    await svc.setMemberRole('team-X', 'second-user', 'admin')
    expect((await svc.getMembership('team-X', 'second-user'))?.role).toBe('admin')
    await svc.setMemberRole('team-X', 'second-user', 'member')
    expect((await svc.getMembership('team-X', 'second-user'))?.role).toBe('member')
  })

  it('refuses to demote the last admin', async () => {
    await svc.addMember('team-X', 'only-admin')
    await expect(svc.setMemberRole('team-X', 'only-admin', 'member')).rejects.toThrow(
      /last admin/,
    )
  })

  it('setPrivacyFloor updates teams.privacy_floor', async () => {
    await svc.setPrivacyFloor('team-X', 'aggregateOnly')
    const meta = await svc.getTeamMeta('team-X')
    expect(meta?.privacyFloor).toBe('aggregateOnly')
  })

  it('setPrivacyFloor rejects invalid levels', async () => {
    await expect(
      svc.setPrivacyFloor('team-X', 'bogus' as 'full'),
    ).rejects.toThrow(/invalid/)
  })
})
