import { useCallback, useEffect, useState } from 'react'

import type {
  AppSettings,
  PricingInfo,
  PrivacyLevel,
  ProviderListEntry,
  StorageInfo,
  SyncStatus,
} from '@shared/ipc-channels'

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

      <TeamSyncCard settings={settings} />

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
          across providers. <strong>On-device only by default</strong> — team
          sync is opt-in and uploads only what your privacy level allows.
        </p>
      </section>
    </>
  )
}

const PRIVACY_LABELS: Record<PrivacyLevel, string> = {
  full: 'Full — project + ids + tokens',
  redacted: 'Redacted — hashed projects, no ids',
  aggregateOnly: 'Aggregate only — daily totals',
}

function TeamSyncCard({ settings }: { settings: AppSettings | null }): JSX.Element {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [draining, setDraining] = useState(false)
  // Local mirror so the form is responsive — committed to settings on blur/change.
  const [serverUrl, setServerUrl] = useState('')
  const [teamId, setTeamId] = useState('')
  const [userId, setUserId] = useState('')

  useEffect(() => {
    if (settings === null) return
    setServerUrl(settings.teamSync.serverUrl ?? '')
    setTeamId(settings.teamSync.teamId ?? '')
    setUserId(settings.teamSync.userId ?? '')
  }, [settings])

  useEffect(() => {
    void window.api.syncStatus().then(setStatus)
    return window.api.onSyncStatusChanged((s) => setStatus(s))
  }, [])

  const update = useCallback(async (patch: Partial<AppSettings['teamSync']>) => {
    const cur = settings?.teamSync
    if (cur === undefined) return
    await window.api.setSettings({ teamSync: { ...cur, ...patch } })
    void window.api.syncStatus().then(setStatus)
  }, [settings])

  const handleDrain = useCallback(async () => {
    setDraining(true)
    try {
      const s = await window.api.syncDrain()
      setStatus(s)
    } finally {
      setDraining(false)
    }
  }, [])

  const cfg = settings?.teamSync
  const enabled = cfg?.enabled ?? false
  const configured = (cfg?.serverUrl ?? '') !== '' && (cfg?.teamId ?? '') !== '' && (cfg?.userId ?? '') !== ''

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <h3>Team Sync</h3>
        <label className="toggle-pill">
          <input
            type="checkbox"
            checked={enabled}
            disabled={cfg === undefined || !configured}
            onChange={(e) => void update({ enabled: e.target.checked })}
          />
          <span>{enabled ? 'on' : 'off'}</span>
        </label>
      </div>

      <p className="settings-hint">
        Upload a redacted projection of your usage to a team backend so
        teammates can see shared rollups. Strictly opt-in. Your local data
        and the rest of the app keep working unchanged.
      </p>

      <div className="settings-form">
        <label className="form-row">
          <span>Server URL</span>
          <input
            type="text"
            placeholder="https://sync.example.com"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            onBlur={() => void update({ serverUrl: serverUrl.trim() === '' ? null : serverUrl.trim() })}
          />
        </label>
        <label className="form-row">
          <span>Team ID</span>
          <input
            type="text"
            placeholder="team-abc"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            onBlur={() => void update({ teamId: teamId.trim() === '' ? null : teamId.trim() })}
          />
        </label>
        <label className="form-row">
          <span>User ID</span>
          <input
            type="text"
            placeholder="your-google-sub-or-email"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            onBlur={() => void update({ userId: userId.trim() === '' ? null : userId.trim() })}
          />
        </label>
        <fieldset className="form-radio-group">
          <legend>Privacy level</legend>
          {(['full', 'redacted', 'aggregateOnly'] as PrivacyLevel[]).map((level) => (
            <label key={level} className="form-radio">
              <input
                type="radio"
                name="privacyLevel"
                checked={cfg?.privacyLevel === level}
                disabled={cfg === undefined}
                onChange={() => void update({ privacyLevel: level })}
              />
              <span>{PRIVACY_LABELS[level]}</span>
            </label>
          ))}
        </fieldset>
      </div>

      <dl className="settings-rows">
        <div>
          <dt>Node ID</dt>
          <dd className="mono small" title="Unique per install">{status?.nodeId ?? '…'}</dd>
        </div>
        <div>
          <dt>Pending uploads</dt>
          <dd className="mono">{status?.pendingCount ?? 0}</dd>
        </div>
        <div>
          <dt>Last sync</dt>
          <dd>
            {status?.lastSyncAt !== null && status?.lastSyncAt !== undefined
              ? `${timeAgo(status.lastSyncAt)} ago`
              : 'never'}
          </dd>
        </div>
        {status?.lastError != null && (
          <div>
            <dt>Last error</dt>
            <dd className="form-error">{status.lastError}</dd>
          </div>
        )}
      </dl>

      <button
        type="button"
        className="refresh-btn"
        onClick={() => void handleDrain()}
        disabled={!enabled || !configured || draining}
      >
        {draining ? 'syncing…' : 'sync now'}
      </button>
    </section>
  )
}
