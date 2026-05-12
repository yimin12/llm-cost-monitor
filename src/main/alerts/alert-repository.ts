import type { Alert, AlertFilter, AlertSeverity, AlertStatus, AlertSummary, AlertType } from '@shared/alerts'
import type { Pool } from '../storage/connect'
import { namedQuery } from '../storage/db-utils'

interface AlertRow {
  id: string
  type: string
  severity: string
  title: string
  body: string
  raised_at: bigint
  status: string
  acked_at: bigint | null
  resolved_at: bigint | null
  snoozed_until: bigint | null
  signature: string
  metadata: Record<string, unknown> | null
}

function rowToAlert(r: AlertRow): Alert {
  return {
    id: r.id,
    type: r.type as AlertType,
    severity: r.severity as AlertSeverity,
    title: r.title,
    body: r.body,
    raisedAt: Number(r.raised_at),
    status: r.status as AlertStatus,
    ackedAt: r.acked_at !== null ? Number(r.acked_at) : null,
    resolvedAt: r.resolved_at !== null ? Number(r.resolved_at) : null,
    snoozedUntil: r.snoozed_until !== null ? Number(r.snoozed_until) : null,
    signature: r.signature,
    metadata: r.metadata,
  }
}

export interface RaiseInput {
  type: AlertType
  severity: AlertSeverity
  title: string
  body: string
  // Stable string identifying the *condition*. Same signature while a row is
  // open/snoozed/acked → no duplicate row inserted (handled by partial unique
  // index alerts_open_signature_idx).
  signature: string
  metadata?: Record<string, unknown>
}

export class AlertRepository {
  constructor(private readonly pool: Pool) {}

  // Insert if no active row with the same signature; returns the resulting
  // row when actually inserted, null when a duplicate was suppressed. The
  // sampler uses the return value to decide whether to fire an OS notification
  // (only on a fresh raise).
  async raiseIfNew(input: RaiseInput): Promise<Alert | null> {
    const q = namedQuery(
      `INSERT INTO alerts (type, severity, title, body, raised_at, signature, metadata)
       VALUES (@type, @severity, @title, @body, @raised_at, @signature, @metadata::jsonb)
       ON CONFLICT (signature) WHERE status IN ('open', 'snoozed', 'acked')
       DO NOTHING
       RETURNING *`,
      {
        type: input.type,
        severity: input.severity,
        title: input.title,
        body: input.body,
        raised_at: BigInt(Date.now()),
        signature: input.signature,
        metadata: input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
      },
    )
    const r = await this.pool.query<AlertRow>(q.text, q.values)
    return r.rows[0] !== undefined ? rowToAlert(r.rows[0]) : null
  }

  // Clamp severity of open cost.* alerts to 'warning' when the user is
  // exclusively on subscription plans — the projected $ figure isn't
  // out-of-pocket cost in that case, so a red "critical" chip is misleading.
  // Returns the number of rows downgraded.
  async downgradeOpenCostAlertsToWarning(): Promise<number> {
    const r = await this.pool.query(
      `UPDATE alerts
       SET severity = 'warning'
       WHERE severity = 'critical'
         AND status IN ('open', 'snoozed', 'acked')
         AND type LIKE 'cost.%'`,
    )
    return r.rowCount ?? 0
  }

  // Move snoozed alerts back to open when their snooze window has passed.
  // Called by the sampler before each evaluation pass.
  async unsnoozeExpired(now: number = Date.now()): Promise<number> {
    const q = namedQuery(
      `UPDATE alerts
       SET status = 'open', snoozed_until = NULL
       WHERE status = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= @now`,
      { now: BigInt(now) },
    )
    const r = await this.pool.query(q.text, q.values)
    return r.rowCount ?? 0
  }

  async list(filter: AlertFilter, limit = 200): Promise<Alert[]> {
    const where = filter === 'all'
      ? ''
      : filter === 'resolved'
        ? `WHERE status = 'resolved'`
        : `WHERE status IN ('open', 'snoozed', 'acked')`
    const q = namedQuery(
      `SELECT * FROM alerts ${where}
       ORDER BY raised_at DESC
       LIMIT @limit`,
      { limit },
    )
    const r = await this.pool.query<AlertRow>(q.text, q.values)
    return r.rows.map(rowToAlert)
  }

  async summary(): Promise<AlertSummary> {
    const r = await this.pool.query<{ status: string; n: bigint }>(
      `SELECT status, COUNT(*)::bigint AS n FROM alerts GROUP BY status`,
    )
    const out: AlertSummary = { open: 0, acked: 0, snoozed: 0, resolved: 0 }
    for (const row of r.rows) {
      if (row.status in out) {
        out[row.status as keyof AlertSummary] = Number(row.n)
      }
    }
    return out
  }

  // Count of alerts the tray should react to: actionable severity is
  // 'critical', actionable status is open or acked (snoozed/resolved
  // never paint the tray icon). Warnings are passive — they show up in
  // the dropdown but the tray ignores them.
  async openCriticalCount(): Promise<number> {
    const r = await this.pool.query<{ n: bigint }>(
      `SELECT COUNT(*)::bigint AS n FROM alerts WHERE severity = 'critical' AND status IN ('open','acked')`,
    )
    return Number(r.rows[0]?.n ?? 0n)
  }

  async ack(id: string): Promise<void> {
    const q = namedQuery(
      `UPDATE alerts SET status = 'acked', acked_at = @now WHERE id = @id::uuid AND status IN ('open','snoozed')`,
      { id, now: BigInt(Date.now()) },
    )
    await this.pool.query(q.text, q.values)
  }

  async resolve(id: string): Promise<void> {
    const q = namedQuery(
      `UPDATE alerts SET status = 'resolved', resolved_at = @now WHERE id = @id::uuid AND status <> 'resolved'`,
      { id, now: BigInt(Date.now()) },
    )
    await this.pool.query(q.text, q.values)
  }

  async snooze(id: string, untilMs: number): Promise<void> {
    const q = namedQuery(
      `UPDATE alerts SET status = 'snoozed', snoozed_until = @until WHERE id = @id::uuid AND status IN ('open','acked')`,
      { id, until: BigInt(untilMs) },
    )
    await this.pool.query(q.text, q.values)
  }

  async resolveAll(): Promise<number> {
    const r = await this.pool.query(
      `UPDATE alerts SET status = 'resolved', resolved_at = $1::bigint WHERE status IN ('open','acked','snoozed')`,
      [BigInt(Date.now())],
    )
    return r.rowCount ?? 0
  }
}
