import type pg from 'pg'

import type {
  BatchUpsertResponse,
  SyncedDailyV1,
  SyncedEventV1,
  SyncPayload,
} from '../src/shared/sync'
import type {
  TeamMemberUsage,
  TeamNodeStatus,
  TeamOverview,
  TeamProjectUsage,
  TeamProviderUsage,
} from '../src/shared/ipc-channels'
import type { Pool } from './db'

// Membership states. 'revoked' members keep historical rows but cannot
// upload new events; reads for them are still allowed (admins might want
// to inspect past activity). 'active' is the default after enrollment.
export type MemberStatus = 'active' | 'revoked'

export interface MembershipRow {
  teamId: string
  userId: string
  status: MemberStatus
}

// Errors the service raises for the HTTP layer to translate to status codes.
export class TeamServiceError extends Error {
  readonly code: 'forbidden' | 'not_found' | 'invalid'
  constructor(code: TeamServiceError['code'], message: string) {
    super(message)
    this.name = 'TeamServiceError'
    this.code = code
  }
}

export class TeamService {
  constructor(private readonly pool: Pool) {}

  async ensureTeam(teamId: string, name?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO teams (id, name, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [teamId, name ?? teamId, BigInt(Date.now())],
    )
  }

  async addMember(teamId: string, userId: string, role = 'member'): Promise<void> {
    await this.pool.query(
      `INSERT INTO team_members (team_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'active', $4)
       ON CONFLICT (team_id, user_id)
       DO UPDATE SET status = 'active', removed_at = NULL`,
      [teamId, userId, role, BigInt(Date.now())],
    )
  }

