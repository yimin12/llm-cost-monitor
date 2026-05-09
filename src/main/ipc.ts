import { app, BrowserWindow, ipcMain } from 'electron'

import {
  EVENT,
  IPC,
  type AggregateSnapshot,
  type AuthState,
  type ProviderListEntry,
  type ProviderRefreshResult,
} from '@shared/ipc-channels'

import type { Aggregator } from './aggregation/aggregator'
import type { AuthService } from './auth/auth-service'
import type { PricingTable } from './pricing/pricing-table'
import type { ProviderRegistry } from './providers/registry'
import type { EventRepository } from './storage/event-repository'

export interface IpcDeps {
  pricing: PricingTable
  events: EventRepository
  aggregator: Aggregator
  providers: ProviderRegistry
  auth: AuthService
}

export function registerIpcHandlers(deps: IpcDeps): void {
  ipcMain.handle(IPC.PING, () => 'pong')
  ipcMain.handle(IPC.PRICING_INFO, () => ({
    snapshotVersion: deps.pricing.snapshotVersion,
    modelCount: deps.pricing.modelCount,
  }))
  ipcMain.handle(IPC.STORAGE_INFO, async () => ({
    eventCount: await deps.events.count(),
  }))
  ipcMain.handle(
    IPC.AGGREGATES,
    async (): Promise<AggregateSnapshot> => deps.aggregator.snapshot(),
  )
  ipcMain.handle(IPC.PROVIDERS_LIST, async (): Promise<ProviderListEntry[]> => {
    return deps.providers.describe()
  })
  ipcMain.handle(IPC.PROVIDERS_REFRESH, async (): Promise<ProviderRefreshResult[]> => {
    const results = await deps.providers.refreshAll()
    broadcastUsageUpdated()
    return results
  })

  ipcMain.handle(IPC.AUTH_CURRENT, (): AuthState => deps.auth.current())
  ipcMain.handle(IPC.AUTH_SIGNIN, async (): Promise<AuthState> => deps.auth.signIn())
  ipcMain.handle(IPC.AUTH_SIGNOUT, async (): Promise<AuthState> => {
    await deps.auth.signOut()
    return deps.auth.current()
  })

  // Wire the AuthService → renderer broadcast.
  deps.auth.subscribe((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(EVENT.AUTH_STATE_CHANGED, state)
    }
  })

  // Tray apps don't have a Dock icon or a menu bar entry, so the only way for
  // a user to quit was Cmd-Q from a focused window. Expose an explicit action.
  ipcMain.handle(IPC.APP_QUIT, () => {
    app.quit()
  })
}

export function broadcastUsageUpdated(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EVENT.USAGE_UPDATED)
  }
}
