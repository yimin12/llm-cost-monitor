import { createHash } from 'node:crypto'

import {
  payloadHashInput,
  syncEventIdInput,
  type PrivacyLevel,
  type SyncedDailyV1,
  type SyncedEventV1,
} from '@shared/sync'
import type { UsageEvent } from '@shared/usage-event'

// Hash the input string to lowercase hex sha256.
function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function syncEventIdFor(
  teamId: string,
  userId: string,
  nodeId: string,
  localEventId: string,
): string {
  return sha256Hex(syncEventIdInput(teamId, userId, nodeId, localEventId))
}

export function payloadHashFor(e: UsageEvent): string {
  return sha256Hex(payloadHashInput(e))
}

// Hash a project name with a nodeId-derived salt so that the same project
// uploaded by two different nodes produces THE SAME server-side hash. This
// lets the team dashboard group "redacted projects" across machines for one
// user, while still preventing the server from reversing the original name.
//
// Salt strategy: per-team salt derived from the team id. Same team → same
// hash; different teams → different hashes. This means a project name that
// leaked from a removed node can't be correlated back across teams.
export function projectHash(teamId: string, project: string | null): string | null {
  if (project === null) return null
  return sha256Hex(`project|${teamId}|${project}`).slice(0, 32)
}

export interface RedactionContext {
  teamId: string
  userId: string
  nodeId: string
  capturedAt: number
}

// Convert a single local UsageEvent into the wire-format SyncedEventV1
// suitable for upload at the chosen privacy level. Pure function — no I/O.
//
// Privacy:
//   `full`         — keeps project, session, message ids verbatim. Use only
//                    for fully-trusted internal teams.
//   `redacted`     — replaces project with a stable hash; drops session+message
//                    ids; keeps tokens/cost/timestamp. The default.
//   `aggregateOnly`— do not call this function. The queue calls
//                    `redactToDaily(...)` and uploads buckets instead.
export function redactEvent(
  event: UsageEvent,
  level: Exclude<PrivacyLevel, 'aggregateOnly'>,
  ctx: RedactionContext,
): SyncedEventV1 {
  const sync_event_id = syncEventIdFor(ctx.teamId, ctx.userId, ctx.nodeId, event.id)
  const payload_hash = payloadHashFor(event)

  if (level === 'full') {
    return {
      kind: 'event',
      event_version: 1,
      sync_event_id,
      team_id: ctx.teamId,
      user_id: ctx.userId,
      node_id: ctx.nodeId,
      local_event_id: event.id,
      payload_hash,
      privacy_level: 'full',
      captured_at: ctx.capturedAt,
      synced_at: null,
      provider: event.provider,
      provider_raw_tag: event.providerRawTag,
      model: event.model,
      timestamp: event.timestamp,
      project: event.project,
      project_hash: projectHash(ctx.teamId, event.project),
      session_id: event.sessionId,
      message_id: event.messageId,
      input_tokens: event.inputTokens,
      output_tokens: event.outputTokens,
      cache_read_tokens: event.cacheReadTokens,
      cache_creation_5m_tokens: event.cacheCreation5mTokens,
      cache_creation_1h_tokens: event.cacheCreation1hTokens,
      reasoning_tokens: event.reasoningTokens,
      tool_call_count: event.toolCallCount,
      latency_ms: event.latencyMs,
      cost_micro_usd: event.computedCostMicroUsd.toString(),
      pricing_snapshot_version: event.pricingSnapshotVersion,
    }
  }

  // 'redacted'
  return {
    kind: 'event',
    event_version: 1,
    sync_event_id,
    team_id: ctx.teamId,
    user_id: ctx.userId,
    node_id: ctx.nodeId,
    local_event_id: event.id,
    payload_hash,
    privacy_level: 'redacted',
    captured_at: ctx.capturedAt,
    synced_at: null,
    provider: event.provider,
    provider_raw_tag: event.providerRawTag,
    model: event.model,
    timestamp: event.timestamp,
    project: null,
    project_hash: projectHash(ctx.teamId, event.project),
    session_id: null,
    message_id: null,
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    cache_read_tokens: event.cacheReadTokens,
    cache_creation_5m_tokens: event.cacheCreation5mTokens,
    cache_creation_1h_tokens: event.cacheCreation1hTokens,
    reasoning_tokens: event.reasoningTokens,
    // Tool call counts are stat-grade; latency could fingerprint a session
    // when combined with timestamp, so drop it under redaction.
    tool_call_count: event.toolCallCount,
    latency_ms: null,
    cost_micro_usd: event.computedCostMicroUsd.toString(),
    pricing_snapshot_version: event.pricingSnapshotVersion,
  }
}

// Bucket key — events with the same key sum into one daily row.
// Day boundary is UTC; downstream rollups can rebucket to a team timezone.
export function dailyKey(event: UsageEvent): string {
  const d = new Date(event.timestamp)
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0')
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = d.getUTCDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}|${event.provider}|${event.model}`
}

// Group events into daily buckets for `aggregateOnly` mode.
// One row per (date, provider, model) per call. Costs are summed as bigint.
export function redactToDaily(
  events: readonly UsageEvent[],
  ctx: RedactionContext,
): SyncedDailyV1[] {
  const buckets = new Map<
    string,
    {
      date: string
      provider: string
      model: string
      eventCount: number
      input: number
      output: number
      cacheRead: number
      cache5m: number
      cache1h: number
      reasoning: number
      cost: bigint
      pricingVersion: string
    }
  >()

  for (const e of events) {
    const key = dailyKey(e)
    const [date, provider, model] = key.split('|') as [string, string, string]
    const cur = buckets.get(key)
    if (cur === undefined) {
      buckets.set(key, {
        date,
        provider,
        model,
        eventCount: 1,
        input: e.inputTokens,
        output: e.outputTokens,
        cacheRead: e.cacheReadTokens,
        cache5m: e.cacheCreation5mTokens,
        cache1h: e.cacheCreation1hTokens,
        reasoning: e.reasoningTokens ?? 0,
        cost: e.computedCostMicroUsd,
        pricingVersion: e.pricingSnapshotVersion,
      })
    } else {
      cur.eventCount += 1
      cur.input += e.inputTokens
      cur.output += e.outputTokens
      cur.cacheRead += e.cacheReadTokens
      cur.cache5m += e.cacheCreation5mTokens
      cur.cache1h += e.cacheCreation1hTokens
      cur.reasoning += e.reasoningTokens ?? 0
      cur.cost = cur.cost + e.computedCostMicroUsd
      // If a bucket spans a pricing-snapshot rotation, retain the LATER
      // version — it reflects the most recent pricing the node knows.
      if (e.pricingSnapshotVersion > cur.pricingVersion) {
        cur.pricingVersion = e.pricingSnapshotVersion
      }
    }
  }

  return Array.from(buckets.values()).map((b) => ({
    kind: 'daily' as const,
    event_version: 1,
    team_id: ctx.teamId,
    user_id: ctx.userId,
    node_id: ctx.nodeId,
    date: b.date,
    provider: b.provider,
    model: b.model,
    event_count: b.eventCount,
    input_tokens: b.input,
    output_tokens: b.output,
    cache_read_tokens: b.cacheRead,
    cache_creation_5m_tokens: b.cache5m,
    cache_creation_1h_tokens: b.cache1h,
    reasoning_tokens: b.reasoning,
    cost_micro_usd: b.cost.toString(),
    pricing_snapshot_version: b.pricingVersion,
  }))
}
