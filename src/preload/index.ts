import { contextBridge, ipcRenderer } from 'electron'

import {
  EVENT,
  IPC,
  type AggregateSnapshot,
  type AppSettings,
  type AuthState,
  type PricingInfo,
  type ProviderListEntry,
  type ProviderRefreshResult,
  type StorageInfo,
  type SyncStatus,
  type TeamOverview,
} from '@shared/ipc-channels'

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

  syncStatus: (): Promise<SyncStatus | null> =>
    ipcRenderer.invoke(IPC.SYNC_STATUS) as Promise<SyncStatus | null>,
  syncDrain: (): Promise<SyncStatus | null> =>
    ipcRenderer.invoke(IPC.SYNC_DRAIN) as Promise<SyncStatus | null>,
  syncTeamOverview: (): Promise<TeamOverview | null> =>
    ipcRenderer.invoke(IPC.SYNC_TEAM_OVERVIEW) as Promise<TeamOverview | null>,
  onSyncStatusChanged: (cb: (s: SyncStatus | null) => void): (() => void) => {
    const listener = (_e: unknown, s: SyncStatus | null): void => cb(s)
    ipcRenderer.on(EVENT.SYNC_STATUS_CHANGED, listener)
    return () => ipcRenderer.removeListener(EVENT.SYNC_STATUS_CHANGED, listener)
  },
})
