import { contextBridge, ipcRenderer } from 'electron'

import {
  EVENT,
  IPC,
  type AggregateSnapshot,
  type Alert,
  type AlertFilter,
  type AlertSummary,
  type AppSettings,
  type AuthState,
  type PricingInfo,
  type ProviderListEntry,
  type ProviderRefreshResult,
  type StorageInfo,
  type SyncStatus,
  type TeamManageResult,
  type TeamMemberRole,
  type TeamOverview,
} from '@shared/ipc-channels'
import type { PrivacyLevel } from '@shared/sync'

contextBridge.exposeInMainWorld('api', {
  ping: (): Promise<string> => ipcRenderer.invoke(IPC.PING) as Promise<string>,
  pricingInfo: (): Promise<PricingInfo> => ipcRenderer.invoke(IPC.PRICING_INFO) as Promise<PricingInfo>,
  storageInfo: (): Promise<StorageInfo> => ipcRenderer.invoke(IPC.STORAGE_INFO) as Promise<StorageInfo>,
  aggregates: (): Promise<AggregateSnapshot> =>
    ipcRenderer.invoke(IPC.AGGREGATES) as Promise<AggregateSnapshot>,
  providersList: (): Promise<ProviderListEntry[]> =>
    ipcRenderer.invoke(IPC.PROVIDERS_LIST) as Promise<ProviderListEntry[]>,
  providersRefresh: (): Promise<ProviderRefreshResult[]> =>
    ipcRenderer.invoke(IPC.PROVIDERS_REFRESH) as Promise<ProviderRefreshResult[]>,
  settings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET) as Promise<AppSettings>,
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.SETTINGS_SET, patch) as Promise<AppSettings>,
  onUsageUpdated: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(EVENT.USAGE_UPDATED, listener)
    return () => ipcRenderer.removeListener(EVENT.USAGE_UPDATED, listener)
  },
  onSettingsChanged: (cb: (s: AppSettings) => void): (() => void) => {
    const listener = (_e: unknown, s: AppSettings): void => cb(s)
    ipcRenderer.on(EVENT.SETTINGS_CHANGED, listener)
    return () => ipcRenderer.removeListener(EVENT.SETTINGS_CHANGED, listener)
  },

  authCurrent: (): Promise<AuthState> => ipcRenderer.invoke(IPC.AUTH_CURRENT) as Promise<AuthState>,
  authSignIn: (): Promise<AuthState> => ipcRenderer.invoke(IPC.AUTH_SIGNIN) as Promise<AuthState>,
  authSignOut: (): Promise<AuthState> => ipcRenderer.invoke(IPC.AUTH_SIGNOUT) as Promise<AuthState>,
  appQuit: (): Promise<void> => ipcRenderer.invoke(IPC.APP_QUIT) as Promise<void>,
  dashboardUrl: (): Promise<string | null> => ipcRenderer.invoke(IPC.DASHBOARD_URL) as Promise<string | null>,
  openDashboard: (): Promise<void> => ipcRenderer.invoke(IPC.DASHBOARD_OPEN) as Promise<void>,
  onAuthStateChanged: (cb: (state: AuthState) => void): (() => void) => {
    const listener = (_event: unknown, state: AuthState): void => cb(state)
    ipcRenderer.on(EVENT.AUTH_STATE_CHANGED, listener)
    return () => ipcRenderer.removeListener(EVENT.AUTH_STATE_CHANGED, listener)
  },

  alertsList: (filter: AlertFilter): Promise<Alert[]> =>
    ipcRenderer.invoke(IPC.ALERTS_LIST, filter) as Promise<Alert[]>,
  alertsSummary: (): Promise<AlertSummary> =>
    ipcRenderer.invoke(IPC.ALERTS_SUMMARY) as Promise<AlertSummary>,
  alertsAck: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.ALERTS_ACK, id) as Promise<void>,
  alertsResolve: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.ALERTS_RESOLVE, id) as Promise<void>,
  alertsSnooze: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.ALERTS_SNOOZE, id) as Promise<void>,
  alertsResolveAll: (): Promise<number> =>
    ipcRenderer.invoke(IPC.ALERTS_RESOLVE_ALL) as Promise<number>,
  onAlertsUpdated: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(EVENT.ALERTS_UPDATED, listener)
    return () => ipcRenderer.removeListener(EVENT.ALERTS_UPDATED, listener)
  },

  syncStatus: (): Promise<SyncStatus | null> =>
    ipcRenderer.invoke(IPC.SYNC_STATUS) as Promise<SyncStatus | null>,
  syncDrain: (): Promise<SyncStatus | null> =>
    ipcRenderer.invoke(IPC.SYNC_DRAIN) as Promise<SyncStatus | null>,
  syncTeamOverview: (): Promise<TeamOverview | null> =>
    ipcRenderer.invoke(IPC.SYNC_TEAM_OVERVIEW) as Promise<TeamOverview | null>,

  // Admin-only management. Each returns a TeamManageResult; the renderer
  // toasts the error message when ok is false.
  teamAddMember: (body: {
    userId: string
    displayName?: string
    role?: TeamMemberRole
  }): Promise<TeamManageResult> =>
    ipcRenderer.invoke(IPC.TEAM_ADD_MEMBER, body) as Promise<TeamManageResult>,
  teamRevokeMember: (userId: string): Promise<TeamManageResult> =>
    ipcRenderer.invoke(IPC.TEAM_REVOKE_MEMBER, userId) as Promise<TeamManageResult>,
  teamSetMemberRole: (
    userId: string,
    role: TeamMemberRole,
  ): Promise<TeamManageResult> =>
    ipcRenderer.invoke(IPC.TEAM_SET_MEMBER_ROLE, userId, role) as Promise<TeamManageResult>,
  teamSetPrivacyFloor: (level: PrivacyLevel): Promise<TeamManageResult> =>
    ipcRenderer.invoke(IPC.TEAM_SET_PRIVACY_FLOOR, level) as Promise<TeamManageResult>,

  onSyncStatusChanged: (cb: (s: SyncStatus | null) => void): (() => void) => {
    const listener = (_e: unknown, s: SyncStatus | null): void => cb(s)
    ipcRenderer.on(EVENT.SYNC_STATUS_CHANGED, listener)
    return () => ipcRenderer.removeListener(EVENT.SYNC_STATUS_CHANGED, listener)
  },
})