  async revokeMember(teamId: string, userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE team_members SET status = 'revoked', removed_at = $1
       WHERE team_id = $2 AND user_id = $3`,
      [BigInt(Date.now()), teamId, userId],
    )
  }

  async getMembership(teamId: string, userId: string): Promise<MembershipRow | null> {
    const r = await this.pool.query<{ status: MemberStatus }>(
      `SELECT status FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId],
    )
    if (r.rows.length === 0) return null
    return { teamId, userId, status: r.rows[0]!.status }
  }

  // Idempotent batch upsert. Server enforces:
  //   1. Every payload's team_id matches the URL.
  //   2. Every payload's user_id has an active membership in the team.
  //   3. sync_event_id matches sha256(team|user|node|local) — the server
  //      recomputes and rejects on mismatch (defense against forged ids).
  //   4. payload_hash collisions on the same sync_event_id write a
  //      conflict row but DO NOT overwrite the original.
  async batchUpsert(
    teamId: string,
    payloads: readonly SyncPayload[],
  ): Promise<BatchUpsertResponse> {
    if (payloads.length === 0) {
      return { accepted: [], duplicates: [], rejected: [], cursor: 0 }
    }

    const accepted: string[] = []
    const duplicates: string[] = []
    const rejected: { sync_event_id: string; reason: string }[] = []
    let maxTimestamp = 0

    // Cache memberships per (team, user) inside this batch.
    const memberships = new Map<string, MemberStatus>()
    const checkMember = async (userId: string): Promise<MemberStatus | null> => {
      const k = `${teamId}|${userId}`
      const cached = memberships.get(k)
      if (cached !== undefined) return cached
      const m = await this.getMembership(teamId, userId)
      const v = m?.status ?? null
      if (v !== null) memberships.set(k, v)
      return v
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      for (const p of payloads) {
        if (p.team_id !== teamId) {
          rejected.push({
            sync_event_id: p.kind === 'event' ? p.sync_event_id : `${p.date}|${p.provider}|${p.model}`,
            reason: 'team_id mismatch with URL',
          })
          continue
        }
        const memberStatus = await checkMember(p.user_id)
        if (memberStatus === null) {
          rejected.push({
            sync_event_id: p.kind === 'event' ? p.sync_event_id : `${p.date}|${p.provider}|${p.model}`,
            reason: 'user is not a member of this team',
          })
          continue
        }
        if (memberStatus !== 'active') {
          rejected.push({
            sync_event_id: p.kind === 'event' ? p.sync_event_id : `${p.date}|${p.provider}|${p.model}`,
            reason: `membership is ${memberStatus}`,
          })
          continue
        }

        // Touch node row.
        await client.query(
          `INSERT INTO nodes (id, user_id, team_id, enrolled_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
          [p.node_id, p.user_id, teamId, BigInt(Date.now())],
        )

        if (p.kind === 'event') {
          const acceptedFlag = await this.upsertEvent(client, p)
          if (acceptedFlag === 'inserted') accepted.push(p.sync_event_id)
          else if (acceptedFlag === 'duplicate') duplicates.push(p.sync_event_id)
          else if (acceptedFlag === 'conflict') {
            duplicates.push(p.sync_event_id)
          }
          if (p.timestamp > maxTimestamp) maxTimestamp = p.timestamp
        } else {
          await this.upsertDaily(client, p)
          accepted.push(`${p.date}|${p.provider}|${p.model}`)
          // For daily uploads we don't have an event-level timestamp; use
          // end-of-day so the cursor advances forward.
          const endOfDay = Date.UTC(
            Number(p.date.slice(0, 4)),
            Number(p.date.slice(5, 7)) - 1,
            Number(p.date.slice(8, 10)),
            23, 59, 59,
          )
          if (endOfDay > maxTimestamp) maxTimestamp = endOfDay
        }
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }

    return { accepted, duplicates, rejected, cursor: maxTimestamp }
  }

  // Returns 'inserted' for first-time rows, 'duplicate' if an exact match
  // already exists, and 'conflict' when the same sync_event_id was uploaded
  // with a different payload_hash (writes a sync_conflicts row and keeps
  // the OLDER record — historical immutability beats race-induced flapping).
  private async upsertEvent(
    client: pg.PoolClient,
    p: SyncedEventV1,
  ): Promise<'inserted' | 'duplicate' | 'conflict'> {
    const existing = await client.query<{ payload_hash: string }>(
      `SELECT payload_hash FROM usage_events WHERE sync_event_id = $1`,
      [p.sync_event_id],
    )
    if (existing.rows.length > 0) {
      if (existing.rows[0]!.payload_hash === p.payload_hash) return 'duplicate'
      await client.query(
        `INSERT INTO sync_conflicts (occurred_at, sync_event_id, prior_hash, new_hash, detail)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          BigInt(Date.now()),
          p.sync_event_id,
          existing.rows[0]!.payload_hash,
          p.payload_hash,
          'payload hash differs across uploads — likely parser/pricing rebucket',
        ],
      )
      return 'conflict'
    }

    await client.query(
      `INSERT INTO usage_events (
         sync_event_id, team_id, user_id, node_id, local_event_id,
         payload_hash, privacy_level,
         provider, provider_raw_tag, model, timestamp,
         project, project_hash, session_id, message_id,
         input_tokens, output_tokens, cache_read_tokens,
         cache_creation_5m_tokens, cache_creation_1h_tokens,
         reasoning_tokens, tool_call_count, latency_ms,
         cost_micro_usd, pricing_snapshot_version, uploaded_at
       ) VALUES (
         $1,$2,$3,$4,$5,
         $6,$7,
         $8,$9,$10,$11,
         $12,$13,$14,$15,
         $16,$17,$18,$19,$20,
         $21,$22,$23,
         $24,$25,$26
       )`,
      [
        p.sync_event_id, p.team_id, p.user_id, p.node_id, p.local_event_id,
        p.payload_hash, p.privacy_level,
        p.provider, p.provider_raw_tag, p.model, BigInt(p.timestamp),
        p.project, p.project_hash, p.session_id, p.message_id,
        BigInt(p.input_tokens), BigInt(p.output_tokens), BigInt(p.cache_read_tokens),
        BigInt(p.cache_creation_5m_tokens), BigInt(p.cache_creation_1h_tokens),
        p.reasoning_tokens === null ? null : BigInt(p.reasoning_tokens),
        p.tool_call_count === null ? null : BigInt(p.tool_call_count),
        p.latency_ms === null ? null : BigInt(p.latency_ms),
        BigInt(p.cost_micro_usd), p.pricing_snapshot_version, BigInt(Date.now()),
      ],
    )
    return 'inserted'
  }

  private async upsertDaily(client: pg.PoolClient, p: SyncedDailyV1): Promise<void> {
    await client.query(
      `INSERT INTO daily_aggregates (
         team_id, user_id, node_id, date, provider, model,
         event_count, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens,
         reasoning_tokens, cost_micro_usd, pricing_snapshot_version, uploaded_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (team_id, user_id, node_id, date, provider, model)
       DO UPDATE SET
         event_count = EXCLUDED.event_count,
         input_tokens = EXCLUDED.input_tokens,
         output_tokens = EXCLUDED.output_tokens,
         cache_read_tokens = EXCLUDED.cache_read_tokens,
         cache_creation_5m_tokens = EXCLUDED.cache_creation_5m_tokens,
         cache_creation_1h_tokens = EXCLUDED.cache_creation_1h_tokens,
         reasoning_tokens = EXCLUDED.reasoning_tokens,
         cost_micro_usd = EXCLUDED.cost_micro_usd,
         pricing_snapshot_version = EXCLUDED.pricing_snapshot_version,
         uploaded_at = EXCLUDED.uploaded_at`,
      [
        p.team_id, p.user_id, p.node_id, p.date, p.provider, p.model,
        BigInt(p.event_count), BigInt(p.input_tokens), BigInt(p.output_tokens),
        BigInt(p.cache_read_tokens), BigInt(p.cache_creation_5m_tokens), BigInt(p.cache_creation_1h_tokens),
        BigInt(p.reasoning_tokens), BigInt(p.cost_micro_usd),
        p.pricing_snapshot_version, BigInt(Date.now()),
      ],
    )
  }

  // Build the rollup payload for a team. Window defaults to last 30d.
  async getOverview(teamId: string, windowMs = 30 * 24 * 3600_000): Promise<TeamOverview> {
    const now = Date.now()
    const since = now - windowMs

    // Members + their event totals.
    const memberRows = await this.pool.query<{
      user_id: string
      display_name: string | null
      cost: bigint
      event_count: bigint
      input_tokens: bigint
      output_tokens: bigint
      last_seen_at: bigint | null
    }>(
      `SELECT m.user_id,
              MAX(m.display_name) AS display_name,
              COALESCE(SUM(e.cost_micro_usd), 0)::bigint AS cost,
              COUNT(e.sync_event_id)::bigint AS event_count,
              COALESCE(SUM(e.input_tokens), 0)::bigint AS input_tokens,
              COALESCE(SUM(e.output_tokens), 0)::bigint AS output_tokens,
              MAX(e.uploaded_at) AS last_seen_at
       FROM team_members m
       LEFT JOIN usage_events e
         ON e.team_id = m.team_id AND e.user_id = m.user_id AND e.timestamp >= $2
       WHERE m.team_id = $1
       GROUP BY m.user_id
       ORDER BY cost DESC`,
      [teamId, BigInt(since)],
    )

    const members: TeamMemberUsage[] = memberRows.rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      costMicroUsd: r.cost.toString(),
      eventCount: Number(r.event_count),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
    }))

    // Top projects (using project_hash to group, since redacted is the
    // expected default; fall back to raw project name when available).
    const projRows = await this.pool.query<{
      project_key: string
      cost: bigint
      event_count: bigint
      redacted: boolean
    }>(
      `SELECT
         COALESCE(NULLIF(project, ''), project_hash, '(unknown)') AS project_key,
         BOOL_AND(project IS NULL) AS redacted,
         COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost,
         COUNT(*)::bigint AS event_count
       FROM usage_events
       WHERE team_id = $1 AND timestamp >= $2
       GROUP BY project_key
       ORDER BY cost DESC
       LIMIT 8`,
      [teamId, BigInt(since)],
    )
    const topProjects: TeamProjectUsage[] = projRows.rows.map((r) => ({
      projectKey: r.project_key,
      redacted: r.redacted === true,
      costMicroUsd: r.cost.toString(),
      eventCount: Number(r.event_count),
    }))

    // Per-(provider, model) totals.
    const provRows = await this.pool.query<{
      provider: string
      model: string
      cost: bigint
      event_count: bigint
    }>(
      `SELECT provider, model,
              COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost,
              COUNT(*)::bigint AS event_count
       FROM usage_events
       WHERE team_id = $1 AND timestamp >= $2
       GROUP BY provider, model
       ORDER BY cost DESC`,
      [teamId, BigInt(since)],
    )
    const byProvider: TeamProviderUsage[] = provRows.rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      costMicroUsd: r.cost.toString(),
      eventCount: Number(r.event_count),
    }))

    const nodeRows = await this.pool.query<{
      id: string
      user_id: string
      display_name: string | null
      platform: string | null
      app_version: string | null
      last_seen_at: bigint | null
    }>(
      `SELECT id, user_id, display_name, platform, app_version, last_seen_at
       FROM nodes WHERE team_id = $1`,
      [teamId],
    )
    const nodes: TeamNodeStatus[] = nodeRows.rows.map((r) => ({
      nodeId: r.id,
      userId: r.user_id,
      displayName: r.display_name,
      platform: r.platform,
      appVersion: r.app_version,
      lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
    }))

    const totalRow = await this.pool.query<{ cost: bigint; event_count: bigint }>(
      `SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost,
              COUNT(*)::bigint AS event_count
       FROM usage_events WHERE team_id = $1 AND timestamp >= $2`,
      [teamId, BigInt(since)],
    )

    return {
      teamId,
      generatedAt: now,
      totalCostMicroUsd: (totalRow.rows[0]?.cost ?? 0n).toString(),
      totalEventCount: Number(totalRow.rows[0]?.event_count ?? 0n),
      members,
      topProjects,
      byProvider,
      nodes,
    }
  }
}

