import type { AggregateSnapshot } from '@shared/aggregates'
import type { AppSettings, ProviderListEntry } from '@shared/ipc-channels'

import { microToUsd, providerColor, providerName, timeAgo } from '../lib/format'

export function ProvidersTab({ agg, providers, dashboardUrl, settings }: {
  agg: AggregateSnapshot
  providers: ProviderListEntry[]
  dashboardUrl: string | null
  settings: AppSettings | null
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

      {dashboardUrl !== null && (
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
          Details
        </button>
      )}

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
                {(() => {
                  // User can override the chip label per-provider in
                  // Settings. When set, the chip renders as a subscription
                  // tier (because that's the most common reason to
                  // override — e.g. claiming Gemini Pro that the OIDC
                  // token can't surface).
                  const override = settings?.planOverrides?.[p.id]?.trim()
                  const useOverride = override !== undefined && override.length > 0
                  const mode = useOverride ? 'subscription' : p.plan.authMode
                  const titleText = useOverride
                    ? `Manual override · ${override}`
                    : p.plan.source === null
                      ? 'No credentials detected'
                      : `${p.plan.source}${p.plan.detail !== null ? ` · ${p.plan.detail}` : ''}`
                  return (
                    <span className={`plan-chip plan-${mode}`} title={titleText}>
                      {useOverride && `Plan: ${override}`}
                      {!useOverride && p.plan.authMode === 'subscription' && `Plan: ${p.plan.planName ?? 'Subscription'}`}
                      {!useOverride && p.plan.authMode === 'oauth' && (p.plan.planName ?? 'OAuth')}
                      {!useOverride && p.plan.authMode === 'apiKey' && 'API Calling'}
                      {!useOverride && p.plan.authMode === 'none' && 'no auth'}
                      {!useOverride && p.plan.authMode === 'unknown' && 'unknown'}
                    </span>
                  )
                })()}
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
