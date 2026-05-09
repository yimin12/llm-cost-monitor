import type { AggregateSnapshot } from './aggregates'
import type { AuthState } from './auth'
import type { PlanInfo } from './plan-info'
import type { AppSettings } from './settings'

export const IPC = {
  PING: 'ping',
  PRICING_INFO: 'pricing:info',
  STORAGE_INFO: 'storage:info',
  AGGREGATES: 'aggregates:snapshot',
  PROVIDERS_LIST: 'providers:list',
  PROVIDERS_REFRESH: 'providers:refresh',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  AUTH_CURRENT: 'auth:current',
  AUTH_SIGNIN: 'auth:signin',
  AUTH_SIGNOUT: 'auth:signout',
  APP_QUIT: 'app:quit',
  // Cross-node sync controls. See plan.md Phase 5.
  SYNC_STATUS: 'sync:status',
  SYNC_DRAIN: 'sync:drain',
  SYNC_TEAM_OVERVIEW: 'sync:team-overview',
  // Returns the dev-server URL that the same renderer is served at, or null
  // in production builds where the renderer is loaded via file://. The
  // renderer uses this to surface a "Open in browser" link from the tray.
  DASHBOARD_URL: 'dashboard:url',
  DASHBOARD_OPEN: 'dashboard:open',
} as const

export const EVENT = {
  USAGE_UPDATED: 'usage:updated',
  AUTH_STATE_CHANGED: 'auth:state-changed',
  SETTINGS_CHANGED: 'settings:changed',
  SYNC_STATUS_CHANGED: 'sync:status-changed',
} as const

export interface PricingInfo {
  snapshotVersion: string
  modelCount: number
}

export interface StorageInfo {
  eventCount: number
}

export interface ProviderListEntry {
  id: string
  name: string
  isEnabled: boolean
  isAvailable: boolean
  cliCommand: string | null
  dashboardUrl: string | null
  plan: PlanInfo
}

export interface ProviderRefreshResult {
  provider: string
  eventsCount: number
  error: string | null
}

export type { AggregateSnapshot, AppSettings, AuthState, PlanInfo }
export type { SyncStatus, TeamSyncSettings, PrivacyLevel } from './sync'

// Server-side aggregates surfaced to the renderer's Team tab.
// Computed by the backend; the desktop is purely a viewer.
export interface TeamMemberUsage {
  userId: string
  displayName: string | null
  costMicroUsd: string // bigint as string
  eventCount: number
  inputTokens: number
  outputTokens: number
  lastSeenAt: number | null
}

export interface TeamProjectUsage {
  // Either the raw project name (full mode) or the per-team hash (redacted).
  projectKey: string
  redacted: boolean
  costMicroUsd: string
  eventCount: number
}

export interface TeamProviderUsage {
  provider: string
  model: string
  costMicroUsd: string
  eventCount: number
}

export interface TeamNodeStatus {
  nodeId: string
  userId: string
  displayName: string | null
  platform: string | null
  appVersion: string | null
  lastSeenAt: number | null
}

export interface TeamOverview {
  teamId: string
  generatedAt: number
  totalCostMicroUsd: string
  totalEventCount: number
  members: TeamMemberUsage[]
  topProjects: TeamProjectUsage[]
  byProvider: TeamProviderUsage[]
  nodes: TeamNodeStatus[]
}
