import { useEffect, useState } from 'react'

import type { AggregateSnapshot, CostByModel, CostByProject, CostByProvider, MonthlyForecast } from '@shared/aggregates'
import type { AppSettings, TeamOverview, TeamProviderUsage } from '@shared/ipc-channels'

import { AreaChart, ShareBar, useAnimatedNumber } from '../components/charts'
import { KpiTile } from '../components/KpiTile'
import { YieldScoreCard } from '../components/YieldScoreCard'
import { formatTokens, microToUsd, providerColor, providerName } from '../lib/format'

function ProviderRows({ rows }: { rows: CostByProvider[] }): JSX.Element {
  if (rows.length === 0) return <p className="empty">no calls in this range</p>
  const total = rows.reduce((acc, r) => acc + Number(r.costMicroUsd), 0) || 1
  return (
    <ul className="rows">
      {rows.map((p) => {
        const pct = (Number(p.costMicroUsd) / total) * 100
        const color = providerColor(p.provider)
        return (
          <li key={p.provider}>
            <span className="row-chip" style={{ background: color, boxShadow: `0 0 8px ${color}66` }} />
            <span className="row-label">{providerName(p.provider)}</span>
            <ShareBar pct={pct} color={color} />
            <span className="row-cost">{microToUsd(p.costMicroUsd)}</span>
            <span className="row-count">{p.eventCount}</span>
          </li>
        )
      })}
    </ul>
  )
}

function ModelRows({ rows }: { rows: CostByModel[] }): JSX.Element {
  if (rows.length === 0) return <p className="empty">—</p>
  const total = rows.reduce((acc, r) => acc + Number(r.costMicroUsd), 0) || 1
  return (
    <ul className="rows">
      {rows.map((m) => {
        const pct = (Number(m.costMicroUsd) / total) * 100
        const color = providerColor(m.provider)
        return (
          <li key={`${m.provider}/${m.model}`}>
            <span className="row-chip" style={{ background: color, boxShadow: `0 0 8px ${color}66` }} />
            <span className="row-label" title={m.model}>{m.model}</span>
            <ShareBar pct={pct} color={color} />
            <span className="row-cost">{microToUsd(m.costMicroUsd)}</span>
            <span className="row-count">{m.eventCount}</span>
          </li>
        )
      })}
    </ul>
  )
}

function ProjectRows({ rows }: { rows: CostByProject[] }): JSX.Element {
  if (rows.length === 0) return <p className="empty">—</p>
  const total = rows.reduce((acc, r) => acc + Number(r.costMicroUsd), 0) || 1
  return (
    <ul className="rows">
      {rows.map((p) => {
        const pct = (Number(p.costMicroUsd) / total) * 100
        const label = p.project === '(none)' ? 'no project' : p.project
        return (
          <li key={p.project}>
            <span className="row-chip neutral" />
            <span className="row-label" title={p.project}>{label}</span>
            <ShareBar pct={pct} color="rgba(167,139,250,0.6)" />
            <span className="row-cost">{microToUsd(p.costMicroUsd)}</span>
            <span className="row-count">{p.eventCount}</span>
          </li>
        )
      })}
    </ul>
  )
}

type Period = 'today' | '7d' | '1m' | '6m' | '1y'

const PERIOD_RANGE: Record<Period, keyof Pick<
  AggregateSnapshot,
  'today' | 'last7d' | 'last30d' | 'last6m' | 'last1y'
>> = {
  today: 'today',
  '7d': 'last7d',
  '1m': 'last30d',
  '6m': 'last6m',
  '1y': 'last1y',
}

const PERIOD_BY_PROVIDER: Record<Exclude<Period, 'today'>, keyof Pick<
  AggregateSnapshot,
  'byProvider30d' | 'byProvider6m' | 'byProvider1y'
>> = {
  '7d': 'byProvider30d', // 7d view re-uses the 30d split — refining would
                          // need a dedicated SQL window we haven't added.
  '1m': 'byProvider30d',
  '6m': 'byProvider6m',
  '1y': 'byProvider1y',
}

// Daily-spend chart slices the last N entries of dailyCostMicroUsd.
const PERIOD_DAYS: Record<Period, number> = {
  today: 1,
  '7d': 7,
  '1m': 30,
  '6m': 180,
  '1y': 365,
}

