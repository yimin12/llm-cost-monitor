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
  onAuthStateChanged: (cb: (state: AuthState) => void): (() => void) => {
    const listener = (_event: unknown, state: AuthState): void => cb(state)
    ipcRenderer.on(EVENT.AUTH_STATE_CHANGED, listener)
    return () => ipcRenderer.removeListener(EVENT.AUTH_STATE_CHANGED, listener)
  },
})
