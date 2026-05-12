// Mock window.api for browser-only design preview (localhost:5174). When the
// renderer is loaded outside Electron, the preload bridge isn't injected, so
// we substitute a fixed-fixture API. Numbers are illustrative — useful only
// for visual iteration. The Electron build never reaches this file.

import { DEFAULT_SETTINGS } from '@shared/settings'
import type {
  AggregateSnapshot,
  AppSettings,
  AuthState,
  PricingInfo,
  ProviderListEntry,
  StorageInfo,
  TeamOverview,
  YieldScoreSnapshot,
} from '@shared/ipc-channels'

const usd = (n: number): bigint => BigInt(Math.round(n * 1_000_000))

const fakeSnapshot: AggregateSnapshot = {
  generatedAt: Date.now(),
  today: {
    costMicroUsd: usd(4.27),
    inputTokens: 38_400,
    outputTokens: 45_700,
    cacheReadTokens: 12_000,
    cacheCreationTokens: 4_500,
    reasoningTokens: 8_100,
    eventCount: 12,
  },
  last7d: {
    costMicroUsd: usd(28.94),
    inputTokens: 240_000,
    outputTokens: 312_000,
    cacheReadTokens: 64_000,
    cacheCreationTokens: 22_000,
    reasoningTokens: 41_000,
    eventCount: 87,
  },
  last30d: {
    costMicroUsd: usd(112.6),
    inputTokens: 940_000,
    outputTokens: 1_180_000,
    cacheReadTokens: 230_000,
    cacheCreationTokens: 78_000,
    reasoningTokens: 151_000,
    eventCount: 312,
  },
  last6m: {
    costMicroUsd: usd(612.4),
    inputTokens: 5_240_000,
    outputTokens: 6_480_000,
    cacheReadTokens: 1_240_000,
    cacheCreationTokens: 410_000,
    reasoningTokens: 820_000,
    eventCount: 1_710,
  },
  last1y: {
    costMicroUsd: usd(1_184.7),
    inputTokens: 10_120_000,
    outputTokens: 12_540_000,
    cacheReadTokens: 2_410_000,
    cacheCreationTokens: 790_000,
    reasoningTokens: 1_580_000,
    eventCount: 3_312,
  },
  byProviderToday: [
    { provider: 'anthropic', costMicroUsd: usd(2.4), eventCount: 8 },
    { provider: 'openai', costMicroUsd: usd(1.2), eventCount: 3 },
    { provider: 'cursor', costMicroUsd: usd(0.92), eventCount: 4 },
    { provider: 'google', costMicroUsd: usd(0.67), eventCount: 1 },
  ],
  byProvider30d: [
    { provider: 'anthropic', costMicroUsd: usd(72.4), eventCount: 198 },
    { provider: 'openai', costMicroUsd: usd(28.7), eventCount: 84 },
    { provider: 'cursor', costMicroUsd: usd(19.2), eventCount: 56 },
    { provider: 'google', costMicroUsd: usd(8.4), eventCount: 22 },
    { provider: 'deepseek', costMicroUsd: usd(3.1), eventCount: 8 },
  ],
  byProvider6m: [
    { provider: 'anthropic', costMicroUsd: usd(394.2), eventCount: 1_086 },
    { provider: 'openai', costMicroUsd: usd(155.6), eventCount: 462 },
    { provider: 'cursor', costMicroUsd: usd(104.1), eventCount: 312 },
    { provider: 'google', costMicroUsd: usd(45.2), eventCount: 121 },
    { provider: 'deepseek', costMicroUsd: usd(17.4), eventCount: 41 },
  ],
  byProvider1y: [
    { provider: 'anthropic', costMicroUsd: usd(762.6), eventCount: 2_098 },
    { provider: 'openai', costMicroUsd: usd(301.8), eventCount: 893 },
    { provider: 'cursor', costMicroUsd: usd(201.7), eventCount: 608 },
    { provider: 'google', costMicroUsd: usd(87.5), eventCount: 234 },
    { provider: 'deepseek', costMicroUsd: usd(32.8), eventCount: 87 },
  ],
  topModelsToday: [
    { provider: 'anthropic', model: 'claude-opus-4-7', costMicroUsd: usd(2.1), eventCount: 6 },
    { provider: 'openai', model: 'gpt-5-codex', costMicroUsd: usd(1.2), eventCount: 3 },
    { provider: 'cursor', model: 'claude-3-5-sonnet (via cursor)', costMicroUsd: usd(0.92), eventCount: 4 },
    { provider: 'anthropic', model: 'claude-sonnet-4-6', costMicroUsd: usd(0.3), eventCount: 2 },
    { provider: 'google', model: 'gemini-2.5-pro', costMicroUsd: usd(0.67), eventCount: 1 },
  ],
  topProjectsToday: [
    { project: 'llm-cost-monitor', costMicroUsd: usd(2.6), eventCount: 7 },
    { project: '~/work/api', costMicroUsd: usd(1.4), eventCount: 4 },
    { project: '(none)', costMicroUsd: usd(0.27), eventCount: 1 },
  ],
  forecast: {
    monthStartMs: Date.now() - 7 * 24 * 3600_000,
    daysElapsed: 7,
    daysInMonth: 31,
    spentMicroUsd: usd(28.94),
    estimateMicroUsd: usd(128.16),
    confidenceBandMicroUsd: usd(11.4),
  },
  forecastByProvider: {
    anthropic: {
      monthStartMs: Date.now() - 7 * 24 * 3600_000,
      daysElapsed: 7, daysInMonth: 31,
      spentMicroUsd: usd(18.4), estimateMicroUsd: usd(81.5), confidenceBandMicroUsd: usd(7.2),
    },
    openai: {
      monthStartMs: Date.now() - 7 * 24 * 3600_000,
      daysElapsed: 7, daysInMonth: 31,
      spentMicroUsd: usd(8.2), estimateMicroUsd: usd(36.3), confidenceBandMicroUsd: usd(3.1),
    },
    google: {
      monthStartMs: Date.now() - 7 * 24 * 3600_000,
      daysElapsed: 7, daysInMonth: 31,
      spentMicroUsd: usd(2.34), estimateMicroUsd: usd(10.36), confidenceBandMicroUsd: usd(1.1),
    },
    cursor: {
      monthStartMs: Date.now() - 7 * 24 * 3600_000,
      daysElapsed: 7, daysInMonth: 31,
      spentMicroUsd: usd(5.7), estimateMicroUsd: usd(25.2), confidenceBandMicroUsd: usd(2.4),
    },
  },
  // 365 oldest-first entries — renderer slices the last N based on the
  // selected period. Deterministic pseudo-random walk so the fake demo
  // doesn't redraw flat zeros for older buckets but stays stable across
  // reloads of the same fixture.
  dailyCostMicroUsd: ((): bigint[] => {
    const out: bigint[] = []
    for (let i = 0; i < 365; i += 1) {
      // sine envelope + small high-frequency wobble, $0-$8 range
      const base = 4 + 3 * Math.sin((i / 11) * Math.PI)
      const wobble = ((i * 9301 + 49297) % 233280) / 233280 // [0,1)
      out.push(usd(Math.max(0, base + (wobble - 0.5) * 2.4)))
    }
    return out
  })(),
  providerLastSeen: {
    anthropic: Date.now() - 2 * 60_000,
    openai: Date.now() - 14 * 60_000,
    cursor: Date.now() - 8 * 60_000,
    google: Date.now() - 3 * 3600_000,
  },
  recentSessions: [
    { sessionId: 'a1b2c3d4-e5f6-7890-abcd-1234567890ab', provider: 'anthropic', project: 'llm-cost-monitor', costMicroUsd: usd(1.42), eventCount: 6, firstAt: Date.now() - 25 * 60_000, lastAt: Date.now() - 2 * 60_000 },
    { sessionId: '0xfeedface-0000-1111-2222-deadbeefcafe', provider: 'openai', project: '~/work/api', costMicroUsd: usd(0.94), eventCount: 3, firstAt: Date.now() - 2 * 3600_000, lastAt: Date.now() - 14 * 60_000 },
    { sessionId: 'cur-3a91bb', provider: 'cursor', project: 'llm-cost-monitor', costMicroUsd: usd(0.62), eventCount: 4, firstAt: Date.now() - 35 * 60_000, lastAt: Date.now() - 8 * 60_000 },
    { sessionId: 'gem-72b9af', provider: 'google', project: '(none)', costMicroUsd: usd(0.27), eventCount: 1, firstAt: Date.now() - 4 * 3600_000, lastAt: Date.now() - 3 * 3600_000 },
    { sessionId: 'a91xx-claude-replay', provider: 'anthropic', project: 'docs/build-log', costMicroUsd: usd(0.18), eventCount: 2, firstAt: Date.now() - 25 * 3600_000, lastAt: Date.now() - 22 * 3600_000 },
  ],
}

