import { useCallback, useEffect, useRef, useState } from 'react'

import type { AggregateSnapshot } from '@shared/aggregates'
import type {
  AppSettings,
  PricingInfo,
  ProviderListEntry,
  StorageInfo,
  TeamOverview,
} from '@shared/ipc-channels'

import { AreaChart, useAnimatedNumber } from './components/charts'
import { ProviderCatalog } from './components/ProviderCatalog'
import {
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
  const [settings, setSettings] = useState<AppSettings | null>(null)
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
    setSettings(st)
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
            <h1>Dashboard</h1>
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

        {/* Daily spend trend. Provider share donut + Top providers/
            models/projects tables + Recent sessions used to live here;
            all of that duplicated tray-panel content, so it's been
            removed. Drill into a provider for the per-vendor breakdown
            via its row in the Provider Catalog below. */}
        <section className="web-card">
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


        {/* Provider catalog — full vendor list with capability filter +
            inline onboarding form. Replaces the simple Sources grid;
            shows everything devbar can talk to today (auto-detected or
            via API key) plus the wider catalog of vendors users may
            want to onboard. */}
        <ProviderCatalog detectedProviders={providers} settings={settings} />

        {/* Team Details — always rendered. Empty state when sync is off
            so users who clicked the tray "Team Details" button always
            land on a meaningful surface, not the provider Sources card. */}
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
