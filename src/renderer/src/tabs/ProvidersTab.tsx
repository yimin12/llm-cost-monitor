import type { AggregateSnapshot } from '@shared/aggregates'
import type { ProviderListEntry } from '@shared/ipc-channels'

import { microToUsd, providerColor, providerName, timeAgo } from '../lib/format'

export function ProvidersTab({ agg, providers }: {
  agg: AggregateSnapshot
  providers: ProviderListEntry[]
}): JSX.Element {
  const todayByProvider = new Map(agg.byProviderToday.map((p) => [p.provider, p]))
  const last30dByProvider = new Map(agg.byProvider30d.map((p) => [p.provider, p]))

  const detected = providers.filter((p) => p.isAvailable).length

  return (
    <>
      <section className="tab-context-head">
        <span className="tab-context-title">{providers.length} providers · {detected} detected</span>
        <span className="tab-context-sub">read-only — toggle in next release</span>
      </section>

      <ul className="provider-cards">
        {providers.map((p) => {
          const color = providerColor(p.id)
          const today = todayByProvider.get(p.id)
          const last30d = last30dByProvider.get(p.id)
          const lastSeen = agg.providerLastSeen[p.id]
          return (
            <li key={p.id} className="provider-card" data-available={p.isAvailable}>
              <div className="provider-card-head">
                <span className="provider-icon" style={{ background: color, boxShadow: `0 0 12px ${color}66` }}>
                  {providerName(p.id).charAt(0)}
                </span>
                <div className="provider-id">
                  <span className="provider-name">{p.name}</span>
                  <span className="provider-sub">{providerName(p.id).toLowerCase()}</span>
                </div>
                <span className="status-pill" data-state={p.isAvailable ? 'on' : 'off'}>
                  {p.isAvailable ? 'detected' : 'no data'}
                </span>
              </div>
              <div className="provider-card-stats">
                <div className="stat">
                  <span className="stat-label">today</span>
                  <span className="stat-value">{today ? microToUsd(today.costMicroUsd) : '—'}</span>
                  <span className="stat-sub">{today?.eventCount ?? 0} calls</span>
                </div>
                <div className="stat">
                  <span className="stat-label">30d</span>
                  <span className="stat-value">{last30d ? microToUsd(last30d.costMicroUsd) : '—'}</span>
                  <span className="stat-sub">{last30d?.eventCount ?? 0} calls</span>
                </div>
                <div className="stat">
                  <span className="stat-label">last seen</span>
                  <span className="stat-value small">
                    {typeof lastSeen === 'number' ? `${timeAgo(lastSeen)} ago` : '—'}
                  </span>
                  {p.cliCommand !== null && (
                    <span className="stat-sub mono">{p.cliCommand}</span>
                  )}
                </div>
              </div>
              {p.dashboardUrl !== null && (
                <a className="provider-link" href={p.dashboardUrl} target="_blank" rel="noreferrer">
                  open dashboard ↗
                </a>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}
