import { useCallback, useEffect, useRef, useState } from 'react'

import type { AggregateSnapshot } from '@shared/aggregates'
import type {
  Alert,
  AlertFilter,
  AlertSummary,
  AppSettings,
  AuthState,
  PricingInfo,
  ProviderKeyResult,
  ProviderKeyStatus,
  ProviderListEntry,
  StorageInfo,
  SyncStatus,
  TeamManageResult,
  TeamMemberRole,
  TeamOverview,
} from '@shared/ipc-channels'
import type { PrivacyLevel } from '@shared/sync'

import { AuthHeader } from './components/AuthHeader'
import { PrivacyBanner } from './components/PrivacyBanner'
import { timeAgo } from './lib/format'
import { useLenisScroll } from './lib/use-lenis-scroll'
import { AlertsTab } from './tabs/AlertsTab'
import { OverviewTab } from './tabs/OverviewTab'
import { ProvidersTab } from './tabs/ProvidersTab'
import { SessionsTab } from './tabs/SessionsTab'
import { SettingsTab } from './tabs/SettingsTab'
import { TeamTab } from './tabs/TeamTab'

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
      setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
      onUsageUpdated: (cb: () => void) => () => void
      onSettingsChanged: (cb: (s: AppSettings) => void) => () => void
      authCurrent: () => Promise<AuthState>
      authSignIn: () => Promise<AuthState>
      authSignOut: () => Promise<AuthState>
      onAuthStateChanged: (cb: (state: AuthState) => void) => () => void
      appQuit: () => Promise<void>
      dashboardUrl: () => Promise<string | null>
      openDashboard: () => Promise<void>
      alertsList: (filter: AlertFilter) => Promise<Alert[]>
      alertsSummary: () => Promise<AlertSummary>
      alertsAck: (id: string) => Promise<void>
      alertsResolve: (id: string) => Promise<void>
      alertsSnooze: (id: string) => Promise<void>
      alertsResolveAll: () => Promise<number>
      onAlertsUpdated: (cb: () => void) => () => void
      syncStatus: () => Promise<SyncStatus | null>
      syncDrain: () => Promise<SyncStatus | null>
      syncTeamOverview: () => Promise<TeamOverview | null>
      onSyncStatusChanged: (cb: (s: SyncStatus | null) => void) => () => void
      teamAddMember: (body: {
        userId: string
        displayName?: string
        role?: TeamMemberRole
      }) => Promise<TeamManageResult>
      teamRevokeMember: (userId: string) => Promise<TeamManageResult>
      teamSetMemberRole: (userId: string, role: TeamMemberRole) => Promise<TeamManageResult>
      teamSetPrivacyFloor: (level: PrivacyLevel) => Promise<TeamManageResult>
      providerKeyList: (providerIds: string[]) => Promise<ProviderKeyStatus[]>
      providerKeySet: (providerId: string, plaintext: string) => Promise<ProviderKeyResult>
      providerKeyDelete: (providerId: string) => Promise<ProviderKeyResult>
    }
  }
}

