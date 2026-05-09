import type { AppSettings, PricingInfo, ProviderListEntry, StorageInfo } from '@shared/ipc-channels'

import { providerColor, providerName, timeAgo } from '../lib/format'

function fmtCadence(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

export function SettingsTab({
  settings, pricing, storage, providers, lastRefreshMs,
}: {
  settings: AppSettings | null
  pricing: PricingInfo | null
  storage: StorageInfo | null
  providers: ProviderListEntry[]
  lastRefreshMs: number | null
}): JSX.Element {
  const enabledProviders = providers.filter(
    (p) => settings?.providers[p.id]?.enabled ?? p.isEnabled,
  )
  const disabledProviders = providers.filter(
    (p) => !(settings?.providers[p.id]?.enabled ?? p.isEnabled),
  )

  return (
    <>
      <section className="settings-card">
        <div className="settings-card-head">
          <h3>Sync Status</h3>
          <span className="enabled-dot on" />
        </div>
        <dl className="settings-rows">
          <div>
            <dt>Refresh cadence</dt>
            <dd className="mono">{settings ? fmtCadence(settings.refreshIntervalMs) : '…'}</dd>
          </div>
          <div>
            <dt>Last refresh</dt>
            <dd>{lastRefreshMs !== null ? `${timeAgo(lastRefreshMs)} ago` : 'never'}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd className="status-pill" data-state="on">connected · local</dd>
          </div>
        </dl>
      </section>

      <section className="settings-card">
        <div className="settings-card-head">
          <h3>Storage</h3>
        </div>
        <dl className="settings-rows">
          <div>
            <dt>Events stored</dt>
            <dd className="mono">{storage?.eventCount.toLocaleString() ?? '…'}</dd>
          </div>
          <div>
            <dt>Pricing snapshot</dt>
            <dd className="mono">{pricing?.snapshotVersion ?? '…'}</dd>
          </div>
          <div>
            <dt>Models priced</dt>
            <dd className="mono">{pricing?.modelCount.toLocaleString() ?? '…'}</dd>
          </div>
        </dl>
      </section>

      <section className="settings-card">
        <div className="settings-card-head">
          <h3>Providers</h3>
          <span className="settings-sub">{enabledProviders.length} enabled · {disabledProviders.length} off</span>
        </div>
        <ul className="settings-provider-list">
          {providers.map((p) => {
            const enabled = settings?.providers[p.id]?.enabled ?? p.isEnabled
            return (
              <li key={p.id}>
                <span className="row-chip" style={{
                  background: providerColor(p.id),
                  opacity: enabled ? 1 : 0.3,
                  boxShadow: enabled ? `0 0 8px ${providerColor(p.id)}66` : 'none',
                }} />
                <span className="row-label">{providerName(p.id)}</span>
                <span className="settings-provider-state">{enabled ? 'on' : 'off'}</span>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="settings-card about-card">
        <div className="settings-card-head">
          <h3>About</h3>
        </div>
        <p className="about-line">
          <strong>llm-cost-monitor</strong> · tracks LLM token usage + cost
          across providers. <strong>On-device only.</strong> No telemetry, no
          cloud sync. Session logs are scanned locally; nothing leaves the
          machine.
        </p>
      </section>
    </>
  )
}
