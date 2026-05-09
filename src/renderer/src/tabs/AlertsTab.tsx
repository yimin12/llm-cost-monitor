import { useCallback, useEffect, useState } from 'react'

import type { Alert, AlertFilter } from '@shared/ipc-channels'

import { timeAgo } from '../lib/format'

const SEVERITY_TO_LABEL: Record<string, string> = {
  info: 'info',
  warning: 'warning',
  critical: 'critical',
}

function severityCount(alerts: Alert[]): { warning: number; critical: number; info: number } {
  let warning = 0
  let critical = 0
  let info = 0
  for (const a of alerts) {
    if (a.status === 'resolved') continue
    if (a.severity === 'critical') critical++
    else if (a.severity === 'warning') warning++
    else info++
  }
  return { warning, critical, info }
}

interface AlertCardProps {
  alert: Alert
  busyId: string | null
  onAck: (id: string) => void
  onResolve: (id: string) => void
  onSnooze: (id: string) => void
}

function AlertCard({ alert, busyId, onAck, onResolve, onSnooze }: AlertCardProps): JSX.Element {
  const isBusy = busyId === alert.id
  const dimmed = alert.status === 'resolved' || alert.status === 'acked'
  return (
    <article className={`alert-card sev-${alert.severity} status-${alert.status}`} data-dimmed={dimmed}>
      <header className="alert-card-head">
        <span className={`alert-dot sev-${alert.severity}`} aria-hidden />
        <span className="alert-title">{alert.title}</span>
        <span className="alert-time" title={new Date(alert.raisedAt).toLocaleString()}>
          {timeAgo(alert.raisedAt)} ago
        </span>
      </header>
      <p className="alert-body">{alert.body}</p>
      {alert.status === 'snoozed' && alert.snoozedUntil !== null && (
        <p className="alert-meta">
          Snoozed until {new Date(alert.snoozedUntil).toLocaleTimeString()}
        </p>
      )}
      {alert.status === 'acked' && alert.ackedAt !== null && (
        <p className="alert-meta">Acked {timeAgo(alert.ackedAt)} ago</p>
      )}
      {alert.status === 'resolved' && alert.resolvedAt !== null && (
        <p className="alert-meta">Resolved {timeAgo(alert.resolvedAt)} ago</p>
      )}
      {alert.status !== 'resolved' && (
        <div className="alert-actions">
          <button
            type="button"
            className="alert-btn alert-btn-ack"
            disabled={isBusy || alert.status === 'acked'}
            onClick={() => onAck(alert.id)}
          >
            Ack
          </button>
          <button
            type="button"
            className="alert-btn alert-btn-resolve"
            disabled={isBusy}
            onClick={() => onResolve(alert.id)}
          >
            Resolve
          </button>
          <button
            type="button"
            className="alert-btn alert-btn-snooze"
            disabled={isBusy || alert.status === 'snoozed'}
            onClick={() => onSnooze(alert.id)}
          >
            Snooze
          </button>
        </div>
      )}
    </article>
  )
}

export function AlertsTab(): JSX.Element {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [filter, setFilter] = useState<AlertFilter>('open')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [resolvingAll, setResolvingAll] = useState(false)

  const reload = useCallback(async () => {
    const list = await window.api.alertsList(filter)
    setAlerts(list)
  }, [filter])

  useEffect(() => {
    void reload()
    return window.api.onAlertsUpdated(() => {
      void reload()
    })
  }, [reload])

  const handleAck = useCallback(async (id: string) => {
    setBusyId(id)
    try { await window.api.alertsAck(id) } finally { setBusyId(null) }
  }, [])
  const handleResolve = useCallback(async (id: string) => {
    setBusyId(id)
    try { await window.api.alertsResolve(id) } finally { setBusyId(null) }
  }, [])
  const handleSnooze = useCallback(async (id: string) => {
    setBusyId(id)
    try { await window.api.alertsSnooze(id) } finally { setBusyId(null) }
  }, [])
  const handleResolveAll = useCallback(async () => {
    if (alerts.length === 0) return
    setResolvingAll(true)
    try { await window.api.alertsResolveAll() } finally { setResolvingAll(false) }
  }, [alerts.length])

  const counts = severityCount(alerts)
  const openLikeCount = alerts.filter((a) => a.status !== 'resolved').length

  return (
    <>
      <section className="alerts-head">
        <div className="alerts-title-row">
          <h2 className="alerts-title">Alerts</h2>
          {counts.critical > 0 && (
            <span className="alerts-pill critical">{counts.critical} critical</span>
          )}
          {counts.warning > 0 && (
            <span className="alerts-pill warning">{counts.warning} warning</span>
          )}
          {counts.critical + counts.warning + counts.info === 0 && filter !== 'resolved' && (
            <span className="alerts-pill ok">all clear</span>
          )}
        </div>
        <div className="alerts-filter-row">
          <div className="alerts-filter">
            {(['open', 'resolved', 'all'] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={filter === f ? 'alerts-filter-tab active' : 'alerts-filter-tab'}
                onClick={() => setFilter(f)}
              >
                {f === 'open' ? 'Open' : f === 'resolved' ? 'Resolved' : 'All'}
              </button>
            ))}
          </div>
          {filter === 'open' && openLikeCount > 0 && (
            <button
              type="button"
              className="alerts-resolve-all"
              disabled={resolvingAll}
              onClick={() => void handleResolveAll()}
            >
              {resolvingAll ? 'Resolving…' : 'Resolve All'}
            </button>
          )}
        </div>
      </section>

      {alerts.length === 0 ? (
        <p className="alerts-empty">
          {filter === 'open'
            ? 'No open alerts. Your machine and spend are within thresholds.'
            : filter === 'resolved'
              ? 'No resolved alerts yet.'
              : 'No alerts have been raised.'}
        </p>
      ) : (
        <ul className="alerts-list">
          {alerts.map((a) => (
            <li key={a.id}>
              <AlertCard
                alert={a}
                busyId={busyId}
                onAck={(id) => void handleAck(id)}
                onResolve={(id) => void handleResolve(id)}
                onSnooze={(id) => void handleSnooze(id)}
              />
            </li>
          ))}
        </ul>
      )}

      <p className="alerts-foot">
        {SEVERITY_TO_LABEL.warning && null /* keep import */}
        Alerts re-evaluate every 30 seconds. Snooze hides an alert for 60 minutes;
        Resolve closes it. The same condition will re-raise after Resolve if it
        recurs.
      </p>
    </>
  )
}
