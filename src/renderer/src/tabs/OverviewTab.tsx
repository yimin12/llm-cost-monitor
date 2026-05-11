import type { AggregateSnapshot, CostByModel, CostByProject, CostByProvider } from '@shared/aggregates'
import type { AppSettings } from '@shared/ipc-channels'

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

const PERIOD_LABEL: Record<Period, string> = {
  today: 'Today',
  '7d': '7d',
  '1m': '1m',
  '6m': '6m',
  '1y': '1y',
}

export function OverviewTab({ agg, period, onPeriodChange, settings }: {
  agg: AggregateSnapshot
  period: Period
  onPeriodChange: (p: Period) => void
  settings: AppSettings | null
}): JSX.Element {
  const range = agg[PERIOD_RANGE[period]]
  const providerRows =
    period === 'today' ? agg.byProviderToday : agg[PERIOD_BY_PROVIDER[period]]

  const animatedDollar = useAnimatedNumber(Number(range.costMicroUsd) / 1_000_000)
  const animatedDollarText =
    animatedDollar >= 100 ? `$${animatedDollar.toFixed(1)}` : `$${animatedDollar.toFixed(2)}`

  const tokens = range.inputTokens + range.outputTokens

  const forecastPct = agg.forecast
    ? Math.min(
        100,
        (Number(agg.forecast.spentMicroUsd) /
          Math.max(1, Number(agg.forecast.estimateMicroUsd))) *
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

      {agg.forecast !== null ? (
        <section className="forecast-card">
          <div className="forecast-card-head">
            <span className="chart-card-title">Month-end forecast · total</span>
            <span className="forecast-pct">{forecastPct.toFixed(0)}%</span>
          </div>
          <div className="forecast-bar" aria-hidden>
            <div className="forecast-bar-fill" style={{ width: `${forecastPct}%` }} />
          </div>
          <div className="forecast-meta">
            <span><strong>{microToUsd(agg.forecast.spentMicroUsd)}</strong> spent</span>
            <span className="forecast-mid">day {agg.forecast.daysElapsed} / {agg.forecast.daysInMonth}</span>
            <span>~<strong>{microToUsd(agg.forecast.estimateMicroUsd)}</strong> est.</span>
          </div>

          {Object.keys(agg.forecastByProvider).length > 0 && (
            <ul className="forecast-by-provider">
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

      <section className="block">
        <div className="block-head">
          <h3>By provider · {PERIOD_LABEL[period]}</h3>
        </div>
        <ProviderRows rows={providerRows} />
      </section>

      <section className="block">
        <div className="block-head">
          <h3>Top models · today</h3>
        </div>
        <ModelRows rows={agg.topModelsToday} />
      </section>

      <section className="block">
        <div className="block-head">
          <h3>Top projects · today</h3>
        </div>
        <ProjectRows rows={agg.topProjectsToday} />
      </section>
    </>
  )
}
