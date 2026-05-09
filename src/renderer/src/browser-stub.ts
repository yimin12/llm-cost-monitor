// Mock window.api for browser-only design preview (localhost:5174). When the
// renderer is loaded outside Electron, the preload bridge isn't injected, so
// we substitute a fixed-fixture API. Numbers are illustrative — useful only
// for visual iteration. The Electron build never reaches this file.

import { DEFAULT_SETTINGS } from '@shared/settings'
import type {
  AggregateSnapshot,
  AppSettings,
  PricingInfo,
  ProviderListEntry,
  StorageInfo,
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
  byProviderToday: [
    { provider: 'anthropic', costMicroUsd: usd(2.4), eventCount: 8 },
    { provider: 'openai', costMicroUsd: usd(1.2), eventCount: 3 },
    { provider: 'google', costMicroUsd: usd(0.67), eventCount: 1 },
  ],
  byProvider30d: [
    { provider: 'anthropic', costMicroUsd: usd(72.4), eventCount: 198 },
    { provider: 'openai', costMicroUsd: usd(28.7), eventCount: 84 },
    { provider: 'google', costMicroUsd: usd(8.4), eventCount: 22 },
    { provider: 'deepseek', costMicroUsd: usd(3.1), eventCount: 8 },
  ],
  topModelsToday: [
    { provider: 'anthropic', model: 'claude-opus-4-7', costMicroUsd: usd(2.1), eventCount: 6 },
    { provider: 'openai', model: 'gpt-5-codex', costMicroUsd: usd(1.2), eventCount: 3 },
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
  },
  dailyCostMicroUsd: [
    usd(0.8), usd(2.1), usd(3.4), usd(1.2), usd(0.5), usd(2.8), usd(4.7),
    usd(3.2), usd(5.1), usd(2.6), usd(1.9), usd(3.7), usd(6.2), usd(4.27),
  ],
  providerLastSeen: {
    anthropic: Date.now() - 2 * 60_000,
    openai: Date.now() - 14 * 60_000,
    google: Date.now() - 3 * 3600_000,
  },
  recentSessions: [
    { sessionId: 'a1b2c3d4-e5f6-7890-abcd-1234567890ab', provider: 'anthropic', project: 'llm-cost-monitor', costMicroUsd: usd(1.42), eventCount: 6, firstAt: Date.now() - 25 * 60_000, lastAt: Date.now() - 2 * 60_000 },
    { sessionId: '0xfeedface-0000-1111-2222-deadbeefcafe', provider: 'openai', project: '~/work/api', costMicroUsd: usd(0.94), eventCount: 3, firstAt: Date.now() - 2 * 3600_000, lastAt: Date.now() - 14 * 60_000 },
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
    plan: { authMode: 'subscription', planName: 'Google Account', source: '~/.gemini/oauth_creds.json', detail: 'demo@example.com' } },
  { id: 'deepseek', name: 'DeepSeek', isEnabled: false, isAvailable: false, cliCommand: null, dashboardUrl: null,
    plan: { authMode: 'apiKey', planName: 'API key', source: 'DEEPSEEK_API_KEY env', detail: null } },
  { id: 'moonshotai', name: 'Kimi', isEnabled: false, isAvailable: false, cliCommand: null, dashboardUrl: null,
    plan: { authMode: 'none', planName: null, source: null, detail: null } },
]

const fakePricing: PricingInfo = { snapshotVersion: '246413ab150e (preview)', modelCount: 2250 }
const fakeStorage: StorageInfo = { eventCount: 1018 }
const fakeSettings: AppSettings = DEFAULT_SETTINGS

export function installBrowserStub(): void {
  if (typeof window === 'undefined' || (window as unknown as { api?: unknown }).api) return
  ;(window as unknown as { api: unknown }).api = {
    ping: async () => 'pong (browser-stub)',
    pricingInfo: async () => fakePricing,
    storageInfo: async () => fakeStorage,
    aggregates: async () => fakeSnapshot,
    providersList: async () => fakeProviders,
    providersRefresh: async () => fakeProviders.map((p) => ({ provider: p.id, error: null })),
    settings: async () => fakeSettings,
    onUsageUpdated: () => () => {},
  }
}
