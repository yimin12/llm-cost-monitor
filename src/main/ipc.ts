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
  type SyncStatus,
  type TeamManageResult,
  type TeamMemberRole,
  type TeamOverview,
} from '@shared/ipc-channels'
import type { PrivacyLevel, TeamSyncSettings } from '@shared/sync'

import type { Aggregator } from './aggregation/aggregator'
import type { AlertRepository } from './alerts/alert-repository'
import type { AuthService } from './auth/auth-service'
import type { PricingTable } from './pricing/pricing-table'
import type { ProviderRegistry } from './providers/registry'
import type { SettingsStore } from './settings/store'
import type { EventRepository } from './storage/event-repository'
import type { SyncQueue } from './sync/sync-queue'

export interface IpcDeps {
  pricing: PricingTable
  events: EventRepository
  aggregator: Aggregator
  providers: ProviderRegistry
  settings: SettingsStore
  auth: AuthService
  alerts: AlertRepository
  syncQueue: SyncQueue | null
  // Fetches a TeamOverview from the backend. null when sync is disabled
  // or the backend is unreachable; renderer treats both the same.
  fetchTeamOverview: (teamId: string, accessToken: string | null) => Promise<TeamOverview | null>
  // Admin-gated mutations against the team-sync server. Each handler is
  // a thin wrapper that the main process owns so it can attach the
  // bearer token + base URL without leaking either to the renderer.
  teamAddMember: (
    teamId: string,
    accessToken: string | null,
    body: { userId: string; displayName?: string; role?: TeamMemberRole },
  ) => Promise<TeamManageResult>
  teamRevokeMember: (
    teamId: string,
    accessToken: string | null,
    userId: string,
  ) => Promise<TeamManageResult>
  teamSetMemberRole: (
    teamId: string,
    accessToken: string | null,
    userId: string,
    role: TeamMemberRole,
  ) => Promise<TeamManageResult>
  teamSetPrivacyFloor: (
    teamId: string,
    accessToken: string | null,
    level: PrivacyLevel,
  ) => Promise<TeamManageResult>
  // Repaint hook fired after a user-driven alert mutation (ack / resolve /
  // snooze / resolve-all). The sampler already calls its own onAnyChange on
  // automated raises; this covers the manual path so the tray icon and title
  // can't stay stuck on the warning glyph after the dropdown shows ALL CLEAR.
  onAlertsChanged: () => void
}

function teamSyncFromSettings(s: AppSettings): {
  enabled: boolean
  teamId: string | null
  userId: string | null
  privacyLevel: TeamSyncSettings['privacyLevel']
} {
  return {
    enabled: s.teamSync.enabled,
    teamId: s.teamSync.teamId,
    userId: s.teamSync.userId,
    privacyLevel: s.teamSync.privacyLevel,
  }
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
  ipcMain.handle(IPC.SETTINGS_SET, (_e, patch: Partial<AppSettings>): AppSettings => {
    return deps.settings.set(patch)
  })

  ipcMain.handle(IPC.AUTH_CURRENT, (): AuthState => deps.auth.current())
  ipcMain.handle(IPC.AUTH_SIGNIN, async (): Promise<AuthState> => deps.auth.signIn())
  ipcMain.handle(IPC.AUTH_SIGNOUT, async (): Promise<AuthState> => {
    await deps.auth.signOut()
    return deps.auth.current()
  })

  ipcMain.handle(IPC.SYNC_STATUS, async (): Promise<SyncStatus | null> => {
    if (deps.syncQueue === null) return null
    return deps.syncQueue.getStatus(teamSyncFromSettings(deps.settings.get()))
  })
  ipcMain.handle(IPC.SYNC_DRAIN, async (): Promise<SyncStatus | null> => {
    if (deps.syncQueue === null) return null
    await deps.syncQueue.drain(teamSyncFromSettings(deps.settings.get()))
    const status = await deps.syncQueue.getStatus(teamSyncFromSettings(deps.settings.get()))
    broadcastSyncStatusChanged(status)
    return status
  })
  ipcMain.handle(IPC.SYNC_TEAM_OVERVIEW, async (): Promise<TeamOverview | null> => {
    const cfg = deps.settings.get().teamSync
    if (!cfg.enabled || cfg.teamId === null) return null
    const token = await deps.auth.accessTokenForSync().catch(() => null)
    return deps.fetchTeamOverview(cfg.teamId, token)
  })

  // Helper: resolve teamId + bearer token, otherwise short-circuit to a
  // structured error the renderer can show as a toast.
  const requireTeam = async (): Promise<
    | { ok: true; teamId: string; token: string | null }
    | { ok: false; result: TeamManageResult }
  > => {
    const cfg = deps.settings.get().teamSync
    if (!cfg.enabled || cfg.teamId === null) {
      return {
        ok: false,
        result: { ok: false, status: 0, error: 'sync_off', message: 'team sync is off' },
      }
    }
    const token = await deps.auth.accessTokenForSync().catch(() => null)
    return { ok: true, teamId: cfg.teamId, token }
  }

  ipcMain.handle(
    IPC.TEAM_ADD_MEMBER,
    async (_e, body: { userId: string; displayName?: string; role?: TeamMemberRole }): Promise<TeamManageResult> => {
      const ctx = await requireTeam()
      if (!ctx.ok) return ctx.result
      return deps.teamAddMember(ctx.teamId, ctx.token, body)
    },
  )
  ipcMain.handle(
    IPC.TEAM_REVOKE_MEMBER,
    async (_e, userId: string): Promise<TeamManageResult> => {
      const ctx = await requireTeam()
      if (!ctx.ok) return ctx.result
      return deps.teamRevokeMember(ctx.teamId, ctx.token, userId)
    },
  )
  ipcMain.handle(
    IPC.TEAM_SET_MEMBER_ROLE,
    async (_e, userId: string, role: TeamMemberRole): Promise<TeamManageResult> => {
      const ctx = await requireTeam()
      if (!ctx.ok) return ctx.result
      return deps.teamSetMemberRole(ctx.teamId, ctx.token, userId, role)
    },
  )
  ipcMain.handle(
    IPC.TEAM_SET_PRIVACY_FLOOR,
    async (_e, level: PrivacyLevel): Promise<TeamManageResult> => {
      const ctx = await requireTeam()
      if (!ctx.ok) return ctx.result
      return deps.teamSetPrivacyFloor(ctx.teamId, ctx.token, level)
    },
  )

  // Wire the AuthService → renderer broadcast.
  deps.auth.subscribe((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(EVENT.AUTH_STATE_CHANGED, state)
    }
  })

  deps.settings.subscribe((s) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(EVENT.SETTINGS_CHANGED, s)
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
    deps.onAlertsChanged()
  })
  ipcMain.handle(IPC.ALERTS_RESOLVE, async (_e, id: string): Promise<void> => {
    await deps.alerts.resolve(id)
    broadcastAlertsUpdated()
    deps.onAlertsChanged()
  })
  ipcMain.handle(IPC.ALERTS_SNOOZE, async (_e, id: string): Promise<void> => {
    const minutes = deps.settings.get().alerts.snoozeMinutes
    await deps.alerts.snooze(id, Date.now() + minutes * 60_000)
    broadcastAlertsUpdated()
    deps.onAlertsChanged()
  })
  ipcMain.handle(IPC.ALERTS_RESOLVE_ALL, async (): Promise<number> => {
    const n = await deps.alerts.resolveAll()
    broadcastAlertsUpdated()
    deps.onAlertsChanged()
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

export function broadcastSyncStatusChanged(status: SyncStatus | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EVENT.SYNC_STATUS_CHANGED, status)
  }
}