const fakeProviders: ProviderListEntry[] = [
  { id: 'anthropic', name: 'Claude Code', isEnabled: true, isAvailable: true, cliCommand: 'claude', dashboardUrl: null,
    plan: { authMode: 'subscription', planName: 'Max', source: 'macOS Keychain', detail: 'demo@example.com' } },
  { id: 'openai', name: 'Codex CLI', isEnabled: true, isAvailable: true, cliCommand: 'codex', dashboardUrl: null,
    plan: { authMode: 'subscription', planName: 'Plus', source: '~/.codex/auth.json', detail: 'demo@example.com' } },
  { id: 'google', name: 'Gemini CLI', isEnabled: true, isAvailable: true, cliCommand: 'gemini', dashboardUrl: null,
    plan: { authMode: 'oauth', planName: 'Google Account', source: '~/.gemini/oauth_creds.json', detail: 'demo@example.com' } },
  { id: 'cursor', name: 'Cursor', isEnabled: true, isAvailable: true, cliCommand: 'cursor-agent', dashboardUrl: 'https://cursor.com/dashboard',
    plan: { authMode: 'subscription', planName: 'Pro', source: '~/.cursor/auth.json', detail: 'demo@example.com' } },
  { id: 'deepseek', name: 'DeepSeek', isEnabled: false, isAvailable: false, cliCommand: null, dashboardUrl: null,
    plan: { authMode: 'apiKey', planName: 'API key', source: 'DEEPSEEK_API_KEY env', detail: null } },
  { id: 'moonshotai', name: 'Kimi', isEnabled: false, isAvailable: false, cliCommand: null, dashboardUrl: null,
    plan: { authMode: 'none', planName: null, source: null, detail: null } },
]

