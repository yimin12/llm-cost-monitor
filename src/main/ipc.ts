import { BrowserWindow, ipcMain } from 'electron'

import { EVENT, IPC, type AggregateSnapshot, type ProviderListEntry, type ProviderRefreshResult } from '@shared/ipc-channels'

import type { Aggregator } from './aggregation/aggregator'
import type { PricingTable } from './pricing/pricing-table'
import type { ProviderRegistry } from './providers/registry'
import type { EventRepository } from './storage/event-repository'

export interface IpcDeps {
  pricing: PricingTable
  events: EventRepository
  aggregator: Aggregator
  providers: ProviderRegistry
}

export function registerIpcHandlers(deps: IpcDeps): void {
  ipcMain.handle(IPC.PING, () => 'pong')
  ipcMain.handle(IPC.PRICING_INFO, () => ({
    snapshotVersion: deps.pricing.snapshotVersion,
    modelCount: deps.pricing.modelCount,
  }))
  ipcMain.handle(IPC.STORAGE_INFO, () => ({
    eventCount: deps.events.count(),
  }))
  ipcMain.handle(IPC.AGGREGATES, (): AggregateSnapshot => deps.aggregator.snapshot())
  ipcMain.handle(IPC.PROVIDERS_LIST, async (): Promise<ProviderListEntry[]> => {
    return deps.providers.describe()
  })
  ipcMain.handle(IPC.PROVIDERS_REFRESH, async (): Promise<ProviderRefreshResult[]> => {
    const results = await deps.providers.refreshAll()
    broadcastUsageUpdated()
    return results
  })
}

export function broadcastUsageUpdated(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EVENT.USAGE_UPDATED)
  }
}
