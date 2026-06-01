import {
  type PrivacyLevel,
  type SyncPayload,
  type SyncStatus,
} from '@shared/sync'
import type { UsageEvent } from '@shared/usage-event'

import type { CursorRepository } from './cursor-repository'
import type { NodeIdentityRepository } from './node-identity'
import type { OutboxRepository } from './outbox-repository'
import { redactEvent, redactToDaily } from './redaction'
import type { SyncTransport, TransportError } from './transport'

// What the queue uploads in a single tick. Capped to keep server payloads
// small and to bound the worst-case retry blast radius.
export const MAX_BATCH_SIZE = 500

// Default cadence: drain once per day. Most teams don't need event-level
// freshness; a daily roll-up keeps server bandwidth bounded and matches
// the product spec. The renderer's "Sync Now" button bypasses this via
// SyncQueue.forceDrain().
export const DEFAULT_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface SyncQueueDeps {
  outbox: OutboxRepository
  cursors: CursorRepository
  nodes: NodeIdentityRepository
  transport: SyncTransport

  // How to fetch a fresh access token. Returns null if the user is not
  // signed in or the token is unavailable; in that case we skip and surface
  // an error for the UI.
  getAccessToken: () => Promise<string | null>

  // Override clock for tests.
  now?: () => number
}

// Runtime config injected per drain. Pulled from the user's settings; the
// queue itself is stateless beyond what's in postgres.
export interface DrainConfig {
  enabled: boolean
  teamId: string | null
  userId: string | null
  privacyLevel: PrivacyLevel
  // Minimum time between drains, in ms. Defaults to DEFAULT_SYNC_INTERVAL_MS
  // (24h). drain() returns early with `skipped: 'rate_limited'` when this
  // interval hasn't elapsed since the last successful upload; forceDrain()
  // ignores it.
  intervalMs?: number
}

// Outcome of a single drain. Surfaced through SyncStatus and the audit log.
export interface DrainOutcome {
  // Number of unsynced events at the start of the tick.
  initialPending: number
  // Number of payloads actually sent in this tick.
  uploaded: number
  // Server-acked sync_event_ids (or daily-bucket count for aggregateOnly).
  accepted: number
  duplicates: number
  rejected: number
  newCursorMs: number | null
  error: string | null
  // Set when drain() returns early because the interval window hasn't
  // elapsed. Callers (host scheduler, renderer status pane) can use this
  // to distinguish "ran but nothing to do" from "rate-limited".
  skipped?: 'rate_limited'
}

// The queue. Methods are explicit — no auto-start, no setInterval. The host
// process schedules `drain()` via its existing setInterval / on-event
// hooks. Easier to test, easier to reason about lifecycle.
export class SyncQueue {
  private readonly outbox: OutboxRepository
  private readonly cursors: CursorRepository
  private readonly nodes: NodeIdentityRepository
  private readonly transport: SyncTransport
  private readonly getAccessToken: () => Promise<string | null>
  private readonly now: () => number

  // Coalescing: while a drain is in flight, additional drain() calls return
  // the same in-flight promise instead of stacking up.
  private inflight: Promise<DrainOutcome> | null = null

  // Held in memory and surfaced via getStatus().
  private lastError: string | null = null
  private lastSyncAt: number | null = null

  constructor(deps: SyncQueueDeps) {
    this.outbox = deps.outbox
    this.cursors = deps.cursors
    this.nodes = deps.nodes
    this.transport = deps.transport
    this.getAccessToken = deps.getAccessToken
    this.now = deps.now ?? (() => Date.now())
  }

  async getStatus(cfg: DrainConfig): Promise<SyncStatus> {
    const node = await this.nodes.ensure()
    const intervalMs = cfg.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS
    if (!cfg.enabled || cfg.teamId === null || cfg.userId === null) {
      return {
        configured: cfg.teamId !== null && cfg.userId !== null,
        enabled: cfg.enabled,
        lastSyncAt: this.lastSyncAt,
        nextSyncAt: null,
        pendingCount: 0,
        lastError: this.lastError,
        nodeId: node.nodeId,
      }
    }
    const cursor = await this.cursors.get(cfg.teamId, cfg.userId)
    const lastSeq = cursor?.lastSentSeq ?? 0n
    const pendingCount = await this.outbox.pendingCount(lastSeq)
    const lastSyncAt = cursor?.lastSyncedAt ?? this.lastSyncAt
    return {
      configured: true,
      enabled: true,
      lastSyncAt,
      nextSyncAt: lastSyncAt === null ? null : lastSyncAt + intervalMs,
      pendingCount,
      lastError: cursor?.lastError ?? this.lastError,
      nodeId: node.nodeId,
    }
  }

