import { useCallback, useEffect, useRef, useState } from 'react'

import type { AggregateSnapshot } from '@shared/aggregates'
import type { Alert, AlertSummary } from '@shared/alerts'
import type {
  AppSettings,
  PricingInfo,
  ProviderListEntry,
  StorageInfo,
  TeamOverview,
} from '@shared/ipc-channels'

import { AreaChart, Donut, ShareBar, useAnimatedNumber } from './components/charts'
import { ProviderCatalog } from './components/ProviderCatalog'
import { TeamSyncPortal } from './components/TeamSyncPortal'
import { YieldScoreCard } from './components/YieldScoreCard'
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

// Web-view top-level page. Overview is the comprehensive usage
// dashboard; Team is a separate page focused on the shared sync
// surface so it isn't drowning under personal-usage panels.
type Tab = 'overview' | 'team'
const TAB_KEY = 'lcm.web.tab'
const PERIOD_KEY = 'lcm.web.period'

function loadInitialTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY)
    if (v === 'overview' || v === 'team') return v
  } catch {
    /* */
  }
  return 'overview'
}

const PERIOD_LABEL: Record<Period, string> = {
  today: 'Today',
  '7d': '7d',
  '1m': '1m',
  '6m': '6m',
  '1y': '1y',
}
// Daily-spend chart slices the last N entries of dailyCostMicroUsd.
const PERIOD_DAYS: Record<Period, number> = {
  today: 1,
  '7d': 7,
  '1m': 30,
  '6m': 180,
  '1y': 365,
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
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [teamOverview, setTeamOverview] = useState<TeamOverview | null>(null)
  const [alertSummary, setAlertSummary] = useState<AlertSummary>({
    open: 0, acked: 0, snoozed: 0, resolved: 0,
  })
  const [openAlerts, setOpenAlerts] = useState<Alert[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [period, setPeriod] = useState<Period>(loadInitialPeriod)
  const [tab, setTab] = useState<Tab>(loadInitialTab)
  const [, forceTick] = useState(0)

  const reload = useCallback(async () => {
    const [a, s, ps, st, summary, open] = await Promise.all([
      window.api.aggregates(),
      window.api.storageInfo(),
      window.api.providersList(),
      window.api.settings(),
      window.api.alertsSummary(),
      window.api.alertsList('open'),
    ])
    setAgg(a)
    setStorage(s)
    setProviders(ps)
    setSettings(st)
    setAlertSummary(summary)
    setOpenAlerts(open)
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

  // Refresh team-overview every 5 minutes so the account-aggregated KPI
  // row reflects what *other* devices have pushed up since the last
  // local reload(). Local reload() already updates it on its own
  // schedule (usage-updated events); this is the cross-device tick.
  useEffect(() => {
    if (settings?.teamSync.enabled !== true || settings.teamSync.teamId === null) return
    const id = window.setInterval(() => {
      void (async () => {
        try {
          setTeamOverview(await window.api.syncTeamOverview())
        } catch {
          /* leave stale value on transient failure */
        }
      })()
    }, 5 * 60_000)
    return () => window.clearInterval(id)
  }, [settings?.teamSync.enabled, settings?.teamSync.teamId])

  useEffect(() => {
    void window.api.pricingInfo().then(setPricing)
    void window.api.settings().then(setSettings)
    void reload()
    const offUsage = window.api.onUsageUpdated(scheduleReload)
    const offSettings = window.api.onSettingsChanged(setSettings)
    return () => {
      offUsage()
      offSettings()
    }
  }, [reload, scheduleReload])

  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    try { localStorage.setItem(PERIOD_KEY, period) } catch { /* */ }
  }, [period])

  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, tab) } catch { /* */ }
  }, [tab])

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

      <nav className="web-tab-nav" role="tablist" aria-label="Pages">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'overview'}
          className={tab === 'overview' ? 'web-tab active' : 'web-tab'}
          onClick={() => setTab('overview')}
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'team'}
          className={tab === 'team' ? 'web-tab active' : 'web-tab'}
          onClick={() => setTab('team')}
        >
          Team
          {teamOverview !== null && teamOverview.members.length > 0 && (
            <span className="web-tab-badge">{teamOverview.members.length}</span>
          )}
        </button>
      </nav>

      <main className="web-main">
        <section className="web-page-head">
          <div>
            <h1>{tab === 'team' ? 'Team' : 'Dashboard'}</h1>
            <p>
              {tab === 'team'
                ? 'Shared usage across everyone signed into your team. Sync uploads only a redacted projection — raw prompts, responses, and project paths stay on each device.'
                : 'Cost and token activity across your local CLI sessions. All data stays on this machine — nothing is sent anywhere.'}
            </p>
          </div>
          {tab === 'overview' && (
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
          )}
        </section>

        {tab === 'overview' && (
          <>

        {/* Pre-login portal — shown above the KPIs when team sync is on
            but the user isn't signed in (or the last sign-in errored). */}
        <TeamSyncPortal
          teamSyncEnabled={settings?.teamSync.enabled === true && settings.teamSync.teamId !== null}
        />

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

        {/* Account total — sums every device the signed-in user has
            registered on this team. Polls team-overview every 5 min via
            the effect above so a second machine (e.g. mac + mbp on the
            same account) shows up here without manual refresh. Window
            is the server's 30d default; the per-machine KPIs above
            follow the user's selected period. */}
        {(() => {
          const myUserId = settings?.teamSync.userId ?? null
          if (teamOverview === null || myUserId === null) return null
          const me = teamOverview.members.find((m) => m.userId === myUserId)
          if (me === undefined) return null
          const myNodes = teamOverview.nodes.filter((n) => n.userId === myUserId)
          const activeWindowMs = Date.now() - 24 * 3600 * 1000
          const myActiveCount = myNodes.filter(
            (n) => n.lastSeenAt !== null && n.lastSeenAt >= activeWindowMs,
          ).length
          const acctUsd = Number(me.costMicroUsd) / 1_000_000
          return (
            <section
              className="web-kpi-row web-kpi-row-triple"
              aria-label={`Account total across ${myNodes.length} device${myNodes.length === 1 ? '' : 's'}`}
            >
              <article className="web-kpi">
                <span className="web-kpi-label">Account cost</span>
                <span className="web-kpi-value">
                  {acctUsd >= 100 ? `$${acctUsd.toFixed(1)}` : `$${acctUsd.toFixed(2)}`}
                </span>
                <span className="web-kpi-sub">30d total</span>
              </article>
              <article className="web-kpi">
                <span className="web-kpi-label">Account tokens</span>
                <span className="web-kpi-value secondary">
                  {formatTokens(me.inputTokens + me.outputTokens)}
                </span>
                <span className="web-kpi-sub">30d in + out</span>
              </article>
              <article className="web-kpi">
                <span className="web-kpi-label">Active now</span>
                <span className="web-kpi-value secondary">
                  {myActiveCount}/{myNodes.length}
                </span>
                <span className="web-kpi-sub">24h window</span>
              </article>
            </section>
          )
        })()}

        {/* Daily spend trend. Provider share donut + Top providers/
            models/projects tables + Recent sessions used to live here;
            all of that duplicated tray-panel content, so it's been
            removed. Drill into a provider for the per-vendor breakdown
            via its row in the Provider Catalog below. */}
        {(() => {
          const days = PERIOD_DAYS[period]
          const series = agg.dailyCostMicroUsd.slice(-days)
          const peak = series.reduce((a, b) => (a > b ? a : b), 0n)
          return (
            <section className="web-card">
              <header className="web-card-head">
                <div>
                  <h2>Daily spend</h2>
                  <p>
                    {period === 'today'
                      ? 'Today — micro-USD spent so far.'
                      : `Last ${days} days — micro-USD per local calendar day.`}
                  </p>
                </div>
                <span className="web-card-meta">peak {microToUsd(peak)}</span>
              </header>
              <div className="web-chart-host">
                <AreaChart values={series} />
              </div>
              <footer className="web-chart-axis">
                <span>{period === 'today' ? 'today' : `${days} days ago`}</span>
                <span>today</span>
              </footer>
            </section>
          )
        })()}

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


        {/* Provider share donut — visualises the period's cost split. */}
        <section className="web-grid web-grid-2-1">
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

          {/* Yield Score (cost per commit) — same component the tray uses. */}
          <YieldScoreCard settings={settings} />
        </section>

        {/* Three-column data row: providers / models / projects. */}
        <section className="web-grid web-grid-3">
          <article className="web-card">
            <header className="web-card-head">
              <div>
                <h2>Top providers</h2>
                <p>{period === 'today' ? 'Today' : `Last ${period}`}.</p>
              </div>
            </header>
            <ul className="web-table">
              {/* Overview is a glance surface — cap the long tail at the
                  top 3 each so the page stays scannable. Full ranked
                  lists live on the Providers / Sessions tabs. */}
              {providerRows.slice(0, 3).map((p) => {
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
              {agg.topModelsToday.slice(0, 3).map((m) => {
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
              {agg.topProjectsToday.slice(0, 3).map((p) => {
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

        {/* Alerts panel — mirrors the tray Alerts tab. */}
        <section className="web-card">
          <header className="web-card-head">
            <div>
              <h2>Alerts</h2>
              <p>
                {alertSummary.open} open · {alertSummary.acked} acked · {alertSummary.snoozed} snoozed · {alertSummary.resolved} resolved
              </p>
            </div>
          </header>
          {openAlerts.length === 0 ? (
            <p className="web-empty">No open alerts — nothing to look at right now.</p>
          ) : (
            <ul className="web-alert-list">
              {openAlerts.slice(0, 12).map((a) => (
                <li key={a.id} className={`web-alert-row severity-${a.severity}`} data-status={a.status}>
                  <span className={`web-alert-dot severity-${a.severity}`} />
                  <div className="web-alert-body">
                    <span className="web-alert-title">{a.title}</span>
                    {a.body !== '' && <span className="web-alert-sub">{a.body}</span>}
                  </div>
                  <span className="web-alert-meta">
                    <span className="web-alert-status">{a.status}</span>
                    <span className="web-alert-time">{timeAgo(a.raisedAt)} ago</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Recent sessions table. */}
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

        {/* Provider catalog — full vendor list with capability filter +
            inline onboarding form. */}
        <ProviderCatalog detectedProviders={providers} settings={settings} />
          </>
        )}

        {tab === 'team' && (
        <>
        {/* Team page — distinct surface. Always rendered when this
            tab is active; empty state explains how to wire sync. */}
        {teamOverview === null ? (
          <section className="web-card">
            <header className="web-card-head">
              <div>
                <h2>Team Details</h2>
                <p>Team sync isn't configured on this device.</p>
              </div>
            </header>
            <div className="web-team-empty">
              <p>
                Enable team sync in <strong>Settings → Team Sync</strong> on the tray
                panel to upload a redacted projection of your usage. Members will then
                see consolidated rollups (cost today / 30d / active nodes / projects)
                and admins can manage roles + privacy floor here.
              </p>
              <p className="web-team-empty-sub">
                The desktop app stays fully functional offline — team sync is opt-in.
              </p>
            </div>
          </section>
        ) : (
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
                    {/* Glance surface — cap each breakdown to top 3; full ranked
                        lists live behind the audit drilldown (TODO: link). */}
                    {teamOverview.topProjects.slice(0, 3).map((p) => (
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
                  {teamOverview.byProvider.slice(0, 3).map((p) => (
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
                  {teamOverview.nodes.slice(0, 3).map((n) => (
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
        </>
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
