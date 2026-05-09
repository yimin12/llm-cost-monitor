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
  onUsageUpdated: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(EVENT.USAGE_UPDATED, listener)
    return () => ipcRenderer.removeListener(EVENT.USAGE_UPDATED, listener)
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
})
