import { useCallback, useEffect, useState } from 'react'

import type {
  AppSettings,
  TeamManageResult,
  TeamMemberRole,
  TeamOverview,
} from '@shared/ipc-channels'
import type { PrivacyLevel } from '@shared/sync'

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

function PRIVACY_LABEL(level: PrivacyLevel): string {
  return level === 'full' ? 'Full' : level === 'redacted' ? 'Redacted' : 'Aggregate only'
}

export function TeamTab({ settings, dashboardUrl }: {
  settings: AppSettings | null
  dashboardUrl: string | null
}): JSX.Element {
  const [overview, setOverview] = useState<TeamOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [addingUserId, setAddingUserId] = useState('')
  const [addingDisplayName, setAddingDisplayName] = useState('')

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

  // Surface a TeamManageResult as a transient toast and refresh the
  // overview when it succeeded (so members/role rows update in place).
  const handleResult = useCallback(
    async (action: string, r: TeamManageResult) => {
      if (r.ok) {
        setToast(`${action}: ok`)
        await reload()
      } else {
        setToast(`${action} failed: ${r.message ?? r.error}`)
      }
      setTimeout(() => setToast(null), 3500)
    },
    [reload],
  )

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

  const isAdmin = overview.currentUserRole === 'admin'
  const memberLabel = isAdmin ? 'Members · manage' : 'Collaborators'

  return (
    <>
      <section className="tab-context-head">
        <span className="tab-context-title">
          {overview.teamName} · {overview.members.length} members · {overview.totalEventCount} events
        </span>
        <span className="tab-context-sub">
          {overview.currentUserRole === null
            ? 'not a member'
            : isAdmin
              ? 'role · admin'
              : 'role · member'}
          {' · '}
          privacy · {PRIVACY_LABEL(overview.privacyFloor)}
        </span>
      </section>

      <TeamDetailsButton dashboardUrl={dashboardUrl} />

      {/* KPI row — pulse-style stat cards */}
      <section className="team-kpis">
        <div className="team-kpi">
          <span className="team-kpi-label">cost today</span>
          <span className="team-kpi-value">{microToUsd(asBig(overview.todayCostMicroUsd))}</span>
        </div>
        <div className="team-kpi">
          <span className="team-kpi-label">cost 30d</span>
          <span className="team-kpi-value">{microToUsd(asBig(overview.totalCostMicroUsd))}</span>
        </div>
        <div className="team-kpi">
          <span className="team-kpi-label">active 24h</span>
          <span className="team-kpi-value">
            {overview.activeMembers}<span className="team-kpi-sub">/{overview.members.length}</span>
          </span>
        </div>
        <div className="team-kpi">
          <span className="team-kpi-label">active nodes</span>
          <span className="team-kpi-value">
            {overview.activeNodes}<span className="team-kpi-sub">/{overview.nodes.length}</span>
          </span>
        </div>
      </section>

      {toast !== null && <div className="team-toast" role="status">{toast}</div>}

      {/* Admin-only management panel */}
      {isAdmin && (
        <section className="settings-card team-admin-card">
          <div className="settings-card-head">
            <h3>Manage</h3>
          </div>

          <div className="team-admin-row">
            <label className="team-admin-label" htmlFor="team-privacy-floor">
              Privacy floor
            </label>
            <select
              id="team-privacy-floor"
              className="team-admin-select"
              value={overview.privacyFloor}
              disabled={busy}
              onChange={(e) => {
                const level = e.currentTarget.value as PrivacyLevel
                setBusy(true)
                void window.api
                  .teamSetPrivacyFloor(level)
                  .then((r) => handleResult('privacy floor', r))
                  .finally(() => setBusy(false))
              }}
            >
              <option value="full">Full</option>
              <option value="redacted">Redacted</option>
              <option value="aggregateOnly">Aggregate only</option>
            </select>
          </div>

          <form
            className="team-admin-add"
            onSubmit={(e) => {
              e.preventDefault()
              if (addingUserId.trim().length === 0) return
              setBusy(true)
              const body: { userId: string; displayName?: string } = {
                userId: addingUserId.trim(),
              }
              if (addingDisplayName.trim().length > 0) {
                body.displayName = addingDisplayName.trim()
              }
              void window.api
                .teamAddMember(body)
                .then((r) => {
                  void handleResult('add member', r)
                  if (r.ok) {
                    setAddingUserId('')
                    setAddingDisplayName('')
                  }
                })
                .finally(() => setBusy(false))
            }}
          >
            <input
              type="text"
              className="team-admin-input"
              placeholder="user id (e.g. google-sub or email)"
              value={addingUserId}
              onChange={(e) => setAddingUserId(e.currentTarget.value)}
              disabled={busy}
            />
            <input
              type="text"
              className="team-admin-input team-admin-input-name"
              placeholder="display name (optional)"
              value={addingDisplayName}
              onChange={(e) => setAddingDisplayName(e.currentTarget.value)}
              disabled={busy}
            />
            <button
              type="submit"
              className="team-admin-submit"
              disabled={busy || addingUserId.trim().length === 0}
            >
              add member
            </button>
          </form>
        </section>
      )}

      {/* Members / Collaborators */}
      <section className="settings-card">
        <div className="settings-card-head">
          <h3>{memberLabel}</h3>
        </div>
        <ul className="rows team-member-list">
          {overview.members.map((m) => {
            const isSelf = m.userId === cfg.userId
            const onPromote = (next: TeamMemberRole): void => {
              setBusy(true)
              void window.api
                .teamSetMemberRole(m.userId, next)
                .then((r) => handleResult(`set ${m.userId} → ${next}`, r))
                .finally(() => setBusy(false))
            }
            const onRevoke = (): void => {
              if (m.status === 'revoked') return
              setBusy(true)
              void window.api
                .teamRevokeMember(m.userId)
                .then((r) => handleResult(`revoke ${m.userId}`, r))
                .finally(() => setBusy(false))
            }
            return (
              <li key={m.userId} className="team-member-row" data-status={m.status}>
                <span className="row-label" title={m.userId}>
                  {m.displayName ?? m.userId}
                  {isSelf && <span className="team-self-tag"> · you</span>}
                </span>
                <span className={`team-role-chip role-${m.role}`}>{m.role}</span>
                {m.status === 'revoked' && <span className="team-revoked-chip">revoked</span>}
                <span className="row-cost">{microToUsd(asBig(m.costMicroUsd))}</span>
                <span className="row-count">{m.eventCount}</span>
                {isAdmin && (
                  <span className="team-row-actions">
                    {m.role === 'member' ? (
                      <button
                        type="button"
                        className="team-row-action"
                        disabled={busy || m.status === 'revoked'}
                        title="Promote to admin"
                        onClick={() => onPromote('admin')}
                      >
                        ↑ admin
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="team-row-action"
                        disabled={busy || isSelf}
                        title={isSelf ? 'Cannot demote yourself' : 'Demote to member'}
                        onClick={() => onPromote('member')}
                      >
                        ↓ member
                      </button>
                    )}
                    <button
                      type="button"
                      className="team-row-action team-row-action-danger"
                      disabled={busy || m.status === 'revoked' || isSelf}
                      title={isSelf ? 'Cannot revoke yourself' : 'Revoke membership'}
                      onClick={onRevoke}
                    >
                      revoke
                    </button>
                  </span>
                )}
              </li>
            )
          })}
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
