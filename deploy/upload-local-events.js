#!/usr/bin/env node
// upload-local-events.js — push THIS node's real local usage events into the
// team-sync DB on the instance, exactly as the desktop sync layer would.
//
// Reads the local store (the `events` table + `local_node` identity), maps
// each row to a SyncedEventV1, and batch-uploads to the team-sync endpoint.
// Attribution: real node_id (local_node) + real user (auth_user.sub).
// Privacy: full (literal project name), but session_id/message_id are never
// sent (what·project·who only — matches the server's drop policy).
//
//   ENDPOINT=http://127.0.0.1:14017 TEAM=team-self node deploy/upload-local-events.js
const { createHash } = require('node:crypto')
const { Pool } = require('pg')

const ENDPOINT = (process.env.ENDPOINT || 'http://127.0.0.1:14017').replace(/\/+$/, '')
const TEAM = process.env.TEAM || 'team-self'
const LOCAL_DSN = process.env.LOCAL_DSN || 'postgres://lcm:lcm_dev@127.0.0.1:5433/llm_cost_monitor'
const BATCH = Number(process.env.BATCH || '500')

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
// Mirrors syncEventIdInput() in src/shared/sync.ts (the server recomputes it).
const syncEventId = (team, user, node, local) => sha256(`${team}|${user}|${node}|${local}`)
const num = (v) => (v === null || v === undefined ? null : Number(v))

async function main() {
  const pool = new Pool({ connectionString: LOCAL_DSN })
  const node = (await pool.query('SELECT node_id, platform, app_version FROM local_node LIMIT 1')).rows[0]
  const user = (await pool.query('SELECT sub, email FROM auth_user WHERE is_active = true LIMIT 1')).rows[0]
  if (!node || !user) throw new Error('local_node or auth_user missing')
  console.log(`node=${node.node_id} user=${user.sub} (${user.email}) → ${ENDPOINT} team=${TEAM}`)

  const rows = (await pool.query(
    `SELECT id, provider, provider_raw_tag, model, timestamp, project,
            session_id, message_id, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens,
            reasoning_tokens, tool_call_count, latency_ms,
            computed_cost_micro_usd, pricing_snapshot_version
       FROM events ORDER BY timestamp ASC`,
  )).rows
  await pool.end()
  console.log(`read ${rows.length} local events`)

  const events = rows.map((r) => ({
    kind: 'event',
    event_version: 1,
    sync_event_id: syncEventId(TEAM, user.sub, node.node_id, r.id),
    team_id: TEAM,
    user_id: user.sub,
    node_id: node.node_id,
    local_event_id: r.id,
    payload_hash: sha256([r.id, r.provider, r.model, r.timestamp, r.input_tokens,
      r.output_tokens, r.cache_read_tokens, r.computed_cost_micro_usd].join('|')),
    privacy_level: 'full',
    captured_at: num(r.timestamp),
    synced_at: null,
    provider: r.provider,
    provider_raw_tag: r.provider_raw_tag,
    model: r.model,
    timestamp: num(r.timestamp),
    project: r.project,        // literal project name (full mode)
    project_hash: null,
    session_id: null,          // intentionally never uploaded
    message_id: null,
    input_tokens: num(r.input_tokens),
    output_tokens: num(r.output_tokens),
    cache_read_tokens: num(r.cache_read_tokens),
    cache_creation_5m_tokens: num(r.cache_creation_5m_tokens),
    cache_creation_1h_tokens: num(r.cache_creation_1h_tokens),
    reasoning_tokens: num(r.reasoning_tokens),
    tool_call_count: num(r.tool_call_count),
    latency_ms: num(r.latency_ms),
    cost_micro_usd: String(r.computed_cost_micro_usd),
    pricing_snapshot_version: r.pricing_snapshot_version,
  }))

  let accepted = 0, duplicates = 0, rejected = 0
  const rejSamples = []
  for (let i = 0; i < events.length; i += BATCH) {
    const slice = events.slice(i, i + BATCH)
    const res = await fetch(`${ENDPOINT}/v1/teams/${TEAM}/events:batchUpsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.sub}` },
      body: JSON.stringify({ events: slice }),
    })
    if (!res.ok) throw new Error(`batch ${i}: HTTP ${res.status} ${await res.text()}`)
    const out = await res.json()
    accepted += out.accepted?.length ?? 0
    duplicates += out.duplicates?.length ?? 0
    rejected += out.rejected?.length ?? 0
    if (out.rejected?.length && rejSamples.length < 5) rejSamples.push(...out.rejected.slice(0, 5))
    console.log(`batch ${i / BATCH + 1}: +${out.accepted?.length ?? 0} accepted, ${out.duplicates?.length ?? 0} dup, ${out.rejected?.length ?? 0} rejected`)
  }
  console.log(`\nDONE — accepted=${accepted} duplicates=${duplicates} rejected=${rejected}`)
  if (rejSamples.length) console.log('rejected samples:', JSON.stringify(rejSamples, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })
