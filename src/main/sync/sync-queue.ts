import {
  type PrivacyLevel,
  type SyncPayload,
  type SyncStatus,
} from '@shared/sync'
import type { UsageEvent } from '@shared/usage-event'

import type { EventRepository } from '../storage/event-repository'

import type { CursorRepository } from './cursor-repository'
import type { NodeIdentityRepository } from './node-identity'
import { redactEvent, redactToDaily } from './redaction'
import type { SyncTransport, TransportError } from './transport'

// What the queue uploads in a single tick. Capped to keep server payloads
// small and to bound the worst-case retry blast radius.
export const MAX_BATCH_SIZE = 500

export interface SyncQueueDeps {
  events: EventRepository
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
}

// The queue. Methods are explicit — no auto-start, no setInterval. The host
// process schedules `drain()` via its existing setInterval / on-event
// hooks. Easier to test, easier to reason about lifecycle.
export class SyncQueue {
  private readonly events: EventRepository
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
    this.events = deps.events
    this.cursors = deps.cursors
    this.nodes = deps.nodes
    this.transport = deps.transport
    this.getAccessToken = deps.getAccessToken
    this.now = deps.now ?? (() => Date.now())
  }

  async getStatus(cfg: DrainConfig): Promise<SyncStatus> {
    const node = await this.nodes.ensure()
    if (!cfg.enabled || cfg.teamId === null || cfg.userId === null) {
      return {
        configured: cfg.teamId !== null && cfg.userId !== null,
        enabled: cfg.enabled,
        lastSyncAt: this.lastSyncAt,
        pendingCount: 0,
        lastError: this.lastError,
        nodeId: node.nodeId,
      }
    }
    const cursor = await this.cursors.get(cfg.teamId, cfg.userId)
    const cursorMs = cursor?.lastAcknowledgedTimestampMs ?? 0
    const pending = await this.events.between(cursorMs + 1, this.now() + 1)
    return {
      configured: true,
      enabled: true,
      lastSyncAt: cursor?.lastSyncedAt ?? this.lastSyncAt,
      pendingCount: pending.length,
      lastError: cursor?.lastError ?? this.lastError,
      nodeId: node.nodeId,
    }
  }

  drain(cfg: DrainConfig): Promise<DrainOutcome> {
    if (this.inflight !== null) return this.inflight
    this.inflight = this.drainImpl(cfg).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async drainImpl(cfg: DrainConfig): Promise<DrainOutcome> {
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

    const node = await this.nodes.ensure()
    const cursor = await this.cursors.get(cfg.teamId, cfg.userId)
    const cursorMs = cursor?.lastAcknowledgedTimestampMs ?? 0

    // Pull a window of pending events. We use `between(cursor+1, now+1)`
    // so multiple events with identical timestamps still get picked up
    // (the server dedupes by sync_event_id in any case).
    const allPending = await this.events.between(cursorMs + 1, this.now() + 1)
    const pending = allPending.slice(0, MAX_BATCH_SIZE)
    if (pending.length === 0) return { ...empty, initialPending: 0 }

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
      // High-water mark: max timestamp across the batch we sent. If the
      // server only acked a subset, we still advance — rejected ids are
      // recorded in the audit log and won't be retried.
      const maxTs = pending.reduce(
        (m: number, e: UsageEvent) => (e.timestamp > m ? e.timestamp : m),
        cursorMs,
      )
      this.lastSyncAt = this.now()
      this.lastError = null
      await this.cursors.advance(cfg.teamId, cfg.userId, maxTs, this.now())

      return {
        initialPending: allPending.length,
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
      // Retryable errors leave the cursor alone — next drain re-tries the
      // same batch. Non-retryable errors also leave the cursor alone but
      // the operator must intervene (re-auth, fix server URL, etc.).
      return { ...empty, initialPending: allPending.length, error: msg }
    }
  }
}
