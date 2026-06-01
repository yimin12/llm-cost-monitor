import type { UsageEvent } from '@shared/usage-event'

import type { Pool } from '../storage/connect'
import { namedQuery } from '../storage/db-utils'

// `sync_outbox` is the queue of events that still need to be sent to
// the team server. Each event lands in the outbox at insert time with a
// monotonically increasing `seq` (BIGSERIAL). The sync queue reads from
// `seq > last_sent_seq`, uploads, then bumps `last_sent_seq`.
//
// This is the fix for the timestamp-cursor batch-boundary bug: events
// with identical millisecond timestamps still advance correctly because
// seq is unique per writer, and a capped batch never silently skips the
// tail of a same-timestamp burst.

export interface OutboxRow {
  seq: bigint
  event: UsageEvent
}

interface OutboxJoinRow {
  seq: bigint
  event_id: string
  // The full event row, joined from `events`. Mirrors EventRepository's
  // EventRow shape (kept here to avoid a public re-export from event-repository).
  provider: string
  provider_raw_tag: string | null
  model: string
  timestamp: bigint
  project: string | null
  project_raw_slug: string | null
  session_id: string | null
  message_id: string | null
  input_tokens: bigint
  output_tokens: bigint
  cache_read_tokens: bigint
  cache_creation_5m_tokens: bigint
  cache_creation_1h_tokens: bigint
  reasoning_tokens: bigint | null
  tool_call_count: bigint | null
  latency_ms: bigint | null
  computed_cost_micro_usd: bigint
  pricing_snapshot_version: string
  source_file: string
  source_line_offset: bigint
}

function joinRowToOutbox(r: OutboxJoinRow): OutboxRow {
  return {
    seq: r.seq,
    event: {
      id: r.event_id,
      provider: r.provider,
      providerRawTag: r.provider_raw_tag,
      model: r.model,
      timestamp: Number(r.timestamp),
      project: r.project,
      projectRawSlug: r.project_raw_slug,
      sessionId: r.session_id,
      messageId: r.message_id,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheCreation5mTokens: Number(r.cache_creation_5m_tokens),
      cacheCreation1hTokens: Number(r.cache_creation_1h_tokens),
      reasoningTokens: r.reasoning_tokens === null ? null : Number(r.reasoning_tokens),
      toolCallCount: r.tool_call_count === null ? null : Number(r.tool_call_count),
      latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
      computedCostMicroUsd: r.computed_cost_micro_usd,
      pricingSnapshotVersion: r.pricing_snapshot_version,
      sourceFile: r.source_file,
      sourceLineOffset: Number(r.source_line_offset),
    },
  }
}

export class OutboxRepository {
  constructor(private readonly pool: Pool) {}

  // Returns up to `limit` outbox rows with seq > afterSeq, oldest first.
  // The join to `events` lets the caller get the full row in one query.
  async pending(afterSeq: bigint, limit: number): Promise<OutboxRow[]> {
    const q = namedQuery(
      `SELECT o.seq, o.event_id, e.*
       FROM sync_outbox o
       JOIN events e ON e.id = o.event_id
       WHERE o.seq > @after AND o.sent_at IS NULL
       ORDER BY o.seq ASC
       LIMIT @lim`,
      { after: afterSeq, lim: limit },
    )
    const r = await this.pool.query<OutboxJoinRow>(q.text, q.values)
    return r.rows.map(joinRowToOutbox)
  }

  // Count of unsent rows. Used by SyncQueue.getStatus for `pendingCount`.
  async pendingCount(afterSeq: bigint): Promise<number> {
    const q = namedQuery(
      `SELECT COUNT(*)::bigint AS n FROM sync_outbox
       WHERE seq > @after AND sent_at IS NULL`,
      { after: afterSeq },
    )
    const r = await this.pool.query<{ n: bigint }>(q.text, q.values)
    return Number(r.rows[0]?.n ?? 0n)
  }

  // Mark a contiguous range as sent. The queue calls this after the
  // server acks a batch; non-contiguous acks (server rejected some ids)
  // are still marked sent here — the audit log captures rejections.
  async markSent(maxSeq: bigint, sentAt: number): Promise<void> {
    const q = namedQuery(
      `UPDATE sync_outbox SET sent_at = @ts
       WHERE seq <= @maxSeq AND sent_at IS NULL`,
      { ts: BigInt(sentAt), maxSeq },
    )
    await this.pool.query(q.text, q.values)
  }
}
