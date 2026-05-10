import { useCallback, useEffect, useState } from 'react'

import type { AppSettings, TeamOverview } from '@shared/ipc-channels'

import { microToUsd, providerColor, providerName, timeAgo } from '../lib/format'

// Cost values arrive as strings from the server (bigint preservation). We
// convert to BigInt for math; numbers for display via microToUsd.
function asBig(s: string): bigint {
  try {
    return BigInt(s)
  } catch {
    return 0n
  }
}

// Shared Team Details button. Lives outside the early-return ladder so
// users can jump to the WebDashboard's Team Details section even when
// sync is off (the dashboard explains how to configure it).
function TeamDetailsButton({ dashboardUrl }: { dashboardUrl: string | null }): JSX.Element | null {
  if (dashboardUrl === null) return null
  return (
    <button
      type="button"
      className="dashboard-link dashboard-link-block"
      title={`Open the web view (${dashboardUrl})`}
      onClick={() => void window.api.openDashboard()}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M14 3h7v7" />
        <path d="M21 3l-9 9" />
        <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
      </svg>
      Team Details
    </button>
  )
}

export function TeamTab({ settings, dashboardUrl }: {
  settings: AppSettings | null
  dashboardUrl: string | null
}): JSX.Element {
  const [overview, setOverview] = useState<TeamOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await window.api.syncTeamOverview()
      setOverview(r)
      if (r === null) setError('Backend unreachable or sync disabled.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const cfg = settings?.teamSync

  if (cfg === undefined || !cfg.enabled) {
    return (
      <>
        <TeamDetailsButton dashboardUrl={dashboardUrl} />
        <section className="empty-tab">
          <h3>Team sync is off</h3>
          <p>
            Enable team sync in the Settings tab to upload a redacted projection
            of your usage. Members of your team will then see consolidated
            rollups here.
          </p>
        </section>
      </>
    )
  }

  if (cfg.teamId === null || cfg.userId === null || cfg.serverUrl === null) {
    return (
      <>
        <TeamDetailsButton dashboardUrl={dashboardUrl} />
        <section className="empty-tab">
          <h3>Configure team sync first</h3>
          <p>Add a server URL, team ID, and user ID in Settings → Team Sync.</p>
        </section>
      </>
    )
  }

  if (loading && overview === null) {
    return (
      <>
        <TeamDetailsButton dashboardUrl={dashboardUrl} />
        <section className="empty-tab">
          <p>loading team data…</p>
        </section>
      </>
    )
  }

  if (overview === null) {
    return (
      <>
        <TeamDetailsButton dashboardUrl={dashboardUrl} />
        <section className="empty-tab">
          <h3>No team data yet</h3>
          <p>
            {error ?? 'No events have been synced to this team yet, or the backend is offline.'}
          </p>
          <button type="button" className="refresh-btn" onClick={() => void reload()}>
            retry
          </button>
        </section>
      </>
    )
  }

  return (
    <>
      <section className="tab-context-head">
        <span className="tab-context-title">
          team {cfg.teamId} · {overview.members.length} members · {overview.totalEventCount} events
        </span>
        <span className="tab-context-sub">last 30d · {microToUsd(asBig(overview.totalCostMicroUsd))}</span>
      </section>

      <TeamDetailsButton dashboardUrl={dashboardUrl} />

      <section className="settings-card">
        <div className="settings-card-head">
          <h3>Members</h3>
        </div>
        <ul className="rows">
          {overview.members.map((m) => (
            <li key={m.userId} className="team-member-row">
              <span className="row-label" title={m.userId}>
                {m.displayName ?? m.userId}
              </span>
              <span className="row-cost">{microToUsd(asBig(m.costMicroUsd))}</span>
              <span className="row-count">{m.eventCount}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="settings-card">
        <div className="settings-card-head">
          <h3>Top projects (30d)</h3>
        </div>
        {overview.topProjects.length === 0 ? (
          <p className="empty">no project activity</p>
        ) : (
          <ul className="rows">
            {overview.topProjects.map((p) => (
              <li key={p.projectKey}>
                <span className="row-label" title={p.redacted ? 'project name redacted' : p.projectKey}>
                  {p.redacted ? `${p.projectKey.slice(0, 8)}… (redacted)` : p.projectKey}
                </span>
                <span className="row-cost">{microToUsd(asBig(p.costMicroUsd))}</span>
                <span className="row-count">{p.eventCount}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-card">
        <div className="settings-card-head">
          <h3>By provider · model</h3>
        </div>
        <ul className="rows">
          {overview.byProvider.map((p) => (
            <li key={`${p.provider}|${p.model}`}>
              <span
                className="row-chip"
                style={{ background: providerColor(p.provider), boxShadow: `0 0 6px ${providerColor(p.provider)}66` }}
              />
              <span className="row-label" title={p.model}>
                {providerName(p.provider)} · {p.model}
              </span>
              <span className="row-cost">{microToUsd(asBig(p.costMicroUsd))}</span>
              <span className="row-count">{p.eventCount}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="settings-card">
        <div className="settings-card-head">
          <h3>Active nodes</h3>
        </div>
        <ul className="rows">
          {overview.nodes.map((n) => (
            <li key={n.nodeId}>
              <span className="row-label" title={n.nodeId}>
                {n.displayName ?? `${n.nodeId.slice(0, 8)}…`}
                {n.platform !== null && <span className="mono small"> · {n.platform}</span>}
              </span>
              <span className="row-cost">{n.userId.slice(0, 12)}…</span>
              <span className="row-count">
                {n.lastSeenAt !== null ? `${timeAgo(n.lastSeenAt)} ago` : '—'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}
