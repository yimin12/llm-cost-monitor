import { useCallback, useEffect, useState } from 'react'

import type {
  AggregateSnapshot,
  AuthState,
  PricingInfo,
  ProviderListEntry,
  StorageInfo,
} from '@shared/ipc-channels'

import { AuthHeader } from './components/AuthHeader'

declare global {
  interface Window {
    api: {
      ping: () => Promise<string>
      pricingInfo: () => Promise<PricingInfo>
      storageInfo: () => Promise<StorageInfo>
      aggregates: () => Promise<AggregateSnapshot>
      providersList: () => Promise<ProviderListEntry[]>
      providersRefresh: () => Promise<{ provider: string; error: string | null }[]>
      onUsageUpdated: (cb: () => void) => () => void
      authCurrent: () => Promise<AuthState>
      authSignIn: () => Promise<AuthState>
      authSignOut: () => Promise<AuthState>
      onAuthStateChanged: (cb: (state: AuthState) => void) => () => void
    }
  }
}

function microToUsd(micro: bigint | number): string {
  const n = typeof micro === 'bigint' ? Number(micro) : micro
  return `$${(n / 1_000_000).toFixed(2)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'Codex',
  google: 'Gemini',
  moonshotai: 'Kimi',
  deepseek: 'DeepSeek',
  xai: 'Grok',
  zai: 'GLM',
}

function providerName(id: string): string {
  return PROVIDER_LABEL[id] ?? id
}

export function App(): JSX.Element {
  const [agg, setAgg] = useState<AggregateSnapshot | null>(null)
  const [pricing, setPricing] = useState<PricingInfo | null>(null)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [providers, setProviders] = useState<ProviderListEntry[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const reload = useCallback(async () => {
    const [a, s, ps] = await Promise.all([
      window.api.aggregates(),
      window.api.storageInfo(),
      window.api.providersList(),
    ])
    setAgg(a)
    setStorage(s)
    setProviders(ps)
  }, [])

  useEffect(() => {
    void window.api.pricingInfo().then(setPricing)
    void reload()
    return window.api.onUsageUpdated(() => {
      void reload()
    })
  }, [reload])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await window.api.providersRefresh()
    } finally {
      setRefreshing(false)
    }
  }, [])

  if (agg === null) {
    return (
      <div className="dropdown loading">
        <p>loading…</p>
      </div>
    )
  }

  return (
    <div className="dropdown">
      <header className="dropdown-header">
        <span className="title">llm-cost-monitor</span>
        <button
          type="button"
          className="refresh-btn"
          disabled={refreshing}
          onClick={() => void handleRefresh()}
        >
          {refreshing ? '↻ refreshing…' : '↻ refresh'}
        </button>
      </header>

      <AuthHeader />


      <section className="totals">
        <div className="total-card">
          <span className="label">Today</span>
          <span className="value">{microToUsd(agg.today.costMicroUsd)}</span>
          <span className="sub">{agg.today.eventCount} calls</span>
        </div>
        <div className="total-card">
          <span className="label">7d</span>
          <span className="value">{microToUsd(agg.last7d.costMicroUsd)}</span>
          <span className="sub">{agg.last7d.eventCount} calls</span>
        </div>
        <div className="total-card">
          <span className="label">30d</span>
          <span className="value">{microToUsd(agg.last30d.costMicroUsd)}</span>
          <span className="sub">{agg.last30d.eventCount} calls</span>
        </div>
      </section>

      {agg.forecast !== null && (
        <section className="forecast">
          <div className="forecast-row">
            <span className="forecast-label">Spent so far</span>
            <span className="forecast-value">{microToUsd(agg.forecast.spentMicroUsd)}</span>
            <span className="forecast-sub">
              day {agg.forecast.daysElapsed}/{agg.forecast.daysInMonth}
            </span>
          </div>
          <div className="forecast-row">
            <span className="forecast-label">Month-end est.</span>
            <span className="forecast-value">{microToUsd(agg.forecast.estimateMicroUsd)}</span>
            <span className="forecast-sub">
              ± {microToUsd(agg.forecast.confidenceBandMicroUsd)}
            </span>
          </div>
        </section>
      )}
      {agg.forecast === null && (
        <section className="forecast forecast-empty">
          <span>Need ≥ 3 days of data for a month-end forecast.</span>
        </section>
      )}

      <section className="block">
        <h3>By provider — today</h3>
        {agg.byProviderToday.length === 0 ? (
          <p className="empty">no calls today yet</p>
        ) : (
          <ul className="rows">
            {agg.byProviderToday.map((p) => (
              <li key={p.provider}>
                <span className="row-label">{providerName(p.provider)}</span>
                <span className="row-cost">{microToUsd(p.costMicroUsd)}</span>
                <span className="row-count">{p.eventCount}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="block">
        <h3>By provider — 30d</h3>
        {agg.byProvider30d.length === 0 ? (
          <p className="empty">no calls in last 30d</p>
        ) : (
          <ul className="rows">
            {agg.byProvider30d.map((p) => (
              <li key={p.provider}>
                <span className="row-label">{providerName(p.provider)}</span>
                <span className="row-cost">{microToUsd(p.costMicroUsd)}</span>
                <span className="row-count">{p.eventCount}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="block">
        <h3>Top models — today</h3>
        {agg.topModelsToday.length === 0 ? (
          <p className="empty">—</p>
        ) : (
          <ul className="rows">
            {agg.topModelsToday.map((m) => (
              <li key={`${m.provider}/${m.model}`}>
                <span className="row-label" title={m.model}>
                  {m.model}
                </span>
                <span className="row-cost">{microToUsd(m.costMicroUsd)}</span>
                <span className="row-count">{m.eventCount}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="block">
        <h3>Top projects — today</h3>
        {agg.topProjectsToday.length === 0 ? (
          <p className="empty">—</p>
        ) : (
          <ul className="rows">
            {agg.topProjectsToday.map((p) => (
              <li key={p.project}>
                <span className="row-label">{p.project}</span>
                <span className="row-cost">{microToUsd(p.costMicroUsd)}</span>
                <span className="row-count">{p.eventCount}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="dropdown-footer">
        <span>
          {storage?.eventCount ?? 0} events · pricing {pricing?.snapshotVersion ?? '…'}
        </span>
        <span>
          7d: {formatTokens(agg.last7d.inputTokens + agg.last7d.outputTokens)} tok
        </span>
      </footer>

      <section className="block providers-list">
        <h3>Providers</h3>
        <ul className="rows">
          {providers.map((p) => (
            <li key={p.id}>
              <span className="row-label">{p.name}</span>
              <span className="row-cost">{p.isAvailable ? 'detected' : 'no data'}</span>
              <span className="row-count">{p.isEnabled ? 'on' : 'off'}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="privacy">
        <p className="privacy-line">
          <strong>On-device only.</strong> Session logs scanned locally; no
          telemetry, no cloud sync.
        </p>
      </section>
    </div>
  )
}