const fakePricing: PricingInfo = { snapshotVersion: '246413ab150e (preview)', modelCount: 2250 }
const fakeStorage: StorageInfo = { eventCount: 1018 }
const fakeSettings: AppSettings = DEFAULT_SETTINGS

// Alerts demo data — matches the patterns the AlertSampler raises in main.
import type { Alert } from '@shared/alerts'
const seedAlerts: Alert[] = [
  {
    id: 'a1', type: 'system.cpu', severity: 'warning',
    title: 'Device CPU usage is elevated',
    body: 'helper sampled CPU usage at 100%.',
    raisedAt: Date.now() - 6 * 60_000,
    status: 'open', ackedAt: null, resolvedAt: null, snoozedUntil: null,
    signature: 'system.cpu', metadata: { cpuPct: 100 },
  },
  {
    id: 'a2', type: 'cost.daily', severity: 'warning',
    title: 'Daily LLM spend threshold reached',
    body: "today's spend is $12.40, above your $10 threshold.",
    raisedAt: Date.now() - 24 * 3600_000,
    status: 'open', ackedAt: null, resolvedAt: null, snoozedUntil: null,
    signature: 'cost.daily.demo', metadata: { todayUsd: 12.4 },
  },
  {
    id: 'a3', type: 'system.memory', severity: 'critical',
    title: 'Device memory is running low',
    body: '420 MB free of 16.0 GB (97% used).',
    raisedAt: Date.now() - 3 * 24 * 3600_000,
    status: 'open', ackedAt: null, resolvedAt: null, snoozedUntil: null,
    signature: 'system.memory', metadata: { memPct: 97 },
  },
]

// Try the real loopback API on every read, fall back to the local
// fixture when it isn't reachable. Tags in the wire format:
//   - bigint → "<digits>n" string (reversed here by jsonReviver)
// See src/main/web-api/web-api-server.ts for the serialiser side.
const WEB_API_BASE =
  (typeof window !== 'undefined'
    ? (window as unknown as { __LCM_WEB_API_BASE__?: string }).__LCM_WEB_API_BASE__
    : undefined) ?? 'http://127.0.0.1:4018'

function jsonReviver(_k: string, v: unknown): unknown {
  if (typeof v === 'string' && /^-?\d+n$/.test(v)) return BigInt(v.slice(0, -1))
  return v
}

