import { app, BrowserWindow, ipcMain, shell } from 'electron'

import {
  EVENT,
  IPC,
  type AggregateSnapshot,
  type Alert,
  type AlertFilter,
  type AlertSummary,
  type AppSettings,
  type AuthState,
  type ProviderListEntry,
  type ProviderRefreshResult,
} from '@shared/ipc-channels'

import type { Aggregator } from './aggregation/aggregator'
import type { AlertRepository } from './alerts/alert-repository'
import type { AuthService } from './auth/auth-service'
import type { PricingTable } from './pricing/pricing-table'
import type { ProviderRegistry } from './providers/registry'
import type { SettingsStore } from './settings/store'
import type { EventRepository } from './storage/event-repository'

export interface IpcDeps {
  pricing: PricingTable
  events: EventRepository
  aggregator: Aggregator
  providers: ProviderRegistry
  settings: SettingsStore
  auth: AuthService
  alerts: AlertRepository
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

  ipcMain.handle(IPC.SETTINGS_GET, (): AppSettings => deps.settings.get())

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

  // Same renderer code runs as either the tray panel (Electron) or a
  // full-page web dashboard (browser). In dev, both are served by the same
  // Vite instance, so the renderer can hand off to a browser tab via
  // shell.openExternal. In production builds the renderer is loaded via
  // file:// and there is no web URL — so we return null and the renderer
  // hides the link.
  ipcMain.handle(IPC.DASHBOARD_URL, (): string | null => {
    return process.env['ELECTRON_RENDERER_URL'] ?? null
  })
  ipcMain.handle(IPC.DASHBOARD_OPEN, async (): Promise<void> => {
    const url = process.env['ELECTRON_RENDERER_URL']
    if (typeof url === 'string' && url.length > 0) {
      await shell.openExternal(url)
    }
  })

  // Alerts. The sampler service is what raises rows in main; the renderer is
  // strictly read + react. Mutations broadcast EVENT.ALERTS_UPDATED so any
  // open panel re-fetches.
  ipcMain.handle(IPC.ALERTS_LIST, async (_e, filter: AlertFilter): Promise<Alert[]> => {
    return deps.alerts.list(filter)
  })
  ipcMain.handle(IPC.ALERTS_SUMMARY, async (): Promise<AlertSummary> => {
    return deps.alerts.summary()
  })
  ipcMain.handle(IPC.ALERTS_ACK, async (_e, id: string): Promise<void> => {
    await deps.alerts.ack(id)
    broadcastAlertsUpdated()
  })
  ipcMain.handle(IPC.ALERTS_RESOLVE, async (_e, id: string): Promise<void> => {
    await deps.alerts.resolve(id)
    broadcastAlertsUpdated()
  })
  ipcMain.handle(IPC.ALERTS_SNOOZE, async (_e, id: string): Promise<void> => {
    const minutes = deps.settings.get().alerts.snoozeMinutes
    await deps.alerts.snooze(id, Date.now() + minutes * 60_000)
    broadcastAlertsUpdated()
  })
  ipcMain.handle(IPC.ALERTS_RESOLVE_ALL, async (): Promise<number> => {
    const n = await deps.alerts.resolveAll()
    broadcastAlertsUpdated()
    return n
  })
}

export function broadcastUsageUpdated(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EVENT.USAGE_UPDATED)
  }
}

export function broadcastAlertsUpdated(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EVENT.ALERTS_UPDATED)
  }
}