  // Normal scheduled drain. Skips when the per-config interval hasn't
  // elapsed since the last successful sync — caller can rely on calling
  // this every few minutes without spamming the server.
  drain(cfg: DrainConfig): Promise<DrainOutcome> {
    return this.drainGated(cfg, false)
  }

  // "Sync Now" bypass. Same machinery, ignores intervalMs. Use sparingly:
  // tied to an explicit user action (button click, finished sign-in flow,
  // etc.) — not to a setInterval.
  forceDrain(cfg: DrainConfig): Promise<DrainOutcome> {
    return this.drainGated(cfg, true)
  }

  private drainGated(cfg: DrainConfig, force: boolean): Promise<DrainOutcome> {
    if (this.inflight !== null) return this.inflight
    this.inflight = this.drainImpl(cfg, force).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async drainImpl(cfg: DrainConfig, force: boolean): Promise<DrainOutcome> {
    const empty: DrainOutcome = {
      initialPending: 0,
      uploaded: 0,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
      newCursorMs: null,
      error: null,
    }
    if (!cfg.enabled || cfg.teamId === null || cfg.userId === null) return empty

    // Cadence gate. The interval is measured against the most recent
    // successful sync — failed drains do not push the window forward, so
    // a flaky server doesn't stretch the schedule. forceDrain() bypasses.
    const intervalMs = cfg.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS
    const cursorPeek = await this.cursors.get(cfg.teamId, cfg.userId)
    const lastSyncAt = cursorPeek?.lastSyncedAt ?? this.lastSyncAt
    if (!force && lastSyncAt !== null && this.now() - lastSyncAt < intervalMs) {
      return { ...empty, skipped: 'rate_limited' }
    }

    const node = await this.nodes.ensure()
    const cursor = cursorPeek
    const lastSeq = cursor?.lastSentSeq ?? 0n

    // Pull the next batch from the outbox. seq is monotonic and unique,
    // so MAX_BATCH_SIZE caps don't drop same-timestamp tail events.
    const rows = await this.outbox.pending(lastSeq, MAX_BATCH_SIZE)
    if (rows.length === 0) return empty

    const pending: UsageEvent[] = rows.map((r) => r.event)
    const maxSeq = rows[rows.length - 1]!.seq
    const initialPending = await this.outbox.pendingCount(lastSeq)

    const ctx = {
      teamId: cfg.teamId,
      userId: cfg.userId,
      nodeId: node.nodeId,
      capturedAt: this.now(),
    }

    let payloads: SyncPayload[]
    if (cfg.privacyLevel === 'aggregateOnly') {
      payloads = redactToDaily(pending, ctx)
    } else {
      const level = cfg.privacyLevel
      payloads = pending.map((e) => redactEvent(e, level, ctx))
    }

    const token = await this.getAccessToken()
    try {
      const res = await this.transport.batchUpsert(cfg.teamId, payloads, token)
      // Watermarks:
      //   - seq advances to the largest seq in the batch. Same-millisecond
      //     bursts that overflow a batch still progress because seq is
      //     unique and gap-free.
      //   - The legacy timestamp cursor is advanced to the max event ts
      //     in the batch for observability only — the queue no longer
      //     reads from it.
      const maxTs = pending.reduce(
        (m: number, e: UsageEvent) => (e.timestamp > m ? e.timestamp : m),
        cursor?.lastAcknowledgedTimestampMs ?? 0,
      )
      const sentAt = this.now()
      await this.outbox.markSent(maxSeq, sentAt)
      await this.cursors.advance(cfg.teamId, cfg.userId, maxSeq, maxTs, sentAt)
      this.lastSyncAt = sentAt
      this.lastError = null

      return {
        initialPending,
        uploaded: payloads.length,
        accepted: res.accepted.length,
        duplicates: res.duplicates.length,
        rejected: res.rejected.length,
        newCursorMs: maxTs,
        error: null,
      }
    } catch (err) {
      const e = err as TransportError
      const msg = `${e.kind ?? 'unknown'}: ${e.message}`
      this.lastError = msg
      await this.cursors.recordError(cfg.teamId, cfg.userId, msg)
      // Retryable errors leave the seq cursor alone — next drain re-pulls
      // the same outbox rows.
      return { ...empty, initialPending, error: msg }
    }
  }
}
