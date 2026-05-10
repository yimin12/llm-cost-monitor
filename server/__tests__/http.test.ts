import type { AddressInfo } from 'node:net'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { SyncedEventV1 } from '../../src/shared/sync'

import type { Pool } from '../db'
import { createApp } from '../http'
import { TeamService } from '../team-service'
import { createServerTestDatabase, dropServerTestDatabase } from './test-helpers'

const NOW = Date.now()

function evt(over: Partial<SyncedEventV1> = {}): SyncedEventV1 {
  return {
    kind: 'event',
    event_version: 1,
    sync_event_id: 'sid-1',
    team_id: 'team-A',
    user_id: 'user-1',
    node_id: 'node-1',
    local_event_id: 'local-1',
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
    ...over,
  }
}

describe('HTTP server', () => {
  let pool: Pool
  let dbName: string
  let baseUrl: string
  let server: import('node:http').Server

  beforeAll(async () => {
    const created = await createServerTestDatabase()
    pool = created.pool
    dbName = created.dbName
    const svc = new TeamService(pool)
    server = createApp({
      service: svc,
      // Test authorizer: every request is "user-1" unless the bearer is empty.
      authorize: (req) => {
        const h = req.headers['authorization']
        if (typeof h !== 'string' || !h.startsWith('Bearer ')) return { userId: null }
        const t = h.slice('Bearer '.length).trim()
        return { userId: t.length === 0 ? null : t }
      },
      log: () => {},
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await dropServerTestDatabase(pool, dbName)
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM sync_conflicts')
    await pool.query('DELETE FROM daily_aggregates')
    await pool.query('DELETE FROM usage_events')
    await pool.query('DELETE FROM nodes')
    await pool.query('DELETE FROM team_members')
    await pool.query('DELETE FROM teams')
    const svc = new TeamService(pool)
    await svc.ensureTeam('team-A')
    await svc.addMember('team-A', 'user-1')
  })

  afterEach(async () => {
    /* per-test reset done in beforeEach */
  })

  it('GET /healthz returns 200 ok', async () => {
    const r = await fetch(`${baseUrl}/healthz`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  it('POST batchUpsert without auth header → 401', async () => {
    const r = await fetch(`${baseUrl}/v1/teams/team-A/events:batchUpsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [evt()] }),
    })
    expect(r.status).toBe(401)
  })

  it('POST batchUpsert with auth happy path', async () => {
    const r = await fetch(`${baseUrl}/v1/teams/team-A/events:batchUpsert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer user-1',
      },
      body: JSON.stringify({ events: [evt()] }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { accepted: string[]; cursor: number }
    expect(body.accepted).toEqual(['sid-1'])
    expect(body.cursor).toBe(NOW)
  })

  it('GET overview returns aggregates after upserts', async () => {
    await fetch(`${baseUrl}/v1/teams/team-A/events:batchUpsert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer user-1',
      },
      body: JSON.stringify({ events: [evt({ cost_micro_usd: '777' })] }),
    })
    const r = await fetch(`${baseUrl}/v1/teams/team-A/usage`, {
      headers: { Authorization: 'Bearer user-1' },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      totalCostMicroUsd: string
      totalEventCount: number
      members: { userId: string; costMicroUsd: string }[]
    }
    expect(body.totalCostMicroUsd).toBe('777')
    expect(body.totalEventCount).toBe(1)
    expect(body.members.find((m) => m.userId === 'user-1')!.costMicroUsd).toBe('777')
  })

  it('rejects malformed JSON with 400', async () => {
    const r = await fetch(`${baseUrl}/v1/teams/team-A/events:batchUpsert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer user-1',
      },
      body: '{not-json',
    })
    expect(r.status).toBe(400)
  })

  it('returns 404 for unknown routes', async () => {
    const r = await fetch(`${baseUrl}/v1/nope`)
    expect(r.status).toBe(404)
  })

  it('admin endpoints require an admin caller', async () => {
    // Add a non-admin user-2 first.
    const svc = new TeamService(pool)
    await svc.addMember('team-A', 'user-2')

    // user-2 is a member, not admin → 403 on add-member.
    const forbidden = await fetch(`${baseUrl}/v1/teams/team-A/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer user-2' },
      body: JSON.stringify({ userId: 'user-3' }),
    })
    expect(forbidden.status).toBe(403)

    // user-1 was first → admin → 200.
    const ok = await fetch(`${baseUrl}/v1/teams/team-A/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer user-1' },
      body: JSON.stringify({ userId: 'user-3' }),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ userId: 'user-3', role: 'member' })
  })

  it('admin can revoke a member; member cannot', async () => {
    const svc = new TeamService(pool)
    await svc.addMember('team-A', 'user-2')

    const memberAttempt = await fetch(`${baseUrl}/v1/teams/team-A/members/user-1`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer user-2' },
    })
    expect(memberAttempt.status).toBe(403)

    const adminAttempt = await fetch(`${baseUrl}/v1/teams/team-A/members/user-2`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer user-1' },
    })
    expect(adminAttempt.status).toBe(200)
    const m = await svc.getMembership('team-A', 'user-2')
    expect(m?.status).toBe('revoked')
  })

  it('admin can change privacy floor', async () => {
    const r = await fetch(`${baseUrl}/v1/teams/team-A/privacy-floor`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer user-1' },
      body: JSON.stringify({ level: 'aggregateOnly' }),
    })
    expect(r.status).toBe(200)
    const meta = await new TeamService(pool).getTeamMeta('team-A')
    expect(meta?.privacyFloor).toBe('aggregateOnly')
  })

  it('PATCH role refuses to demote the last admin', async () => {
    const r = await fetch(`${baseUrl}/v1/teams/team-A/members/user-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer user-1' },
      body: JSON.stringify({ role: 'member' }),
    })
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string; message?: string }
    expect(body.error).toBe('invalid')
    expect(body.message).toMatch(/last admin/)
  })
})
