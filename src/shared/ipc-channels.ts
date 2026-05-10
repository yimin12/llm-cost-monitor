import type { AggregateSnapshot } from './aggregates'
import type { Alert, AlertFilter, AlertSummary } from './alerts'
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
  // Admin-only management calls. The handlers refuse unless the
  // server-side TeamOverview reports the requesting user as an admin.
  TEAM_ADD_MEMBER: 'team:add-member',
  TEAM_REVOKE_MEMBER: 'team:revoke-member',
  TEAM_SET_MEMBER_ROLE: 'team:set-member-role',
  TEAM_SET_PRIVACY_FLOOR: 'team:set-privacy-floor',
  // Provider catalog API key management. Keys are encrypted at rest
  // via Electron safeStorage; the renderer never sees plaintext.
  PROVIDER_KEY_LIST: 'provider-key:list',
  PROVIDER_KEY_SET: 'provider-key:set',
  PROVIDER_KEY_DELETE: 'provider-key:delete',
  // Returns the dev-server URL that the same renderer is served at, or null
  // in production builds where the renderer is loaded via file://. The
  // renderer uses this to surface a "Open in browser" link from the tray.
  DASHBOARD_URL: 'dashboard:url',
  DASHBOARD_OPEN: 'dashboard:open',
  ALERTS_LIST: 'alerts:list',
  ALERTS_SUMMARY: 'alerts:summary',
  ALERTS_ACK: 'alerts:ack',
  ALERTS_RESOLVE: 'alerts:resolve',
  ALERTS_SNOOZE: 'alerts:snooze',
  ALERTS_RESOLVE_ALL: 'alerts:resolveAll',
} as const

export const EVENT = {
  USAGE_UPDATED: 'usage:updated',
  AUTH_STATE_CHANGED: 'auth:state-changed',
  ALERTS_UPDATED: 'alerts:updated',
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

export type { AggregateSnapshot, Alert, AlertFilter, AlertSummary, AppSettings, AuthState, PlanInfo }
export type { SyncStatus, TeamSyncSettings, PrivacyLevel } from './sync'

// Server-side aggregates surfaced to the renderer's Team tab.
// Computed by the backend; the desktop is purely a viewer.

export type TeamMemberRole = 'admin' | 'member'
export type TeamMemberStatus = 'active' | 'revoked'

export interface TeamMemberUsage {
  userId: string
  displayName: string | null
  role: TeamMemberRole
  status: TeamMemberStatus
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

// Tagged-union result for the admin management IPCs. The renderer uses
// the `ok` boolean to render either a success toast or an error toast.
export type TeamManageResult =
  | { ok: true }
  | { ok: false; status: number; error: string; message?: string }

// Slim view of the provider key store for the renderer. Plaintext is
// NEVER sent — the renderer only learns whether a key is configured
// and when it was added.
export interface ProviderKeyStatus {
  providerId: string
  configured: boolean
  encryptionAvailable: boolean
  addedAt: number | null
}

export type ProviderKeyResult =
  | { ok: true; status: ProviderKeyStatus }
  | { ok: false; error: string; message?: string }

export interface TeamOverview {
  teamId: string
  teamName: string
  generatedAt: number
  // Role of the requesting user. null when the requester isn't (yet) a
  // member — render the empty/onboard state, not the management UI.
  currentUserRole: TeamMemberRole | null
  // Mirrors PrivacyLevel; admins can change it via the management UI.
  privacyFloor: 'full' | 'redacted' | 'aggregateOnly'
  totalCostMicroUsd: string
  todayCostMicroUsd: string
  totalEventCount: number
  activeMembers: number
  activeNodes: number
  members: TeamMemberUsage[]
  topProjects: TeamProjectUsage[]
  byProvider: TeamProviderUsage[]
  nodes: TeamNodeStatus[]
}