// Lucide-style line icons for the top-of-Overview KPI tiles.
const IconDollar = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </svg>
)
const IconActivity = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </svg>
)
const IconTokens = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
)
const IconProviders = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="12" cy="18" r="3" />
    <path d="M8.5 7.5L11 16M15.5 7.5L13 16" />
  </svg>
)
// Laptop / device icon for the per-account "nodes" KPI — used on the
// team-aggregated row to communicate "this number is across machines".
const IconNodes = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M2 20h20" />
  </svg>
)

// Poll cadence for the team-aggregated KPI row. The local-machine KPIs
// repaint on every aggregate refresh tick (~30s, driven by the sampler);
// the team aggregate comes from the server's team-overview endpoint and
// changes only when *other* nodes drain to it, so we don't need it
// every 30s. 5 min keeps the cross-device totals fresh-feeling without
// hammering the server.
const TEAM_KPI_POLL_MS = 5 * 60 * 1000

const PERIOD_LABEL: Record<Period, string> = {
  today: 'Today',
  '7d': '7d',
  '1m': '1m',
  '6m': '6m',
  '1y': '1y',
}

// Replace the local forecast's MTD spend with the user's team-wide MTD
// (from the team server) when team sync is on. The linear projection
// (×daysInMonth ÷ daysElapsed) stays client-side so the math is identical
// to the local code path. Per-provider forecasts get the same swap from
// `currentUserMonthByProvider`, with cost-keyed aggregation across the
// per-model tuples that endpoint returns. Returns `null` to signal "use
// the local forecast unchanged" — keeps the call site declarative.
function teamScopedForecast(
  local: AggregateSnapshot,
  team: TeamOverview | null,
  settings: AppSettings | null,
): {
  forecast: MonthlyForecast | null
  forecastByProvider: Record<string, MonthlyForecast>
  source: 'team' | 'local'
} {
  if (
    settings?.teamSync?.enabled !== true ||
    team === null ||
    team.currentUserMonthCostMicroUsd === null ||
    local.forecast === null
  ) {
    return {
      forecast: local.forecast,
      forecastByProvider: local.forecastByProvider,
      source: 'local',
    }
  }
  const base = local.forecast
  const spent = BigInt(team.currentUserMonthCostMicroUsd)
  // Same linear formula the local aggregator uses (see
  // src/main/aggregation/aggregator.ts forecast section).
  const estimate =
    base.daysElapsed > 0
      ? (spent * BigInt(base.daysInMonth)) / BigInt(base.daysElapsed)
      : spent
  const forecast: MonthlyForecast = {
    monthStartMs: base.monthStartMs,
    daysElapsed: base.daysElapsed,
    daysInMonth: base.daysInMonth,
    spentMicroUsd: spent,
    estimateMicroUsd: estimate,
    confidenceBandMicroUsd: base.confidenceBandMicroUsd,
  }

  // Roll the per-(provider, model) MTD rows up into per-provider buckets
  // and project. Models with no entry stay out of the breakdown — we don't
  // synthesize empty rows.
  const byProvider: Record<string, MonthlyForecast> = {}
  for (const row of team.currentUserMonthByProvider as TeamProviderUsage[]) {
    const cur = byProvider[row.provider]?.spentMicroUsd ?? 0n
    const spentP = cur + BigInt(row.costMicroUsd)
    const estP =
      base.daysElapsed > 0
        ? (spentP * BigInt(base.daysInMonth)) / BigInt(base.daysElapsed)
        : spentP
    byProvider[row.provider] = {
      monthStartMs: base.monthStartMs,
      daysElapsed: base.daysElapsed,
      daysInMonth: base.daysInMonth,
      spentMicroUsd: spentP,
      estimateMicroUsd: estP,
      confidenceBandMicroUsd: 0n,
    }
  }

  return { forecast, forecastByProvider: byProvider, source: 'team' }
}

