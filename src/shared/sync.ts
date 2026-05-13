// Cross-node sync types. The desktop ("node") parses local logs into
// `UsageEvent`s as today, then a sync layer optionally uploads a redacted
// projection to a team backend keyed by (teamId, userId, nodeId). Raw local
// data is unchanged — sync is opt-in and additive.
//
// See `plan.md` Phase 5 for product goals + acceptance tests.

import type { UsageEvent } from './usage-event'

// How much detail to upload per event. Default in production should be
// `redacted`; admins can require `aggregateOnly` for sensitive teams.
export type PrivacyLevel = 'full' | 'redacted' | 'aggregateOnly'

// Stable identifier for a sync target. Passed to the server.
// SECRET tokens never live here — they go through OS keychain via
// AuthService and are attached at request time.
export interface TeamSyncSettings {
  enabled: boolean
  // The team this node syncs to. null when the user hasn't picked one yet.
  teamId: string | null
  // Logical user (often the signed-in Google sub). Optional in v1: when null,
  // the server-side membership lookup falls back to the access-token claim.
  userId: string | null
  // Backend base URL, e.g. https://sync.example.com. Trailing slashes stripped.
  serverUrl: string | null
  // Default redaction. Can be overridden server-side by team policy.
  privacyLevel: PrivacyLevel
  // Minimum interval between successful uploads. SyncQueue's cadence gate
  // enforces this; the main-process wake-up tick is a fixed sub-cadence
  // (currently 5 minutes) so failed→retry recovery doesn't stretch a full
  // day. Floor is 30s to keep idle traffic minimal.
  intervalMs: number
}

export const DEFAULT_TEAM_SYNC: TeamSyncSettings = {
  enabled: false,
  teamId: null,
  userId: null,
  serverUrl: null,
  privacyLevel: 'redacted',
  // Default to one upload per day. Users can dial down via the settings
  // UI; the server-side row-level locking keeps high-frequency uploads
  // safe too (see test "concurrency B").
  intervalMs: 24 * 60 * 60 * 1000,
}

// Per-event payload uploaded to the server. The discriminator is `kind`:
//
//  - `event` — a single usage row, possibly redacted. `local_event_id` lets
//    the node reconcile server-acked rows back to its own SQLite.
//  - `daily` — a pre-aggregated bucket for `aggregateOnly` mode. The server
//    must NOT receive event-level rows in this mode.
//
// Numeric fields are JSON numbers (safe for token counts) but
// `cost_micro_usd` is sent as a string to preserve full bigint precision.
export type SyncPayload = SyncedEventV1 | SyncedDailyV1

export interface SyncedEventV1 {
  kind: 'event'
  event_version: 1
  // Deterministic: sha256(team_id|user_id|node_id|local_event_id). The
  // server uses this as the primary key, so retries are idempotent.
  sync_event_id: string
  team_id: string
  user_id: string
  node_id: string
  local_event_id: string
  // Hash of the full pre-redaction payload — lets the server detect drift
  // when the same sync_event_id is uploaded with different content (e.g.
  // a parser upgrade re-bucketed cache tokens).
  payload_hash: string
  privacy_level: PrivacyLevel
  captured_at: number
  synced_at: number | null

  provider: string
  provider_raw_tag: string | null
  model: string
  timestamp: number

  // After redaction these may carry a sha256 marker rather than the raw
  // value. Servers MUST NOT attempt to reverse — the source-of-truth for
  // the human-readable name lives on the originating node.
  project: string | null
  project_hash: string | null
  session_id: string | null
  message_id: string | null

  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_5m_tokens: number
  cache_creation_1h_tokens: number
  reasoning_tokens: number | null
  tool_call_count: number | null
  latency_ms: number | null

  cost_micro_usd: string
  pricing_snapshot_version: string
}

// `aggregateOnly` upload: a single day×provider×model row. No event ids.
export interface SyncedDailyV1 {
  kind: 'daily'
  event_version: 1
  team_id: string
  user_id: string
  node_id: string
  // The day key ('YYYY-MM-DD' UTC). Same key over multiple uploads is an
  // idempotent overwrite — the latest one wins.
  date: string
  provider: string
  model: string
  // Sum of contributing events; the client computes locally.
  event_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_5m_tokens: number
  cache_creation_1h_tokens: number
  reasoning_tokens: number
  cost_micro_usd: string
  pricing_snapshot_version: string
}

// Shape returned by POST /v1/teams/:teamId/events:batchUpsert.
export interface BatchUpsertResponse {
  // sync_event_ids the server accepted. The node uses this list to advance
  // its cursor; ids missing from the response are retried next round.
  accepted: string[]
  // Optional server-side dedup hint: ids the server already had with the
  // exact same payload_hash. Counts toward "accepted" for cursor purposes.
  duplicates: string[]
  // ids the server explicitly rejected (e.g. membership lapsed). The node
  // should NOT retry these without operator intervention.
  rejected: { sync_event_id: string; reason: string }[]
  // New high-water mark for the node's cursor: the max(timestamp) the
  // server has acknowledged. The node persists this and queries
  // `WHERE timestamp > cursor` next round.
  cursor: number
}

// Status visible to the renderer for the sync settings panel.
export interface SyncStatus {
  configured: boolean
  enabled: boolean
  // Last successful drain (ms epoch, or null on cold start).
  lastSyncAt: number | null
  // Earliest time the next scheduled drain will actually upload. Equals
  // lastSyncAt + intervalMs when both are set; null while disabled or
  // before the first sync. Renderer uses it for "Next sync at HH:MM"
  // UI hints and to grey out the Sync-Now button only when needed.
  nextSyncAt: number | null
  // How many local events are still ahead of the cursor.
  pendingCount: number
  // Last error message, if any. Cleared on next success.
  lastError: string | null
  // Local node id — useful for users debugging "why doesn't this row show
  // up on the team dashboard" by matching against the server-side log.
  nodeId: string
}

// ── pure helpers ──────────────────────────────────────────────────────────

// Deterministic id used as the server primary key. SHA-256 hex, ASCII-safe.
//
// We re-export the algorithm name in the type so the server can match it
// without copying constants. If we ever rotate algorithms we'll add
// `sync_event_id_v2` rather than mutate v1.
export const SYNC_EVENT_ID_HASH = 'sha256' as const

// Computed deterministically from the four ids — same input always yields
// the same id, on any node, in any version of this code. Purely string-based
// so it's safe for both Node (server) and the renderer (browser stub).
export function syncEventIdInput(
  teamId: string,
  userId: string,
  nodeId: string,
  localEventId: string,
): string {
  return `${teamId}|${userId}|${nodeId}|${localEventId}`
}

// Stringify a UsageEvent's invariant payload for the `payload_hash` field.
// Order matters — keep it stable across versions.
export function payloadHashInput(e: UsageEvent): string {
  return [
    e.id,
    e.provider,
    e.model,
    e.timestamp,
    e.project ?? '',
    e.sessionId ?? '',
    e.messageId ?? '',
    e.inputTokens,
    e.outputTokens,
    e.cacheReadTokens,
    e.cacheCreation5mTokens,
    e.cacheCreation1hTokens,
    e.reasoningTokens ?? '',
    e.computedCostMicroUsd.toString(),
    e.pricingSnapshotVersion,
  ].join('|')
}