type TabId = 'overview' | 'providers' | 'sessions' | 'alerts' | 'team' | 'settings'
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
    id: 'alerts',
    label: 'Alerts',
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
    ),
  },
  {
    id: 'team',
    label: 'Team',
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
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

type Period = 'today' | '7d' | '1m' | '6m' | '1y'

function loadInitialTab(): TabId {
  try {
    const v = localStorage.getItem(ACTIVE_TAB_KEY)
    if (
      v === 'overview' || v === 'providers' || v === 'sessions' ||
      v === 'alerts' || v === 'team' || v === 'settings'
    ) return v
  } catch {
    /* localStorage unavailable */
  }
  return 'overview'
}
function loadInitialPeriod(): Period {
  try {
    const v = localStorage.getItem(PERIOD_KEY)
    if (v === 'today' || v === '7d' || v === '1m' || v === '6m' || v === '1y') return v
    // Migration: users persisted '30d' before the period bar was widened
    // to include 1m/6m/1y. Treat the legacy value as "1m" silently.
    if (v === '30d') return '1m'
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
  const [dashboardUrl, setDashboardUrl] = useState<string | null>(null)
  const [alertSummary, setAlertSummary] = useState<AlertSummary>({ open: 0, acked: 0, snoozed: 0, resolved: 0 })
  const [, forceTick] = useState(0)

  // Track which tabs have been mounted at least once. Inactive tabs render
  // hidden after first mount to keep their state alive cheaply.
  const [mountedTabs, setMountedTabs] = useState<Set<TabId>>(() => new Set([loadInitialTab()]))

  // Lenis-driven inertia scroll on the panel. Hook returns a ref we
  // attach to the scroll container; the hook owns the RAF loop and
  // pauses on document.hidden so a hidden tray panel costs zero CPU.
  const dropdownRef = useLenisScroll<HTMLDivElement>()

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
    void window.api.dashboardUrl().then(setDashboardUrl)
    void reload()
    return window.api.onUsageUpdated(scheduleReload)
  }, [reload, scheduleReload])

  // Alerts summary drives the tab badge — refreshed on every alerts:updated
  // broadcast (including ack/resolve/snooze/raise) and on initial mount.
  useEffect(() => {
    const fetchSummary = (): void => {
      void window.api.alertsSummary().then(setAlertSummary)
    }
    fetchSummary()
    return window.api.onAlertsUpdated(fetchSummary)
  }, [])

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
    <div className="dropdown" ref={dropdownRef}>
      <div className="aurora" aria-hidden />

      <header className="dropdown-header">
        <div className="title-block">
          <span className="title-glyph" aria-hidden>
            {/* Layered glyph: gradient diamond + lightning bolt + sparkle. */}
            <svg viewBox="0 0 24 24" width="16" height="16">
              <defs>
                <linearGradient id="glyph-grad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#63adff" />
                  <stop offset="0.55" stopColor="#a78bfa" />
                  <stop offset="1" stopColor="#ff7ac6" />
                </linearGradient>
              </defs>
              <path
                d="M13 2 L4 13 h6 l-2 9 L20 11 h-6 l2 -9 Z"
                fill="url(#glyph-grad)"
                stroke="rgba(255,255,255,0.9)"
                strokeWidth="0.6"
                strokeLinejoin="round"
              />
              <circle cx="19" cy="4.5" r="1.1" fill="#ffffff" opacity="0.95" />
            </svg>
          </span>
          <span className="title">devbar</span>
          <span className="live-pill" title={`updated ${timeAgo(agg.generatedAt)} ago`}>
            <span className="live-dot" />
            <span>live · {timeAgo(agg.generatedAt)} ago</span>
          </span>
        </div>
        <div className="header-actions">
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
          <button
            type="button"
            className="quit-btn"
            title="Quit devbar"
            aria-label="Quit"
            onClick={() => void window.api.appQuit()}
          >
            ⏻
          </button>
        </div>
      </header>

      <AuthHeader />

      <nav className="tab-bar" role="tablist">
        {TABS.map((t) => {
          // Badge count = open + acked + snoozed (everything not resolved).
          // Acked alerts still count so the badge doesn't disappear the moment
          // the user dismisses one — they should resolve it to clear it.
          const badge = t.id === 'alerts'
            ? alertSummary.open + alertSummary.acked + alertSummary.snoozed
            : 0
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={activeTab === t.id ? 'tab-tile active' : 'tab-tile'}
              onClick={() => switchTab(t.id)}
            >
              <span className="tab-tile-icon">
                {t.icon}
                {badge > 0 && <span className="tab-badge">{badge}</span>}
              </span>
              <span className="tab-tile-label">{t.label}</span>
            </button>
          )
        })}
      </nav>

      <main className="tab-pane">
        {mountedTabs.has('overview') && (
          <div hidden={activeTab !== 'overview'}>
            <OverviewTab agg={agg} period={period} onPeriodChange={setPeriod} />
          </div>
        )}
        {mountedTabs.has('providers') && (
          <div hidden={activeTab !== 'providers'}>
            <ProvidersTab agg={agg} providers={providers} dashboardUrl={dashboardUrl} settings={settings} />
          </div>
        )}
        {mountedTabs.has('sessions') && (
          <div hidden={activeTab !== 'sessions'}>
            <SessionsTab agg={agg} />
          </div>
        )}
        {mountedTabs.has('alerts') && (
          <div hidden={activeTab !== 'alerts'}>
            <AlertsTab />
          </div>
        )}
        {mountedTabs.has('team') && (
          <div hidden={activeTab !== 'team'}>
            <TeamTab settings={settings} dashboardUrl={dashboardUrl} />
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

      <PrivacyBanner />
    </div>
  )
}
