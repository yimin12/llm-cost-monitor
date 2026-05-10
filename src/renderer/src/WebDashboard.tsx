import { useCallback, useEffect, useRef, useState } from 'react'

import type { AggregateSnapshot } from '@shared/aggregates'
import type {
  PricingInfo,
  ProviderListEntry,
  StorageInfo,
  TeamOverview,
} from '@shared/ipc-channels'

import { AreaChart, Donut, ShareBar, useAnimatedNumber } from './components/charts'
import {
  formatDuration,
  formatTokens,
  microToUsd,
  providerColor,
  providerName,
  timeAgo,
} from './lib/format'

// `window.api` is declared once in App.tsx (single source of truth across the
// renderer). Both surfaces consume the same preload bridge.

type Period = 'today' | '7d' | '1m' | '6m' | '1y'

const PERIOD_KEY = 'lcm.web.period'
const PERIOD_LABEL: Record<Period, string> = {
  today: 'Today',
  '7d': '7d',
  '1m': '1m',
  '6m': '6m',
  '1y': '1y',
}
// TeamOverview.cost fields arrive as strings from the server (bigint
// preservation). Convert defensively so a malformed payload renders as 0
// rather than crashing the page.
function asBig(s: string): bigint {
  try {
    return BigInt(s)
  } catch {
    return 0n
  }
}

function loadInitialPeriod(): Period {
  try {
    const v = localStorage.getItem(PERIOD_KEY)
    if (v === 'today' || v === '7d' || v === '1m' || v === '6m' || v === '1y') return v
    if (v === '30d') return '1m'
  } catch {
    /* */
  }
  return 'today'
}

