import { createHash } from 'node:crypto'

import type pg from 'pg'

import type {
  BatchUpsertResponse,
  SyncedDailyV1,
  SyncedEventV1,
  SyncPayload,
} from '../src/shared/sync'
import { syncEventIdInput } from '../src/shared/sync'
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

// Role gates the management surface. 'admin' can add/remove members,
// promote/demote, and change the privacy floor; 'member' is read-only.
export type MemberRole = 'admin' | 'member'

export interface MembershipRow {
  teamId: string
  userId: string
  status: MemberStatus
  role: MemberRole
}

export interface TeamMeta {
  teamId: string
  name: string
  privacyFloor: 'full' | 'redacted' | 'aggregateOnly'
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

  // Adds (or reactivates) a member. Auto-promotes the very first member
  // of a team to admin so the bootstrapping user has the management
  // surface — subsequent additions default to 'member' unless overridden.
  // The auto-promote check runs *inside* the transaction so a race
  // between two concurrent first inserts can't end up with zero admins.
  async addMember(
    teamId: string,
    userId: string,
    role?: MemberRole,
    displayName?: string,
  ): Promise<MemberRole> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Lock teams row to serialize first-member elections per team.
      await client.query(`SELECT id FROM teams WHERE id = $1 FOR UPDATE`, [teamId])
      let effectiveRole: MemberRole = role ?? 'member'
      if (role === undefined) {
        const r = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM team_members WHERE team_id = $1 AND role = 'admin'`,
          [teamId],
        )
        if (Number(r.rows[0]?.count ?? '0') === 0) {
          effectiveRole = 'admin'
        }
      }
      await client.query(
        `INSERT INTO team_members (team_id, user_id, role, status, display_name, joined_at)
         VALUES ($1, $2, $3, 'active', $4, $5)
         ON CONFLICT (team_id, user_id)
         DO UPDATE SET status = 'active',
                       removed_at = NULL,
                       display_name = COALESCE(EXCLUDED.display_name, team_members.display_name)`,
        [teamId, userId, effectiveRole, displayName ?? null, BigInt(Date.now())],
      )
      await client.query('COMMIT')
      return effectiveRole
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async revokeMember(teamId: string, userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE team_members SET status = 'revoked', removed_at = $1
       WHERE team_id = $2 AND user_id = $3`,
      [BigInt(Date.now()), teamId, userId],
    )
  }

  // Change a member's role. Refuses to demote the last admin so a team
  // can never end up unmanageable (caller gets 'invalid').
  async setMemberRole(teamId: string, userId: string, role: MemberRole): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const cur = await client.query<{ role: MemberRole }>(
        `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
        [teamId, userId],
      )
      if (cur.rows.length === 0) {
        throw new TeamServiceError('not_found', 'member not found')
      }
      if (cur.rows[0]!.role === 'admin' && role !== 'admin') {
        const others = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM team_members
             WHERE team_id = $1 AND role = 'admin' AND user_id <> $2`,
          [teamId, userId],
        )
        if (Number(others.rows[0]?.count ?? '0') === 0) {
          throw new TeamServiceError('invalid', 'cannot demote the last admin')
        }
      }
      await client.query(
        `UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3`,
        [role, teamId, userId],
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async setPrivacyFloor(teamId: string, level: 'full' | 'redacted' | 'aggregateOnly'): Promise<void> {
    if (level !== 'full' && level !== 'redacted' && level !== 'aggregateOnly') {
      throw new TeamServiceError('invalid', `invalid privacy level: ${level}`)
    }
    const r = await this.pool.query(
      `UPDATE teams SET privacy_floor = $1 WHERE id = $2`,
      [level, teamId],
    )
    if (r.rowCount === 0) {
      throw new TeamServiceError('not_found', 'team not found')
    }
  }

  async getTeamMeta(teamId: string): Promise<TeamMeta | null> {
    const r = await this.pool.query<{
      name: string
      privacy_floor: 'full' | 'redacted' | 'aggregateOnly'
    }>(`SELECT name, privacy_floor FROM teams WHERE id = $1`, [teamId])
    if (r.rows.length === 0) return null
    return {
      teamId,
      name: r.rows[0]!.name,
      privacyFloor: r.rows[0]!.privacy_floor,
    }
  }

  async getMembership(teamId: string, userId: string): Promise<MembershipRow | null> {
    const r = await this.pool.query<{ status: MemberStatus; role: MemberRole }>(
      `SELECT status, role FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId],
    )
    if (r.rows.length === 0) return null
    return {
      teamId,
      userId,
      status: r.rows[0]!.status,
      role: r.rows[0]!.role,
    }
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

    // Cache memberships per (team, user) inside this batch. 500 payloads
    // from the same user collapse to one membership lookup.
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

    // Stable batch timestamp so every node row in this transaction agrees
    // on last_seen_at — clock skew inside a batch is meaningless.
    const batchNow = BigInt(Date.now())
    const touchedNodes = new Set<string>()

    // Roll up only the events that *actually got inserted* (skip dups +
    // conflicts so retries don't double-count). Keyed by the full PK of
    // event_daily_rollup. 500 same-day same-model events from one node
    // collapse into a single UPSERT below.
    interface RollupBucket {
      user_id: string
      node_id: string
      date: string
      provider: string
      model: string
      project_hash: string
      event_count: number
      input_tokens: bigint
      output_tokens: bigint
      cache_read_tokens: bigint
      cache_creation_5m_tokens: bigint
      cache_creation_1h_tokens: bigint
      reasoning_tokens: bigint
      cost_micro_usd: bigint
      pricing_snapshot_version: string
    }
    const rollupDeltas = new Map<string, RollupBucket>()

    const idOf = (p: SyncPayload): string =>
      p.kind === 'event' ? p.sync_event_id : `${p.date}|${p.provider}|${p.model}`

    // UTC day bucket — matches src/main/sync/redaction.ts so event-level
    // rollup days line up with aggregateOnly client days.
    const dayBucketUtc = (ts: number): string => new Date(ts).toISOString().slice(0, 10)

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      for (const p of payloads) {
        if (p.team_id !== teamId) {
          rejected.push({ sync_event_id: idOf(p), reason: 'team_id mismatch with URL' })
          continue
        }

        // sync_event_id forgery guard: recompute the canonical hash and
        // reject when the client-submitted id doesn't match. Cheap (one
        // sha256 per event) and stops a compromised node from squatting
        // another node's id space. Only applies to event-kind payloads;
        // daily buckets are dedup'd by their composite PK.
        if (p.kind === 'event') {
          const expected = createHash('sha256')
            .update(syncEventIdInput(teamId, p.user_id, p.node_id, p.local_event_id))
            .digest('hex')
          if (expected !== p.sync_event_id) {
            rejected.push({
              sync_event_id: p.sync_event_id,
              reason: 'sync_event_id mismatch — recomputed hash differs',
            })
            continue
          }
        }

        const memberStatus = await checkMember(p.user_id)
        if (memberStatus === null) {
          rejected.push({ sync_event_id: idOf(p), reason: 'user is not a member of this team' })
          continue
        }
        if (memberStatus !== 'active') {
          rejected.push({ sync_event_id: idOf(p), reason: `membership is ${memberStatus}` })
          continue
        }

        // Touch each unique node at most once per batch. 500 payloads from
        // one node collapse to one INSERT…ON CONFLICT instead of 500.
        const nodeKey = `${p.user_id}|${p.node_id}`
        if (!touchedNodes.has(nodeKey)) {
          touchedNodes.add(nodeKey)
          await client.query(
            `INSERT INTO nodes (id, user_id, team_id, enrolled_at, last_seen_at)
             VALUES ($1, $2, $3, $4, $4)
             ON CONFLICT (id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
            [p.node_id, p.user_id, teamId, batchNow],
          )
        }

        if (p.kind === 'event') {
          const acceptedFlag = await this.upsertEvent(client, p)
          if (acceptedFlag === 'inserted') {
            accepted.push(p.sync_event_id)
            // Bucket the delta for a single grouped UPSERT later. Only
            // 'inserted' rows count — 'duplicate' / 'conflict' must not
            // touch the rollup or retries would over-count.
            const date = dayBucketUtc(p.timestamp)
            const projectHash = p.project_hash ?? ''
            const key = `${p.user_id}|${p.node_id}|${date}|${p.provider}|${p.model}|${projectHash}`
            const cur = rollupDeltas.get(key)
            if (cur === undefined) {
              rollupDeltas.set(key, {
                user_id: p.user_id,
                node_id: p.node_id,
                date,
                provider: p.provider,
                model: p.model,
                project_hash: projectHash,
                event_count: 1,
                input_tokens: BigInt(p.input_tokens),
                output_tokens: BigInt(p.output_tokens),
                cache_read_tokens: BigInt(p.cache_read_tokens),
                cache_creation_5m_tokens: BigInt(p.cache_creation_5m_tokens),
                cache_creation_1h_tokens: BigInt(p.cache_creation_1h_tokens),
                reasoning_tokens: BigInt(p.reasoning_tokens ?? 0),
                cost_micro_usd: BigInt(p.cost_micro_usd),
                pricing_snapshot_version: p.pricing_snapshot_version,
              })
            } else {
              cur.event_count += 1
              cur.input_tokens += BigInt(p.input_tokens)
              cur.output_tokens += BigInt(p.output_tokens)
              cur.cache_read_tokens += BigInt(p.cache_read_tokens)
              cur.cache_creation_5m_tokens += BigInt(p.cache_creation_5m_tokens)
              cur.cache_creation_1h_tokens += BigInt(p.cache_creation_1h_tokens)
              cur.reasoning_tokens += BigInt(p.reasoning_tokens ?? 0)
              cur.cost_micro_usd += BigInt(p.cost_micro_usd)
              // Last writer wins for the snapshot label.
              cur.pricing_snapshot_version = p.pricing_snapshot_version
            }
          } else if (acceptedFlag === 'duplicate') {
            duplicates.push(p.sync_event_id)
          } else if (acceptedFlag === 'conflict') {
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

      // Emit one accumulating UPSERT per (user, node, date, provider,
      // model, project_hash) group. Same transaction as the raw inserts
      // → either both sides land or both roll back. Idempotent: a row
      // that hit ON CONFLICT in usage_events was excluded above, so we
      // never accumulate the same delta twice.
      for (const d of rollupDeltas.values()) {
        await client.query(
          `INSERT INTO event_daily_rollup (
             team_id, user_id, node_id, date, provider, model, project_hash,
             event_count, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens,
             reasoning_tokens, cost_micro_usd, pricing_snapshot_version, uploaded_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (team_id, user_id, node_id, date, provider, model, project_hash)
           DO UPDATE SET
             event_count              = event_daily_rollup.event_count              + EXCLUDED.event_count,
             input_tokens             = event_daily_rollup.input_tokens             + EXCLUDED.input_tokens,
             output_tokens            = event_daily_rollup.output_tokens            + EXCLUDED.output_tokens,
             cache_read_tokens        = event_daily_rollup.cache_read_tokens        + EXCLUDED.cache_read_tokens,
             cache_creation_5m_tokens = event_daily_rollup.cache_creation_5m_tokens + EXCLUDED.cache_creation_5m_tokens,
             cache_creation_1h_tokens = event_daily_rollup.cache_creation_1h_tokens + EXCLUDED.cache_creation_1h_tokens,
             reasoning_tokens         = event_daily_rollup.reasoning_tokens         + EXCLUDED.reasoning_tokens,
             cost_micro_usd           = event_daily_rollup.cost_micro_usd           + EXCLUDED.cost_micro_usd,
             pricing_snapshot_version = EXCLUDED.pricing_snapshot_version,
             uploaded_at              = EXCLUDED.uploaded_at`,
          [
            teamId, d.user_id, d.node_id, d.date, d.provider, d.model, d.project_hash,
            BigInt(d.event_count), d.input_tokens, d.output_tokens,
            d.cache_read_tokens, d.cache_creation_5m_tokens, d.cache_creation_1h_tokens,
            d.reasoning_tokens, d.cost_micro_usd,
            d.pricing_snapshot_version, batchNow,
          ],
        )
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
  // requestingUserId is used to surface that user's own role on the
  // overview so the renderer can gate the management UI.
  //
  // Reads go through `v_merged_daily` — the UNION of daily_aggregates
  // (privacy=aggregateOnly clients) and event_daily_rollup (server-
  // maintained rollup of event-level uploads). This keeps the dashboard
  // off the raw events table for 30-day windows, per design.md
  // §"Rollup Path". Today's KPI still uses raw events (sub-day
  // granularity is the whole point of that card) but the window is short
  // and supported by usage_events_team_ts_idx.
  async getOverview(
    teamId: string,
    opts: { requestingUserId?: string; windowMs?: number } = {},
  ): Promise<TeamOverview> {
    const windowMs = opts.windowMs ?? 30 * 24 * 3600_000
    const now = Date.now()
    const since = now - windowMs
    // Rollup is keyed by 'YYYY-MM-DD' UTC strings; pre-format the bound.
    // The window is inclusive of the entire `sinceDate` day even when
    // `since` lands mid-day; under-counting is worse than over-counting
    // by a few hours of partial-day data on the trailing edge.
    const sinceDate = new Date(since).toISOString().slice(0, 10)

    // Today window starts at the most recent UTC midnight. Cheap lower
    // bound for the KPI 'cost today' card — pulse-style dashboard wants
    // it without an extra round-trip.
    const todayStart = new Date(now)
    todayStart.setUTCHours(0, 0, 0, 0)
    const todaySince = todayStart.getTime()

    // Members + their event totals + role/status. Joined against the
    // merged rollup so 30-day SUMs are over (users × nodes × models)
    // rows, not millions of raw events.
    const memberRows = await this.pool.query<{
      user_id: string
      display_name: string | null
      role: MemberRole
      status: MemberStatus
      cost: bigint
      event_count: bigint
      input_tokens: bigint
      output_tokens: bigint
      last_seen_at: bigint | null
    }>(
      `SELECT m.user_id,
              m.display_name,
              m.role,
              m.status,
              COALESCE(SUM(d.cost_micro_usd), 0)::bigint AS cost,
              COALESCE(SUM(d.event_count), 0)::bigint AS event_count,
              COALESCE(SUM(d.input_tokens), 0)::bigint AS input_tokens,
              COALESCE(SUM(d.output_tokens), 0)::bigint AS output_tokens,
              MAX(d.uploaded_at) AS last_seen_at
       FROM team_members m
       LEFT JOIN v_merged_daily d
         ON d.team_id = m.team_id AND d.user_id = m.user_id AND d.date >= $2
       WHERE m.team_id = $1
       GROUP BY m.user_id, m.display_name, m.role, m.status
       ORDER BY cost DESC`,
      [teamId, sinceDate],
    )

    const members: TeamMemberUsage[] = memberRows.rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      role: r.role,
      status: r.status,
      costMicroUsd: r.cost.toString(),
      eventCount: Number(r.event_count),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
    }))

    const currentUserRole: MemberRole | null =
      opts.requestingUserId === undefined
        ? null
        : (members.find((m) => m.userId === opts.requestingUserId)?.role ?? null)

    // Top projects. v_merged_daily only carries `project_hash` (no raw
    // project names — rollups are post-redaction), so the dashboard
    // displays redacted=true for the project card regardless of upload
    // privacy level. AggregateOnly rows have NULL project_hash and are
    // excluded; they self-deselect from project-level reporting by
    // virtue of not sending the dimension upstream.
    const projRows = await this.pool.query<{
      project_key: string
      cost: bigint
      event_count: bigint
    }>(
      `SELECT
         project_hash AS project_key,
         COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost,
         COALESCE(SUM(event_count), 0)::bigint AS event_count
       FROM v_merged_daily
       WHERE team_id = $1 AND date >= $2 AND project_hash IS NOT NULL
       GROUP BY project_hash
       ORDER BY cost DESC
       LIMIT 8`,
      [teamId, sinceDate],
    )
    const topProjects: TeamProjectUsage[] = projRows.rows.map((r) => ({
      projectKey: r.project_key,
      redacted: true,
      costMicroUsd: r.cost.toString(),
      eventCount: Number(r.event_count),
    }))

    // Per-(provider, model) totals from the merged rollup.
    const provRows = await this.pool.query<{
      provider: string
      model: string
      cost: bigint
      event_count: bigint
    }>(
      `SELECT provider, model,
              COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost,
              COALESCE(SUM(event_count), 0)::bigint AS event_count
       FROM v_merged_daily
       WHERE team_id = $1 AND date >= $2
       GROUP BY provider, model
       ORDER BY cost DESC`,
      [teamId, sinceDate],
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
              COALESCE(SUM(event_count), 0)::bigint AS event_count
       FROM v_merged_daily WHERE team_id = $1 AND date >= $2`,
      [teamId, sinceDate],
    )

    // Today's KPI stays on raw events — sub-day granularity is exactly
    // what this card needs, the window is short (≤24h), and
    // usage_events_team_ts_idx supports it. Per design.md §"Read API
    // Boundaries" the bounded-raw rule is satisfied here.
    const todayRow = await this.pool.query<{ cost: bigint }>(
      `SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost
       FROM usage_events WHERE team_id = $1 AND timestamp >= $2`,
      [teamId, BigInt(todaySince)],
    )

    // Per-user month-to-date — from the 1st of the current calendar month
    // (UTC) to now, scoped to the requesting user across all their synced
    // nodes. Drives the Overview tab's month-end forecast when team sync
    // is on so the projection sees account-wide spend instead of just one
    // Mac. Uses v_merged_daily so it stays off raw events for the (potentially
    // 31-day-wide) window. Only computed when the caller has a userId —
    // otherwise the field stays null and the renderer falls back to local.
    const monthStartDate = new Date(now)
    monthStartDate.setUTCDate(1)
    monthStartDate.setUTCHours(0, 0, 0, 0)
    const monthSinceDate = monthStartDate.toISOString().slice(0, 10)
    let currentUserMonthCostMicroUsd: string | null = null
    let currentUserMonthByProvider: TeamProviderUsage[] = []
    if (opts.requestingUserId !== undefined && opts.requestingUserId.length > 0) {
      const monthTotalRow = await this.pool.query<{ cost: bigint }>(
        `SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost
         FROM v_merged_daily
         WHERE team_id = $1 AND user_id = $2 AND date >= $3`,
        [teamId, opts.requestingUserId, monthSinceDate],
      )
      currentUserMonthCostMicroUsd = (monthTotalRow.rows[0]?.cost ?? 0n).toString()

      const monthProvRows = await this.pool.query<{
        provider: string
        model: string
        cost: bigint
        event_count: bigint
      }>(
        `SELECT provider, model,
                COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost,
                COALESCE(SUM(event_count), 0)::bigint AS event_count
         FROM v_merged_daily
         WHERE team_id = $1 AND user_id = $2 AND date >= $3
         GROUP BY provider, model
         ORDER BY cost DESC`,
        [teamId, opts.requestingUserId, monthSinceDate],
      )
      currentUserMonthByProvider = monthProvRows.rows.map((r) => ({
        provider: r.provider,
        model: r.model,
        costMicroUsd: r.cost.toString(),
        eventCount: Number(r.event_count),
      }))
    }

    const teamMeta = await this.getTeamMeta(teamId)

    // Active node = seen in the last 24h. Cheap, deterministic, and
    // matches what the pulse-style "Active Sessions" card normally shows.
    const activeWindow = now - 24 * 3600_000
    const activeNodes = nodes.filter(
      (n) => n.lastSeenAt !== null && n.lastSeenAt >= activeWindow,
    ).length
    const activeMembers = members.filter(
      (m) => m.lastSeenAt !== null && m.lastSeenAt >= activeWindow,
    ).length

    return {
      teamId,
      teamName: teamMeta?.name ?? teamId,
      generatedAt: now,
      currentUserRole,
      privacyFloor: teamMeta?.privacyFloor ?? 'redacted',
      totalCostMicroUsd: (totalRow.rows[0]?.cost ?? 0n).toString(),
      todayCostMicroUsd: (todayRow.rows[0]?.cost ?? 0n).toString(),
      totalEventCount: Number(totalRow.rows[0]?.event_count ?? 0n),
      activeMembers,
      activeNodes,
      currentUserMonthCostMicroUsd,
      currentUserMonthByProvider,
      members,
      topProjects,
      byProvider,
      nodes,
    }
  }
}

