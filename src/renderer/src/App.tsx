import { useCallback, useEffect, useRef, useState } from 'react'

import type { AggregateSnapshot } from '@shared/aggregates'
import type {
  AppSettings,
  PricingInfo,
  ProviderListEntry,
  StorageInfo,
} from '@shared/ipc-channels'

import { timeAgo } from './lib/format'
import { OverviewTab } from './tabs/OverviewTab'
import { ProvidersTab } from './tabs/ProvidersTab'
import { SessionsTab } from './tabs/SessionsTab'
import { SettingsTab } from './tabs/SettingsTab'

declare global {
  interface Window {
    api: {
      ping: () => Promise<string>
      pricingInfo: () => Promise<PricingInfo>
      storageInfo: () => Promise<StorageInfo>
      aggregates: () => Promise<AggregateSnapshot>
      providersList: () => Promise<ProviderListEntry[]>
      providersRefresh: () => Promise<{ provider: string; error: string | null }[]>
      settings: () => Promise<AppSettings>
      onUsageUpdated: (cb: () => void) => () => void
    }
  }
}

type TabId = 'overview' | 'providers' | 'sessions' | 'settings'
const TABS: { id: TabId; label: string; icon: JSX.Element }[] = [
  {
    id: 'overview',
    label: 'Overview',
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 17l5-5 4 4 8-8" />
        <path d="M14 8h6v6" />
      </svg>
    ),
  },
  {
    id: 'providers',
    label: 'Providers',
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
      </svg>
    ),
  },
  {
    id: 'sessions',
    label: 'Sessions',
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
]

const ACTIVE_TAB_KEY = 'lcm.activeTab'
const PERIOD_KEY = 'lcm.period'

type Period = 'today' | '7d' | '30d'

function loadInitialTab(): TabId {
  try {
    const v = localStorage.getItem(ACTIVE_TAB_KEY)
    if (v === 'overview' || v === 'providers' || v === 'sessions' || v === 'settings') return v
  } catch {
    /* localStorage unavailable */
  }
  return 'overview'
}
function loadInitialPeriod(): Period {
  try {
    const v = localStorage.getItem(PERIOD_KEY)
    if (v === 'today' || v === '7d' || v === '30d') return v
  } catch {
    /* */
  }
  return 'today'
}

export function App(): JSX.Element {
  const [agg, setAgg] = useState<AggregateSnapshot | null>(null)
  const [pricing, setPricing] = useState<PricingInfo | null>(null)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [providers, setProviders] = useState<ProviderListEntry[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>(loadInitialTab)
  const [period, setPeriod] = useState<Period>(loadInitialPeriod)
  const [, forceTick] = useState(0)

  // Track which tabs have been mounted at least once. Inactive tabs render
  // hidden after first mount to keep their state alive cheaply.
  const [mountedTabs, setMountedTabs] = useState<Set<TabId>>(() => new Set([loadInitialTab()]))

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

  // Debounced reload — coalesce bursts of usage:updated events from
  // back-to-back provider scans into one snapshot fetch per 250 ms.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) clearTimeout(reloadTimer.current)
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null
      void reload()
    }, 250)
  }, [reload])

  useEffect(() => {
    void window.api.pricingInfo().then(setPricing)
    void window.api.settings().then(setSettings)
    void reload()
    return window.api.onUsageUpdated(scheduleReload)
  }, [reload, scheduleReload])

  // Ticker for "live · Xs ago" pills.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    try { localStorage.setItem(ACTIVE_TAB_KEY, activeTab) } catch { /* */ }
  }, [activeTab])

  useEffect(() => {
    try { localStorage.setItem(PERIOD_KEY, period) } catch { /* */ }
  }, [period])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await window.api.providersRefresh()
    } finally {
      setRefreshing(false)
    }
  }, [])

  const switchTab = useCallback((id: TabId) => {
    setActiveTab(id)
    setMountedTabs((prev) => (prev.has(id) ? prev : new Set([...prev, id])))
  }, [])

  if (agg === null) {
    return (
      <div className="dropdown loading">
        <div className="loader-pulse" />
        <p>loading…</p>
      </div>
    )
  }

  return (
    <div className="dropdown">
      <div className="aurora" aria-hidden />

      <header className="dropdown-header">
        <div className="title-block">
          <span className="title-glyph" aria-hidden>
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path d="M3 17l5-5 4 4 8-8" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="title">llm-cost-monitor</span>
          <span className="live-pill" title={`updated ${timeAgo(agg.generatedAt)} ago`}>
            <span className="live-dot" />
            <span>live · {timeAgo(agg.generatedAt)} ago</span>
          </span>
        </div>
        <button
          type="button"
          className="refresh-btn"
          disabled={refreshing}
          onClick={() => void handleRefresh()}
          aria-label="Refresh"
        >
          <span className={refreshing ? 'spin' : ''} aria-hidden>↻</span>
          {refreshing ? 'refreshing' : 'refresh'}
        </button>
      </header>

      <nav className="tab-bar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            className={activeTab === t.id ? 'tab-tile active' : 'tab-tile'}
            onClick={() => switchTab(t.id)}
          >
            <span className="tab-tile-icon">{t.icon}</span>
            <span className="tab-tile-label">{t.label}</span>
          </button>
        ))}
      </nav>

      <main className="tab-pane">
        {mountedTabs.has('overview') && (
          <div hidden={activeTab !== 'overview'}>
            <OverviewTab agg={agg} period={period} onPeriodChange={setPeriod} />
          </div>
        )}
        {mountedTabs.has('providers') && (
          <div hidden={activeTab !== 'providers'}>
            <ProvidersTab agg={agg} providers={providers} />
          </div>
        )}
        {mountedTabs.has('sessions') && (
          <div hidden={activeTab !== 'sessions'}>
            <SessionsTab agg={agg} />
          </div>
        )}
        {mountedTabs.has('settings') && (
          <div hidden={activeTab !== 'settings'}>
            <SettingsTab
              settings={settings}
              pricing={pricing}
              storage={storage}
              providers={providers}
              lastRefreshMs={agg.generatedAt}
            />
          </div>
        )}
      </main>

      <section className="privacy">
        <span className="privacy-dot" />
        <span>
          <strong>On-device only.</strong> Session logs scanned locally · no telemetry · no cloud sync.
        </span>
      </section>
    </div>
  )
}
