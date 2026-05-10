import { useCallback, useMemo, useState } from 'react'

import {
  CAPABILITY_LABEL,
  CAPABILITY_ORDER,
  CATALOG,
  type Capability,
  type CatalogProvider,
} from '@shared/provider-catalog'
import type { AppSettings, ProviderListEntry } from '@shared/ipc-channels'

import { ProviderIcon } from './ProviderIcon'

// Self-contained "Provider catalog" panel for the web dashboard. Shows
// every supported vendor (regardless of whether devbar can already
// detect them on disk), groups them by user-selected capability filter,
// and lets the user enter an API key inline per provider.
//
// Three states a row can be in:
//   1. tracked + detected on disk → green pill ("connected")
//   2. tracked but not yet seen   → grey pill ("ready, no events")
//   3. not yet tracked             → orange pill ("api key only")
// Plus an extra hint when an API key is present: "key saved Xm ago".

export interface ProviderCatalogProps {
  /** Live provider list from devbar's runtime probe — used to mark
   *  providers that are auto-detected on this machine. */
  detectedProviders: ProviderListEntry[]
  /** Settings snapshot; we read & write providerCredentials here. */
  settings: AppSettings | null
}

type CapFilter = 'all' | Capability

export function ProviderCatalog({
  detectedProviders,
  settings,
}: ProviderCatalogProps): JSX.Element {
  const [filter, setFilter] = useState<CapFilter>('all')

  const detectedById = useMemo(
    () => new Map(detectedProviders.map((p) => [p.id, p])),
    [detectedProviders],
  )

  const visible = useMemo(
    () =>
      filter === 'all'
        ? CATALOG
        : CATALOG.filter((c) => c.capabilities.includes(filter)),
    [filter],
  )

  return (
    <section className="web-card">
      <header className="web-card-head">
        <div>
          <h2>Provider catalog</h2>
          <p>
            Add an API key to track usage from a vendor devbar can&rsquo;t
            yet auto-detect, or sign in to a supported provider. {CATALOG.length}{' '}
            vendors. Keys stay on this machine — never sent anywhere except the
            vendor&rsquo;s own endpoint.
          </p>
        </div>
      </header>

      <div className="catalog-filter-bar" role="tablist" aria-label="Filter by capability">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
          All
        </FilterChip>
        {CAPABILITY_ORDER.map((cap) => (
          <FilterChip
            key={cap}
            active={filter === cap}
            onClick={() => setFilter(cap)}
          >
            {CAPABILITY_LABEL[cap]}
          </FilterChip>
        ))}
      </div>

      <ul className="catalog-grid">
        {visible.map((p) => (
          <CatalogRow
            key={p.id}
            entry={p}
            detected={detectedById.get(p.id) ?? null}
            settings={settings}
          />
        ))}
      </ul>
    </section>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? 'catalog-filter-chip active' : 'catalog-filter-chip'}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function CatalogRow({
  entry,
  detected,
  settings,
}: {
  entry: CatalogProvider
  detected: ProviderListEntry | null
  settings: AppSettings | null
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const credential = settings?.providerCredentials?.[entry.id]
  const hasKey = (credential?.apiKey ?? '').length > 0

  // Per-row status rolls up three signals:
  // (1) detected by runtime probe → "connected"
  // (2) credentials saved but no probe yet → "key saved"
  // (3) tracked-by-devbar but unseen → "ready"
  // (4) not tracked + no key → "available"
  const status = detected !== null && detected.isAvailable
    ? { label: 'Connected', tone: 'good' as const }
    : hasKey
      ? { label: 'Key saved', tone: 'info' as const }
      : entry.trackedByDevbar
        ? { label: 'Ready, no events', tone: 'mute' as const }
        : { label: 'Available', tone: 'mute' as const }

  return (
    <li className="catalog-row" data-expanded={expanded}>
      <div className="catalog-row-main">
        <span
          className="catalog-row-icon"
          style={{
            background: `#${entry.brandHex}24`,
            boxShadow: `0 0 14px #${entry.brandHex}55`,
            color: `#${entry.brandHex}`,
          }}
        >
          {entry.brandIconKey !== null ? (
            <ProviderIcon id={entry.brandIconKey} size={20} />
          ) : (
            entry.name.charAt(0)
          )}
        </span>
        <div className="catalog-row-id">
          <a
            className="catalog-row-name"
            href={entry.homepage}
            target="_blank"
            rel="noreferrer"
          >
            {entry.name}
          </a>
          <span className="catalog-row-blurb">{entry.blurb}</span>
          <ul className="catalog-cap-tags">
            {entry.capabilities.map((cap) => (
              <li key={cap} className="catalog-cap-tag" data-cap={cap}>
                {CAPABILITY_LABEL[cap]}
              </li>
            ))}
          </ul>
        </div>
        <div className="catalog-row-meta">
          <span className={`catalog-row-status tone-${status.tone}`}>
            {status.label}
          </span>
          <button
            type="button"
            className="catalog-row-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Hide' : hasKey ? 'Manage' : 'Configure'}
          </button>
        </div>
      </div>
      {expanded && <CatalogRowForm entry={entry} credential={credential ?? null} />}
    </li>
  )
}

function CatalogRowForm({
  entry,
  credential,
}: {
  entry: CatalogProvider
  credential: { apiKey: string; updatedAt: number } | null
}): JSX.Element {
  const [draft, setDraft] = useState(credential?.apiKey ?? '')
  const [reveal, setReveal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(credential?.updatedAt ?? null)

  const save = useCallback(async () => {
    setSaving(true)
    try {
      const trimmed = draft.trim()
      const updatedAt = Date.now()
      // We pass the *full* desired record; SettingsStore.set merges
      // shallowly per-key, so other providers' creds aren't disturbed.
      await window.api.setSettings({
        providerCredentials: trimmed.length === 0
          ? { [entry.id]: { apiKey: '', updatedAt } } // empty = effectively cleared
          : { [entry.id]: { apiKey: trimmed, updatedAt } },
      })
      setSavedAt(trimmed.length === 0 ? null : updatedAt)
    } finally {
      setSaving(false)
    }
  }, [draft, entry.id])

  return (
    <div className="catalog-row-form">
      {entry.auth.includes('oauth') && (
        <div className="catalog-form-section">
          <span className="catalog-form-label">Sign in</span>
          <button
            type="button"
            className="catalog-form-oauth"
            disabled
            title="Native OAuth flow ships in a future release. Use API key for now."
          >
            Sign in with {entry.name}
            <span className="catalog-form-oauth-soon">soon</span>
          </button>
        </div>
      )}
      {entry.auth.includes('apiKey') && (
        <div className="catalog-form-section">
          <label className="catalog-form-label" htmlFor={`apikey-${entry.id}`}>
            API key
          </label>
          <div className="catalog-form-row">
            <input
              id={`apikey-${entry.id}`}
              type={reveal ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`Paste your ${entry.name} API key here`}
            />
            <button
              type="button"
              className="catalog-form-eye"
              aria-label={reveal ? 'Hide key' : 'Show key'}
              onClick={() => setReveal((v) => !v)}
            >
              {reveal ? '🙈' : '👁'}
            </button>
            <button
              type="button"
              className="catalog-form-save"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? 'saving…' : 'Save'}
            </button>
          </div>
          <div className="catalog-form-hints">
            {entry.apiKeyHelpUrl !== null && (
              <a href={entry.apiKeyHelpUrl} target="_blank" rel="noreferrer">
                Where do I get my key? ↗
              </a>
            )}
            {savedAt !== null && (
              <span className="catalog-form-saved-at">
                key saved · {new Date(savedAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