export function WebDashboard(): JSX.Element {
  const [agg, setAgg] = useState<AggregateSnapshot | null>(null)
  const [pricing, setPricing] = useState<PricingInfo | null>(null)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [providers, setProviders] = useState<ProviderListEntry[]>([])
  const [teamOverview, setTeamOverview] = useState<TeamOverview | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [period, setPeriod] = useState<Period>(loadInitialPeriod)
  const [, forceTick] = useState(0)

  const reload = useCallback(async () => {
    const [a, s, ps, st] = await Promise.all([
      window.api.aggregates(),
      window.api.storageInfo(),
      window.api.providersList(),
      window.api.settings(),
    ])
    setAgg(a)
    setStorage(s)
    setProviders(ps)
    // Team sync overview is best-effort: fetch if configured, swallow
    // errors, leave the section hidden when null. Don't block the rest
    // of the dashboard on a slow/unreachable team backend.
    if (st.teamSync.enabled && st.teamSync.teamId !== null) {
      try {
        setTeamOverview(await window.api.syncTeamOverview())
      } catch {
        setTeamOverview(null)
      }
    } else {
      setTeamOverview(null)
    }
  }, [])

  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) clearTimeout(reloadTimer.current)
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null
      void reload()
    }, 250)
  }, [reload])

  useEffect(() => {
    void window.api.pricingInfo().then(setPricing)
    void reload()
    return window.api.onUsageUpdated(scheduleReload)
  }, [reload, scheduleReload])

  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    try { localStorage.setItem(PERIOD_KEY, period) } catch { /* */ }
  }, [period])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await window.api.providersRefresh()
    } finally {
      setRefreshing(false)
    }
  }, [])

  // Pre-hook computations must run unconditionally — Rules of Hooks require
  // useAnimatedNumber to be called every render in the same order, so we can't
  // gate it behind the `agg === null` early return below.
  const range =
    agg === null
      ? null
      : period === 'today'
        ? agg.today
        : period === '7d'
          ? agg.last7d
          : period === '1m'
            ? agg.last30d
            : period === '6m'
              ? agg.last6m
              : agg.last1y
  const providerRows =
    agg === null
      ? []
      : period === 'today'
        ? agg.byProviderToday
        : period === '6m'
          ? agg.byProvider6m
          : period === '1y'
            ? agg.byProvider1y
            : agg.byProvider30d
  const tokens = range === null ? 0 : range.inputTokens + range.outputTokens
  const animatedDollar = useAnimatedNumber(range === null ? 0 : Number(range.costMicroUsd) / 1_000_000)

  if (agg === null || range === null) {
    return (
      <div className="web-loading">
        <div className="loader-pulse" />
        <p>loading…</p>
      </div>
    )
  }

  const animatedDollarText =
    animatedDollar >= 1000
      ? `$${animatedDollar.toFixed(0)}`
      : animatedDollar >= 100
        ? `$${animatedDollar.toFixed(1)}`
        : `$${animatedDollar.toFixed(2)}`

  const providerTotal = providerRows.reduce((acc, r) => acc + Number(r.costMicroUsd), 0) || 1
  const modelTotal = agg.topModelsToday.reduce((acc, r) => acc + Number(r.costMicroUsd), 0) || 1
  const projectTotal = agg.topProjectsToday.reduce((acc, r) => acc + Number(r.costMicroUsd), 0) || 1

  const donutSlices = providerRows.map((p) => ({
    id: p.provider,
    value: Number(p.costMicroUsd),
    color: providerColor(p.provider),
  }))

  const forecastPct = agg.forecast
    ? Math.min(
        100,
        (Number(agg.forecast.spentMicroUsd) /
          Math.max(1, Number(agg.forecast.estimateMicroUsd))) *
          100,
      )
    : 0

  return (
    <div className="web-root">
      <header className="web-nav">
        <div className="web-nav-inner">
          <div className="web-nav-brand">
            <span className="web-brand-glyph" aria-hidden>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 17l5-5 4 4 8-8" />
                <path d="M14 8h6v6" />
              </svg>
            </span>
            <div className="web-brand-text">
              <span className="web-brand-name">devbar</span>
              <span className="web-brand-sub">on-device LLM usage tracker</span>
            </div>
          </div>
          <div className="web-nav-meta">
            <span className="web-live-pill" title={`updated ${timeAgo(agg.generatedAt)} ago`}>
              <span className="live-dot" />
              live · updated {timeAgo(agg.generatedAt)} ago
            </span>
            <button
              type="button"
              className="web-btn"
              disabled={refreshing}
              onClick={() => void handleRefresh()}
            >
              <span className={refreshing ? 'spin' : ''} aria-hidden>↻</span>
              {refreshing ? 'refreshing…' : 'Refresh now'}
            </button>
          </div>
        </div>
      </header>

      <main className="web-main">
        <section className="web-page-head">
          <div>
            <h1>Spend overview</h1>
            <p>
              Cost and token activity across your local CLI sessions. All data stays on this
              machine — nothing is sent anywhere.
            </p>
          </div>
          <div className="web-period" role="tablist">
            {(['today', '7d', '1m', '6m', '1y'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={period === k}
                className={period === k ? 'web-period-tab active' : 'web-period-tab'}
                onClick={() => setPeriod(k)}
              >
                {PERIOD_LABEL[k]}
              </button>
            ))}
          </div>
        </section>

        {/* KPI row */}
        <section className="web-kpi-row">
          <article className="web-kpi web-kpi-hero">
            <span className="web-kpi-label">{period === 'today' ? 'Today' : `Last ${PERIOD_LABEL[period]}`}</span>
            <span className="web-kpi-value">{animatedDollarText}</span>
            <span className="web-kpi-sub">
              {range.eventCount.toLocaleString()} calls · {formatTokens(tokens)} tokens
            </span>
          </article>
          <article className="web-kpi">
            <span className="web-kpi-label">7-day total</span>
            <span className="web-kpi-value secondary">{microToUsd(agg.last7d.costMicroUsd)}</span>
            <span className="web-kpi-sub">{agg.last7d.eventCount.toLocaleString()} calls</span>
          </article>
          <article className="web-kpi">
            <span className="web-kpi-label">30-day total</span>
            <span className="web-kpi-value secondary">{microToUsd(agg.last30d.costMicroUsd)}</span>
            <span className="web-kpi-sub">{agg.last30d.eventCount.toLocaleString()} calls</span>
          </article>
          <article className="web-kpi">
            <span className="web-kpi-label">Month-end forecast</span>
            <span className="web-kpi-value secondary">
              {agg.forecast ? `~${microToUsd(agg.forecast.estimateMicroUsd)}` : '—'}
            </span>
            <span className="web-kpi-sub">
              {agg.forecast ? `day ${agg.forecast.daysElapsed}/${agg.forecast.daysInMonth}` : 'need ≥3 days'}
            </span>
          </article>
        </section>

        {/* Chart + donut row */}
        <section className="web-grid web-grid-2-1">
          <article className="web-card">
            <header className="web-card-head">
              <div>
                <h2>Daily spend</h2>
                <p>Last 14 days — micro-USD per local calendar day.</p>
              </div>
              <span className="web-card-meta">
                peak {microToUsd(agg.dailyCostMicroUsd.reduce((a, b) => (a > b ? a : b), 0n))}
              </span>
            </header>
            <div className="web-chart-host">
              <AreaChart values={agg.dailyCostMicroUsd} />
            </div>
            <footer className="web-chart-axis">
              <span>14 days ago</span>
              <span>today</span>
            </footer>
          </article>

          <article className="web-card">
            <header className="web-card-head">
              <div>
                <h2>Provider share</h2>
                <p>Cost distribution for {period === 'today' ? 'today' : `the last ${period}`}.</p>
              </div>
            </header>
            <div className="web-donut-row">
              <Donut
                slices={donutSlices}
                centerLabel="providers"
                centerValue={String(donutSlices.length)}
              />
              <ul className="web-legend">
                {providerRows.map((p) => {
                  const pct = (Number(p.costMicroUsd) / providerTotal) * 100
                  return (
                    <li key={p.provider}>
                      <span className="web-legend-chip" style={{ background: providerColor(p.provider) }} />
                      <span className="web-legend-name">{providerName(p.provider)}</span>
                      <span className="web-legend-pct">{pct.toFixed(0)}%</span>
                      <span className="web-legend-cost">{microToUsd(p.costMicroUsd)}</span>
                    </li>
                  )
                })}
                {providerRows.length === 0 && <li className="web-legend-empty">no calls in this range</li>}
              </ul>
            </div>
          </article>
        </section>

        {/* Forecast — total + per-provider breakdown */}
        {agg.forecast !== null && (
          <section className="web-card">
            <header className="web-card-head">
              <div>
                <h2>Month-end forecast</h2>
                <p>
                  <strong>{microToUsd(agg.forecast.spentMicroUsd)}</strong> spent of an estimated
                  {' '}
                  <strong>~{microToUsd(agg.forecast.estimateMicroUsd)}</strong>{' '}
                  for this month (day {agg.forecast.daysElapsed} of {agg.forecast.daysInMonth}).
                </p>
              </div>
              <span className="web-card-meta">{forecastPct.toFixed(0)}% of estimate</span>
            </header>
            <div className="web-forecast-bar">
              <div className="web-forecast-bar-fill" style={{ width: `${forecastPct}%` }} />
            </div>

            {Object.keys(agg.forecastByProvider).length > 0 && (
              <div className="web-forecast-providers">
                <div className="web-forecast-providers-head">
                  <span>By provider</span>
                  <span>spent / est · share of total</span>
                </div>
                <ul>
                  {Object.entries(agg.forecastByProvider)
                    .sort((a, b) =>
                      Number(b[1].estimateMicroUsd) - Number(a[1].estimateMicroUsd),
                    )
                    .map(([provider, f]) => {
                      const color = providerColor(provider)
                      const est = Number(f.estimateMicroUsd)
                      const totalEst = Math.max(1, Number(agg.forecast?.estimateMicroUsd ?? 1n))
                      const sharePct = (est / totalEst) * 100
                      const spentPct = est > 0 ? (Number(f.spentMicroUsd) / est) * 100 : 0
                      return (
                        <li key={provider}>
                          <span className="web-fp-chip" style={{ background: color }} />
                          <span className="web-fp-name">{providerName(provider)}</span>
                          <span className="web-fp-bar" aria-hidden>
                            <span className="web-fp-bar-fill" style={{ width: `${spentPct}%`, background: color }} />
                          </span>
                          <span className="web-fp-num">
                            <strong>{microToUsd(f.spentMicroUsd)}</strong>
                            <span className="web-fp-sep"> / </span>
                            <span className="web-fp-est">~{microToUsd(f.estimateMicroUsd)}</span>
                          </span>
                          <span className="web-fp-share">{sharePct.toFixed(0)}%</span>
                        </li>
                      )
                    })}
                </ul>
              </div>
            )}
          </section>
        )}

        {/* Three-column data row */}
        <section className="web-grid web-grid-3">
          <article className="web-card">
            <header className="web-card-head">
              <div>
                <h2>Top providers</h2>
                <p>{period === 'today' ? 'Today' : `Last ${period}`}.</p>
              </div>
            </header>
            <ul className="web-table">
              {providerRows.map((p) => {
                const pct = (Number(p.costMicroUsd) / providerTotal) * 100
                const color = providerColor(p.provider)
                return (
                  <li key={p.provider}>
                    <span className="web-table-chip" style={{ background: color }} />
                    <span className="web-table-name">{providerName(p.provider)}</span>
                    <ShareBar pct={pct} color={color} />
                    <span className="web-table-cost">{microToUsd(p.costMicroUsd)}</span>
                    <span className="web-table-count">{p.eventCount}</span>
                  </li>
                )
              })}
              {providerRows.length === 0 && <li className="web-table-empty">no data</li>}
            </ul>
          </article>

          <article className="web-card">
            <header className="web-card-head">
              <div>
                <h2>Top models</h2>
                <p>Today.</p>
              </div>
            </header>
            <ul className="web-table">
              {agg.topModelsToday.map((m) => {
                const pct = (Number(m.costMicroUsd) / modelTotal) * 100
                const color = providerColor(m.provider)
                return (
                  <li key={`${m.provider}/${m.model}`}>
                    <span className="web-table-chip" style={{ background: color }} />
                    <span className="web-table-name" title={m.model}>{m.model}</span>
                    <ShareBar pct={pct} color={color} />
                    <span className="web-table-cost">{microToUsd(m.costMicroUsd)}</span>
                    <span className="web-table-count">{m.eventCount}</span>
                  </li>
                )
              })}
              {agg.topModelsToday.length === 0 && <li className="web-table-empty">no data</li>}
            </ul>
          </article>

          <article className="web-card">
            <header className="web-card-head">
              <div>
                <h2>Top projects</h2>
                <p>Today.</p>
              </div>
            </header>
            <ul className="web-table">
              {agg.topProjectsToday.map((p) => {
                const pct = (Number(p.costMicroUsd) / projectTotal) * 100
                const label = p.project === '(none)' ? 'no project' : p.project
                return (
                  <li key={p.project}>
                    <span className="web-table-chip neutral" />
                    <span className="web-table-name" title={p.project}>{label}</span>
                    <ShareBar pct={pct} color="rgba(167,139,250,0.6)" />
                    <span className="web-table-cost">{microToUsd(p.costMicroUsd)}</span>
                    <span className="web-table-count">{p.eventCount}</span>
                  </li>
                )
              })}
              {agg.topProjectsToday.length === 0 && <li className="web-table-empty">no data</li>}
            </ul>
          </article>
        </section>

        {/* Recent sessions table */}
        <section className="web-card">
          <header className="web-card-head">
            <div>
              <h2>Recent sessions</h2>
              <p>Last {agg.recentSessions.length} CLI sessions, most recent first.</p>
            </div>
            {agg.recentSessions.length > 0 && (
              <span className="web-card-meta">
                last activity {timeAgo(agg.recentSessions[0]!.lastAt)} ago
              </span>
            )}
          </header>
          {agg.recentSessions.length === 0 ? (
            <p className="web-empty">No sessions tracked yet — they appear after the first refresh.</p>
          ) : (
            <div className="web-sessions-table">
              <div className="web-sessions-row web-sessions-head">
                <span>Provider</span>
                <span>Session</span>
                <span>Project</span>
                <span className="num">Calls</span>
                <span className="num">Duration</span>
                <span className="num">Last activity</span>
                <span className="num">Cost</span>
              </div>
              {agg.recentSessions.map((s) => {
                const color = providerColor(s.provider)
                const dur = s.lastAt - s.firstAt
                const project = s.project === '(none)' ? 'no project' : s.project
                const sid = s.sessionId.length > 16
                  ? `${s.sessionId.slice(0, 8)}…${s.sessionId.slice(-4)}`
                  : s.sessionId
                return (
                  <div key={`${s.provider}/${s.sessionId}`} className="web-sessions-row">
                    <span className="web-session-provider">
                      <span className="web-table-chip" style={{ background: color }} />
                      {providerName(s.provider)}
                    </span>
                    <span className="web-session-id" title={s.sessionId}>{sid}</span>
                    <span className="web-session-project" title={s.project}>{project}</span>
                    <span className="num">{s.eventCount}</span>
                    <span className="num">{formatDuration(dur)}</span>
                    <span className="num">{timeAgo(s.lastAt)} ago</span>
                    <span className="num web-session-cost">{microToUsd(s.costMicroUsd)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Sources */}
        <section className="web-card">
          <header className="web-card-head">
            <div>
              <h2>Sources</h2>
              <p>
                {providers.filter((p) => p.isAvailable).length} of {providers.length} providers
                detected on this machine.
              </p>
            </div>
          </header>
          <ul className="web-sources-grid">
            {providers.map((p) => {
              const lastSeen = agg.providerLastSeen[p.id]
              return (
                <li key={p.id} className="web-source-card" data-available={p.isAvailable}>
                  <span
                    className="web-source-icon"
                    style={{ background: providerColor(p.id) }}
                    aria-hidden
                  >
                    {providerName(p.id).charAt(0)}
                  </span>
                  <div className="web-source-id">
                    <span className="web-source-name">{p.name}</span>
                    <span className="web-source-sub">
                      {typeof lastSeen === 'number'
                        ? `last seen ${timeAgo(lastSeen)} ago`
                        : 'no events captured yet'}
                    </span>
                  </div>
                  <span className="status-pill" data-state={p.isAvailable ? 'on' : 'off'}>
                    {p.isAvailable ? 'detected' : 'no data'}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>

        {/* Team Details — only rendered when sync is configured + reachable */}
        {teamOverview !== null && (
          <section className="web-card">
            <header className="web-card-head">
              <div>
                <h2>Team Details</h2>
                <p>
                  <strong>{teamOverview.teamName}</strong>{' · '}
                  role <strong>{teamOverview.currentUserRole ?? 'guest'}</strong>{' · '}
                  privacy <strong>{teamOverview.privacyFloor}</strong>
                </p>
              </div>
            </header>

            <ul className="web-team-kpis">
              <li>
                <span className="web-team-kpi-label">cost today</span>
                <span className="web-team-kpi-value">
                  {microToUsd(asBig(teamOverview.todayCostMicroUsd))}
                </span>
              </li>
              <li>
                <span className="web-team-kpi-label">cost 30d</span>
                <span className="web-team-kpi-value">
                  {microToUsd(asBig(teamOverview.totalCostMicroUsd))}
                </span>
              </li>
              <li>
                <span className="web-team-kpi-label">active 24h</span>
                <span className="web-team-kpi-value">
                  {teamOverview.activeMembers}
                  <span className="web-team-kpi-sub">/{teamOverview.members.length}</span>
                </span>
              </li>
              <li>
                <span className="web-team-kpi-label">active nodes</span>
                <span className="web-team-kpi-value">
                  {teamOverview.activeNodes}
                  <span className="web-team-kpi-sub">/{teamOverview.nodes.length}</span>
                </span>
              </li>
            </ul>

            <div className="web-team-grid">
              <div className="web-team-block">
                <h3>{teamOverview.currentUserRole === 'admin' ? 'Members · manage' : 'Collaborators'}</h3>
                <ul className="web-team-rows">
                  {teamOverview.members.map((m) => (
                    <li key={m.userId} data-status={m.status}>
                      <span className="web-team-label" title={m.userId}>
                        {m.displayName ?? m.userId}
                        <span className={`web-team-role role-${m.role}`}> {m.role}</span>
                        {m.status === 'revoked' && <span className="web-team-revoked"> revoked</span>}
                      </span>
                      <span className="web-team-cost">
                        {microToUsd(asBig(m.costMicroUsd))}
                      </span>
                      <span className="web-team-count">{m.eventCount}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="web-team-block">
                <h3>Top projects (30d)</h3>
                {teamOverview.topProjects.length === 0 ? (
                  <p className="web-empty">no project activity</p>
                ) : (
                  <ul className="web-team-rows">
                    {teamOverview.topProjects.map((p) => (
                      <li key={p.projectKey}>
                        <span
                          className="web-team-label"
                          title={p.redacted ? 'project name redacted' : p.projectKey}
                        >
                          {p.redacted
                            ? `${p.projectKey.slice(0, 8)}… (redacted)`
                            : p.projectKey}
                        </span>
                        <span className="web-team-cost">
                          {microToUsd(asBig(p.costMicroUsd))}
                        </span>
                        <span className="web-team-count">{p.eventCount}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="web-team-block">
                <h3>By provider · model</h3>
                <ul className="web-team-rows">
                  {teamOverview.byProvider.map((p) => (
                    <li key={`${p.provider}|${p.model}`}>
                      <span
                        className="web-team-chip"
                        style={{
                          background: providerColor(p.provider),
                          boxShadow: `0 0 6px ${providerColor(p.provider)}66`,
                        }}
                      />
                      <span className="web-team-label" title={p.model}>
                        {providerName(p.provider)} · {p.model}
                      </span>
                      <span className="web-team-cost">
                        {microToUsd(asBig(p.costMicroUsd))}
                      </span>
                      <span className="web-team-count">{p.eventCount}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="web-team-block">
                <h3>Active nodes</h3>
                <ul className="web-team-rows">
                  {teamOverview.nodes.map((n) => (
                    <li key={n.nodeId}>
                      <span className="web-team-label" title={n.nodeId}>
                        {n.displayName ?? `${n.nodeId.slice(0, 8)}…`}
                        {n.platform !== null && (
                          <span className="web-cli-mono"> · {n.platform}</span>
                        )}
                      </span>
                      <span className="web-team-cost">{n.userId.slice(0, 12)}…</span>
                      <span className="web-team-count">
                        {n.lastSeenAt !== null ? `${timeAgo(n.lastSeenAt)} ago` : '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        )}

        <footer className="web-footer">
          <div>
            <strong>{storage?.eventCount.toLocaleString() ?? 0}</strong> events stored ·
            pricing snapshot <code>{pricing?.snapshotVersion ?? '…'}</code> ·
            {pricing?.modelCount ?? 0} models priced
          </div>
          <div>
            <strong>On-device only.</strong> Session logs scanned locally · no telemetry · no cloud sync.
          </div>
        </footer>
      </main>
    </div>
  )
}
