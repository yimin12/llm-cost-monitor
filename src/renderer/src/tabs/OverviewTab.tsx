import type { AggregateSnapshot, CostByModel, CostByProject, CostByProvider } from '@shared/aggregates'

import { AreaChart, Donut, ShareBar, useAnimatedNumber } from '../components/charts'
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

type Period = 'today' | '7d' | '30d'

export function OverviewTab({ agg, period, onPeriodChange }: {
  agg: AggregateSnapshot
  period: Period
  onPeriodChange: (p: Period) => void
}): JSX.Element {
  const range = period === 'today' ? agg.today : period === '7d' ? agg.last7d : agg.last30d
  const providerRows = period === 'today' ? agg.byProviderToday : agg.byProvider30d

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
        {(['today', '7d', '30d'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={period === k}
            className={period === k ? 'period-tab active' : 'period-tab'}
            onClick={() => onPeriodChange(k)}
          >
            {k === 'today' ? 'Today' : k}
          </button>
        ))}
      </div>

      <section className="hero">
        <div className="hero-left">
          <span className="hero-label">{period === 'today' ? 'Today' : `Last ${period}`}</span>
          <span className="hero-value">{animatedDollarText}</span>
          <div className="hero-meta">
            <span className="meta-pill">
              <span className="meta-pill-dot" /> {range.eventCount} calls
            </span>
            <span className="meta-pill">{formatTokens(tokens)} tokens</span>
          </div>
        </div>
        <Donut
          slices={donutSlices}
          centerLabel="providers"
          centerValue={String(donutSlices.length)}
        />
      </section>

      <section className="chart-card">
        <div className="chart-card-head">
          <span className="chart-card-title">Daily spend · last 14d</span>
          <span className="chart-card-sub">
            peak {microToUsd(agg.dailyCostMicroUsd.reduce((a, b) => (a > b ? a : b), 0n))}
          </span>
        </div>
        <AreaChart values={agg.dailyCostMicroUsd} />
        <div className="chart-axis">
          <span>14d ago</span>
          <span>today</span>
        </div>
      </section>

      {agg.forecast !== null ? (
        <section className="forecast-card">
          <div className="forecast-card-head">
            <span className="chart-card-title">Month-end forecast</span>
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
        </section>
      ) : (
        <section className="forecast-card forecast-empty">
          <span>Need ≥ 3 days of usage this month to forecast.</span>
        </section>
      )}

      <section className="block">
        <div className="block-head">
          <h3>By provider · {period}</h3>
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
