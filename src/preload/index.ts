import { contextBridge, ipcRenderer } from 'electron'

import {
  EVENT,
  IPC,
  type AggregateSnapshot,
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
  onUsageUpdated: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(EVENT.USAGE_UPDATED, listener)
    return () => ipcRenderer.removeListener(EVENT.USAGE_UPDATED, listener)
  },
})
