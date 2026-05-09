// Alert shapes shared across IPC. Numbers carried as plain JS number (status
// timestamps are millisecond ms-epoch, fit comfortably in 2^53).

export type AlertSeverity = 'info' | 'warning' | 'critical'
export type AlertStatus = 'open' | 'acked' | 'resolved' | 'snoozed'

// Stable identifier for an alert *kind*. The dedup signature embeds this so
// raising a 'system.cpu' alert doesn't suppress a future 'system.memory' one.
export type AlertType =
  | 'system.cpu'
  | 'system.memory'
  | 'cost.daily'
  | 'cost.forecast'

export interface Alert {
  id: string
  type: AlertType
  severity: AlertSeverity
  title: string
  body: string
  raisedAt: number
  status: AlertStatus
  ackedAt: number | null
  resolvedAt: number | null
  snoozedUntil: number | null
  signature: string
  metadata: Record<string, unknown> | null
}

export type AlertFilter = 'open' | 'resolved' | 'all'

export interface AlertSummary {
  open: number
  acked: number
  snoozed: number
  resolved: number
}
