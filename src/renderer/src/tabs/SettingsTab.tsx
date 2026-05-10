import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  AppSettings,
  PricingInfo,
  PrivacyLevel,
  ProviderKeyStatus,
  ProviderListEntry,
  StorageInfo,
  SyncStatus,
} from '@shared/ipc-channels'
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  PROVIDER_CATALOG,
  entriesByCategory,
  type CatalogEntry,
} from '@shared/provider-catalog'

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

      <PlanOverrideCard providers={providers} settings={settings} />

      <ProviderCatalogCard />

      <section className="settings-card about-card">
        <div className="settings-card-head">
          <h3>About</h3>
        </div>
        <p className="about-line">
          <strong>devbar</strong> · tracks LLM token usage + cost
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

function PlanOverrideCard({
  providers,
  settings,
}: {
  providers: ProviderListEntry[]
  settings: AppSettings | null
}): JSX.Element {
  // Local form mirror so each input is responsive; commit to settings on
  // blur. Pre-seed from the persisted settings each time those change.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({}))

  useEffect(() => {
    if (settings === null) return
    setDrafts({ ...settings.planOverrides })
  }, [settings])

  const commit = useCallback(async (id: string, value: string) => {
    const cur = settings?.planOverrides ?? {}
    const trimmed = value.trim()
    const next = { ...cur }
    if (trimmed.length === 0) {
      delete next[id]
    } else {
      next[id] = trimmed
    }
    await window.api.setSettings({ planOverrides: next })
  }, [settings])

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <h3>Plan label override</h3>
        <span className="settings-sub">manual</span>
      </div>
      <p className="settings-hint">
        Some vendors don&rsquo;t expose subscription tier in their local
        OAuth tokens (notably Google / Gemini). Set a label here to force
        the chip to read &ldquo;Plan: <em>your text</em>&rdquo;. Leave
        blank to fall back to the auto-detected value.
      </p>
      <div className="settings-form">
        {providers.map((p) => {
          const detected =
            p.plan.authMode === 'subscription'
              ? `Plan: ${p.plan.planName ?? 'Subscription'}`
              : p.plan.authMode === 'oauth'
                ? (p.plan.planName ?? 'OAuth')
                : p.plan.authMode === 'apiKey'
                  ? 'API Calling'
                  : p.plan.authMode === 'none'
                    ? 'no auth'
                    : 'unknown'
          return (
            <label key={p.id} className="form-row">
              <span>{p.name}</span>
              <input
                type="text"
                placeholder={detected}
                value={drafts[p.id] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                onBlur={() => void commit(p.id, drafts[p.id] ?? '')}
              />
            </label>
          )
        })}
      </div>
    </section>
  )
}

// ── Provider catalog card ──────────────────────────────────────────
// Lists every entry in PROVIDER_CATALOG grouped by category. Each row
// surfaces whether a key is configured (chip), an inline input to add
// or replace the key, and a remove button. The renderer never sees the
// plaintext after submit — main process encrypts via safeStorage and
// returns only a status object.

function ProviderCatalogCard(): JSX.Element {
  const grouped = useMemo(() => entriesByCategory(), [])
  const allIds = useMemo(() => PROVIDER_CATALOG.map((e) => e.id), [])
  const [statuses, setStatuses] = useState<Record<string, ProviderKeyStatus>>({})
  const [toast, setToast] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const list = await window.api.providerKeyList(allIds)
    const m: Record<string, ProviderKeyStatus> = {}
    for (const s of list) m[s.providerId] = s
    setStatuses(m)
  }, [allIds])

  useEffect(() => {
    void reload()
  }, [reload])

  const flashToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }, [])

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <h3>Provider Catalog</h3>
        <span className="enabled-dot on" />
      </div>
      <p className="settings-help">
        Add API keys for providers that aren't auto-detected from local CLI logs.
        Keys are stored encrypted on this device via the OS keychain (safeStorage)
        — never uploaded.
      </p>
      {toast !== null && <div className="catalog-toast" role="status">{toast}</div>}
      {CATEGORY_ORDER.map((cat) => {
        const entries = grouped[cat]
        if (entries.length === 0) return null
        return (
          <div key={cat} className="catalog-group">
            <h4 className="catalog-group-title">{CATEGORY_LABELS[cat]}</h4>
            <ul className="catalog-list">
              {entries.map((e) => (
                <CatalogRow
                  key={e.id}
                  entry={e}
                  status={statuses[e.id] ?? null}
                  onSaved={(msg) => {
                    flashToast(msg)
                    void reload()
                  }}
                />
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

function CatalogRow({
  entry,
  status,
  onSaved,
}: {
  entry: CatalogEntry
  status: ProviderKeyStatus | null
  onSaved: (msg: string) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const configured = status?.configured === true

  const submit = async (): Promise<void> => {
    if (value.trim().length === 0) return
    setBusy(true)
    try {
      const r = await window.api.providerKeySet(entry.id, value)
      if (r.ok) {
        onSaved(`${entry.name}: saved`)
        setValue('')
        setEditing(false)
      } else {
        onSaved(`${entry.name} failed: ${r.message ?? r.error}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.providerKeyDelete(entry.id)
      if (r.ok) {
        onSaved(`${entry.name}: removed`)
      } else {
        onSaved(`${entry.name} failed: ${r.message ?? r.error}`)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="catalog-row" data-configured={configured}>
      <div className="catalog-row-head">
        <div className="catalog-row-id">
          <span className="catalog-row-name">{entry.name}</span>
          <span className="catalog-row-desc">{entry.description}</span>
        </div>
        <span
          className={`catalog-key-chip ${configured ? 'on' : 'off'}`}
          title={
            configured && status?.encryptionAvailable === false
              ? 'Stored, but OS keychain unavailable — key is only obfuscated.'
              : configured
                ? 'API key configured (encrypted)'
                : 'No API key configured'
          }
        >
          {configured ? 'key set' : 'no key'}
        </span>
      </div>
      <div className="catalog-row-actions">
        <a className="catalog-link" href={entry.apiKeyHelpUrl} target="_blank" rel="noreferrer">
          get key ↗
        </a>
        {entry.websiteUrl !== undefined && (
          <a className="catalog-link dim" href={entry.websiteUrl} target="_blank" rel="noreferrer">
            website ↗
          </a>
        )}
        {!editing && (
          <button
            type="button"
            className="catalog-action"
            onClick={() => setEditing(true)}
            disabled={busy}
          >
            {configured ? 'replace key' : 'add API key'}
          </button>
        )}
        {configured && !editing && (
          <button
            type="button"
            className="catalog-action danger"
            onClick={() => void remove()}
            disabled={busy}
          >
            remove
          </button>
        )}
      </div>
      {editing && (
        <form
          className="catalog-form"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <input
            type="password"
            className="catalog-input"
            placeholder={entry.apiKeyPlaceholder}
            value={value}
            onChange={(ev) => setValue(ev.currentTarget.value)}
            autoFocus
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            className="catalog-action primary"
            disabled={busy || value.trim().length === 0}
          >
            confirm
          </button>
          <button
            type="button"
            className="catalog-action"
            disabled={busy}
            onClick={() => {
              setEditing(false)
              setValue('')
            }}
          >
            cancel
          </button>
        </form>
      )}
    </li>
  )
}