async function getReal<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${WEB_API_BASE}${path}`)
    if (!res.ok) return null
    const text = await res.text()
    return JSON.parse(text, jsonReviver) as T
  } catch {
    return null
  }
}

export function installBrowserStub(): void {
  if (typeof window === 'undefined' || (window as unknown as { api?: unknown }).api) return
  // Browser-mode alerts state — mutable so the demo UI is interactive
  // (ack / resolve / snooze actually update the visible list).
  let alerts: Alert[] = [...seedAlerts]
  const subs = new Set<() => void>()
  const broadcast = (): void => { for (const s of subs) s() }

  let cachedSettings: AppSettings = fakeSettings
  ;(window as unknown as { api: unknown }).api = {
    ping: async () => 'pong (browser-stub)',
    pricingInfo: async () => (await getReal<PricingInfo>('/v1/pricing')) ?? fakePricing,
    storageInfo: async () => (await getReal<StorageInfo>('/v1/storage')) ?? fakeStorage,
    aggregates: async () => (await getReal<AggregateSnapshot>('/v1/aggregates')) ?? fakeSnapshot,
    providersList: async () => (await getReal<ProviderListEntry[]>('/v1/providers')) ?? fakeProviders,
    providersRefresh: async () => fakeProviders.map((p) => ({ provider: p.id, error: null })),
    settings: async () => (await getReal<AppSettings>('/v1/settings')) ?? cachedSettings,
    setSettings: async (patch: Partial<AppSettings>) => {
      cachedSettings = {
        ...cachedSettings,
        ...patch,
        teamSync: { ...cachedSettings.teamSync, ...(patch.teamSync ?? {}) },
        // Match SettingsStore.set's shallow-per-provider merge so the
        // browser preview can demo the provider catalog form without
        // wiping other providers' creds.
        providerCredentials: {
          ...cachedSettings.providerCredentials,
          ...(patch.providerCredentials ?? {}),
        },
        planOverrides: {
          ...cachedSettings.planOverrides,
          ...(patch.planOverrides ?? {}),
        },
      }
      return cachedSettings
    },
    onUsageUpdated: () => () => {},
    onSettingsChanged: () => () => {},

    // Auth — pulls real auth state from the loopback API when
    // available so the browser tab shows the same user that's
    // signed in via the tray (avatar, email, plan chip etc.).
    // Sign-in / sign-out still happen in the tray only.
    authCurrent: async () => (await getReal<AuthState>('/v1/auth')) ?? { kind: 'signed-out' },
    authSignIn: async () => ({ kind: 'signed-out' }),
    authSignOut: async () => ({ kind: 'signed-out' }),
    onAuthStateChanged: () => () => {},
    appQuit: async () => {},
    dashboardUrl: async () => null,
    openDashboard: async () => {},

    // Alerts — reads pull from the real API when reachable, else fall
    // back to the interactive in-memory demo list. Mutations stay
    // local to the browser tab (the loopback API is read-only).
    alertsList: async (filter: 'open' | 'resolved' | 'all') => {
      const real = await getReal<Alert[]>(`/v1/alerts?filter=${filter}`)
      if (real !== null) return real
      if (filter === 'all') return alerts
      if (filter === 'resolved') return alerts.filter((a) => a.status === 'resolved')
      return alerts.filter((a) => a.status !== 'resolved')
    },
    alertsSummary: async () => {
      const real = await getReal<{
        open: number; acked: number; snoozed: number; resolved: number
      }>('/v1/alerts/summary')
      if (real !== null) return real
      const out = { open: 0, acked: 0, snoozed: 0, resolved: 0 }
      for (const a of alerts) {
        if (a.status in out) out[a.status as keyof typeof out]++
      }
      return out
    },
    alertsAck: async (id: string) => {
      alerts = alerts.map((a) => a.id === id ? { ...a, status: 'acked', ackedAt: Date.now() } : a)
      broadcast()
    },
    alertsResolve: async (id: string) => {
      alerts = alerts.map((a) => a.id === id ? { ...a, status: 'resolved', resolvedAt: Date.now() } : a)
      broadcast()
    },
    alertsSnooze: async (id: string) => {
      alerts = alerts.map((a) => a.id === id
        ? { ...a, status: 'snoozed', snoozedUntil: Date.now() + 60 * 60_000 }
        : a)
      broadcast()
    },
    alertsResolveAll: async () => {
      const n = alerts.filter((a) => a.status !== 'resolved').length
      alerts = alerts.map((a) => a.status === 'resolved' ? a
        : { ...a, status: 'resolved', resolvedAt: Date.now() })
      broadcast()
      return n
    },
    onAlertsUpdated: (cb: () => void) => {
      subs.add(cb)
      return () => { subs.delete(cb) }
    },

    // Team sync — browser-mode preview reports unconfigured.
    syncStatus: async () => ({
      configured: false,
      enabled: false,
      lastSyncAt: null,
      pendingCount: 0,
      lastError: null,
      nodeId: 'demo-node-id',
    }),
    syncDrain: async () => ({
      configured: false,
      enabled: false,
      lastSyncAt: Date.now(),
      pendingCount: 0,
      lastError: null,
      nodeId: 'demo-node-id',
    }),
    syncTeamOverview: async () => getReal<TeamOverview | null>('/v1/team-overview'),
    onSyncStatusChanged: () => () => {},
    teamAddMember: async () => ({ ok: false, status: 0, error: 'browser_stub' }),
    teamRevokeMember: async () => ({ ok: false, status: 0, error: 'browser_stub' }),
    teamSetMemberRole: async () => ({ ok: false, status: 0, error: 'browser_stub' }),
    teamSetPrivacyFloor: async () => ({ ok: false, status: 0, error: 'browser_stub' }),
    yieldScore: async (period: '7d' | '30d' | '90d') =>
      (await getReal<YieldScoreSnapshot>(`/v1/yield-score?period=${period}`)) ?? ({
      period,
      windowStartMs: 0,
      generatedAt: Date.now(),
      durationMs: 0,
      totalCommits: 0,
      totalMerges: 0,
      costMicroUsd: '0',
      microPerCommit: null,
      repos: [],
      enabled: false,
    }),
  }
}