export function OverviewTab({ agg, period, onPeriodChange, settings, teamOverview }: {
  agg: AggregateSnapshot
  period: Period
  onPeriodChange: (p: Period) => void
  settings: AppSettings | null
  teamOverview: TeamOverview | null
}): JSX.Element {
  const range = agg[PERIOD_RANGE[period]]

  // Team-aggregated KPI row — sums the signed-in user's events across
  // every machine they've registered. Polls the server every 5 min so
  // numbers from a second device (e.g. a remote mac) flow in without
  // requiring a manual refresh. Hidden when team sync isn't configured.
  const teamSync = settings?.teamSync
  const teamEnabled = teamSync?.enabled === true && teamSync.teamId !== null
  const myUserId = teamSync?.userId ?? null
  const [teamOverview, setTeamOverview] = useState<TeamOverview | null>(null)
  useEffect(() => {
    if (!teamEnabled) {
      setTeamOverview(null)
      return
    }
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const ov = await window.api.syncTeamOverview()
        if (!cancelled) setTeamOverview(ov)
      } catch {
        if (!cancelled) setTeamOverview(null)
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), TEAM_KPI_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [teamEnabled, teamSync?.teamId])

  // Pull out the current user's row + their nodes. Null when team sync
  // is on but the user hasn't synced yet (no member row on the server).
  const me = myUserId === null
    ? null
    : (teamOverview?.members.find((m) => m.userId === myUserId) ?? null)
  const myNodes =
    myUserId === null || teamOverview === null
      ? []
      : teamOverview.nodes.filter((n) => n.userId === myUserId)
  const myNodeCount = myNodes.length
  // "Active now" — device touched the server inside the last 24h. Same
  // rule the server uses for the team activeNodes KPI, scoped to the
  // signed-in user.
  const activeWindowMs = Date.now() - 24 * 3600 * 1000
  const myActiveCount = myNodes.filter(
    (n) => n.lastSeenAt !== null && n.lastSeenAt >= activeWindowMs,
  ).length
  const providerRows =
    period === 'today' ? agg.byProviderToday : agg[PERIOD_BY_PROVIDER[period]]

  const animatedDollar = useAnimatedNumber(Number(range.costMicroUsd) / 1_000_000)
  const animatedDollarText =
    animatedDollar >= 100 ? `$${animatedDollar.toFixed(1)}` : `$${animatedDollar.toFixed(2)}`

  const tokens = range.inputTokens + range.outputTokens

  const scoped = teamScopedForecast(agg, teamOverview, settings)
  const forecast = scoped.forecast
  const forecastByProvider = scoped.forecastByProvider

  const forecastPct = forecast
    ? Math.min(
        100,
        (Number(forecast.spentMicroUsd) /
          Math.max(1, Number(forecast.estimateMicroUsd))) *
          100,
      )
    : 0

  const donutSlices = providerRows.map((p) => ({
    id: p.provider,
    value: Number(p.costMicroUsd),
    color: providerColor(p.provider),
  }))

  return (
    <>
      <div className="period-bar" role="tablist">
        {(['today', '7d', '1m', '6m', '1y'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={period === k}
            className={period === k ? 'period-tab active' : 'period-tab'}
            onClick={() => onPeriodChange(k)}
          >
            {PERIOD_LABEL[k]}
          </button>
        ))}
      </div>

      <section className="kpi-grid kpi-grid-4 hero-tiles">
        <KpiTile
          icon={IconDollar}
          iconColor="rgba(120, 200, 140, 0.95)"
          label={period === 'today' ? 'Today' : `Last ${PERIOD_LABEL[period]}`}
          value={animatedDollarText}
        />
        <KpiTile
          icon={IconActivity}
          iconColor="rgba(120, 170, 255, 0.95)"
          label="Calls"
          value={range.eventCount.toLocaleString()}
        />
        <KpiTile
          icon={IconTokens}
          iconColor="rgba(167, 139, 250, 0.95)"
          label="Tokens"
          value={formatTokens(tokens)}
        />
        <KpiTile
          icon={IconProviders}
          iconColor="rgba(255, 180, 120, 0.95)"
          label="Providers"
          value={String(donutSlices.length)}
        />
      </section>

      {/* Account total — merged across every machine the user signs
          into. Polls team-overview every 5 min so a second device (e.g.
          mac + mbp on the same account) shows up without manual refresh.
          Three tiles: cost + tokens (the headline numbers) and active
          devices NOW (so the user knows which machines contributed).
          Full per-device drilldown lives on the Team tab. */}
      {me !== null && (
        <section
          className="kpi-grid kpi-grid-3 hero-tiles"
          aria-label={`Account total across ${myNodeCount} device${myNodeCount === 1 ? '' : 's'}`}
        >
          <KpiTile
            icon={IconDollar}
            iconColor="rgba(120, 200, 140, 0.95)"
            label="Account cost"
            value={(() => {
              const usd = Number(me.costMicroUsd) / 1_000_000
              return usd >= 100 ? `$${usd.toFixed(1)}` : `$${usd.toFixed(2)}`
            })()}
            sub="30d total"
          />
          <KpiTile
            icon={IconTokens}
            iconColor="rgba(167, 139, 250, 0.95)"
            label="Account tokens"
            value={formatTokens(me.inputTokens + me.outputTokens)}
            sub="30d in + out"
          />
          <KpiTile
            icon={IconNodes}
            iconColor="rgba(160, 200, 255, 0.95)"
            label="Active now"
            value={`${myActiveCount}/${myNodeCount}`}
            sub="24h window"
          />
        </section>
      )}

      {(() => {
        const days = PERIOD_DAYS[period]
        const series = agg.dailyCostMicroUsd.slice(-days)
        const peak = series.reduce((a, b) => (a > b ? a : b), 0n)
        return (
          <section className="chart-card">
            <div className="chart-card-head">
              <span className="chart-card-title">
                {period === 'today' ? 'Daily spend · today' : `Daily spend · last ${days}d`}
              </span>
              <span className="chart-card-sub">peak {microToUsd(peak)}</span>
            </div>
            <AreaChart values={series} />
            <div className="chart-axis">
              <span>{period === 'today' ? 'today' : `${days}d ago`}</span>
              <span>today</span>
            </div>
          </section>
        )
      })()}

      {forecast !== null ? (
        <section className="forecast-card">
          <div className="forecast-card-head">
            <span className="chart-card-title">
              Month-end forecast · total
              {scoped.source === 'team' && (
                <span className="forecast-source-tag" title="Aggregated across your synced nodes via team sync">
                  {' '}· account-wide
                </span>
              )}
            </span>
            <span className="forecast-pct">{forecastPct.toFixed(0)}%</span>
          </div>
          <div className="forecast-bar" aria-hidden>
            <div className="forecast-bar-fill" style={{ width: `${forecastPct}%` }} />
          </div>
          <div className="forecast-meta">
            <span><strong>{microToUsd(forecast.spentMicroUsd)}</strong> spent</span>
            <span className="forecast-mid">day {forecast.daysElapsed} / {forecast.daysInMonth}</span>
            <span>~<strong>{microToUsd(forecast.estimateMicroUsd)}</strong> est.</span>
          </div>

          {Object.keys(forecastByProvider).length > 0 && (
            <ul className="forecast-by-provider">
              {Object.entries(forecastByProvider)
                .sort((a, b) =>
                  Number(b[1].estimateMicroUsd) - Number(a[1].estimateMicroUsd),
                )
                .map(([provider, f]) => {
                  const color = providerColor(provider)
                  const est = Number(f.estimateMicroUsd)
                  const totalEst = Math.max(1, Number(forecast.estimateMicroUsd))
                  const sharePct = (est / totalEst) * 100
                  const spentPct = est > 0 ? (Number(f.spentMicroUsd) / est) * 100 : 0
                  return (
                    <li key={provider} className="forecast-prov-row">
                      <span className="row-chip" style={{ background: color, boxShadow: `0 0 6px ${color}66` }} />
                      <span className="forecast-prov-name">{providerName(provider)}</span>
                      <span className="forecast-prov-mini" aria-hidden>
                        <span
                          className="forecast-prov-mini-fill"
                          style={{ width: `${spentPct}%`, background: color }}
                        />
                      </span>
                      <span className="forecast-prov-spent">{microToUsd(f.spentMicroUsd)}</span>
                      <span className="forecast-prov-sep">/</span>
                      <span className="forecast-prov-est">~{microToUsd(f.estimateMicroUsd)}</span>
                      <span className="forecast-prov-share">{sharePct.toFixed(0)}%</span>
                    </li>
                  )
                })}
            </ul>
          )}
        </section>
      ) : (
        <section className="forecast-card forecast-empty">
          <span>Need ≥ 3 days of usage this month to forecast.</span>
        </section>
      )}

      <YieldScoreCard settings={settings} />

      {/* Overview cards are summary tiles — the full ranked lists live on
          dedicated tabs (Providers / Sessions). Cap to top 3 each so the
          page stays scannable; a long tail dilutes the headline. */}
      <section className="block">
        <div className="block-head">
          <h3>Top providers · {PERIOD_LABEL[period]}</h3>
        </div>
        <ProviderRows rows={providerRows.slice(0, 3)} />
      </section>

      <section className="block">
        <div className="block-head">
          <h3>Top models · today</h3>
        </div>
        <ModelRows rows={agg.topModelsToday.slice(0, 3)} />
      </section>

      <section className="block">
        <div className="block-head">
          <h3>Top projects · today</h3>
        </div>
        <ProjectRows rows={agg.topProjectsToday.slice(0, 3)} />
      </section>
    </>
  )
}
