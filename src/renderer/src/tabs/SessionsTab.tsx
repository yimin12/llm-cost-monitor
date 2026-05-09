import type { AggregateSnapshot } from '@shared/aggregates'

import {
  formatDuration,
  microToUsd,
  providerColor,
  providerName,
  timeAgo,
} from '../lib/format'

export function SessionsTab({ agg }: { agg: AggregateSnapshot }): JSX.Element {
  const sessions = agg.recentSessions
  const lastActivity = sessions.length > 0 ? sessions[0]!.lastAt : null

  if (sessions.length === 0) {
    return (
      <>
        <section className="tab-context-head">
          <span className="tab-context-title">No sessions tracked yet</span>
          <span className="tab-context-sub">sessions appear after the first refresh picks up CLI logs</span>
        </section>
      </>
    )
  }

  return (
    <>
      <section className="tab-context-head">
        <span className="tab-context-title">{sessions.length} recent sessions</span>
        <span className="tab-context-sub">
          {lastActivity !== null ? `last activity ${timeAgo(lastActivity)} ago` : '—'}
        </span>
      </section>

      <ul className="session-list">
        {sessions.map((s) => {
          const color = providerColor(s.provider)
          const dur = s.lastAt - s.firstAt
          const projectLabel = s.project === '(none)' ? 'no project' : s.project
          // sessionId truncate — UUIDs are noisy, show only the head + tail.
          const sid = s.sessionId.length > 12
            ? `${s.sessionId.slice(0, 6)}…${s.sessionId.slice(-4)}`
            : s.sessionId
          return (
            <li key={`${s.provider}/${s.sessionId}`} className="session-row">
              <span className="session-chip" style={{ background: color, boxShadow: `0 0 8px ${color}66` }} />
              <div className="session-main">
                <span className="session-id" title={s.sessionId}>{sid}</span>
                <span className="session-meta">
                  <span className="session-provider">{providerName(s.provider)}</span>
                  <span className="session-sep">·</span>
                  <span className="session-project" title={s.project}>{projectLabel}</span>
                  <span className="session-sep">·</span>
                  <span>{s.eventCount} calls</span>
                </span>
              </div>
              <div className="session-trail">
                <span className="session-cost">{microToUsd(s.costMicroUsd)}</span>
                <span className="session-time">
                  {formatDuration(dur)} · {timeAgo(s.lastAt)} ago
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
