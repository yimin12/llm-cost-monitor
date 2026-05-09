import { app, Tray, BrowserWindow, nativeImage, screen } from 'electron'
import path from 'path'

import { Aggregator } from './aggregation/aggregator'
import { AlertRepository } from './alerts/alert-repository'
import { AlertNotifier } from './alerts/notifier'
import { AlertSampler } from './alerts/sampler'
import { getAlertTrayIcon } from './tray-icons'
import { AuthRepository } from './auth/auth-repository'
import { AuthService } from './auth/auth-service'
import { KeychainStore } from './auth/keychain-store'
import {
  broadcastAlertsUpdated,
  broadcastSyncStatusChanged,
  broadcastUsageUpdated,
  registerIpcHandlers,
} from './ipc'
import { loadBundledPricing } from './pricing/load-bundled'
import type { PricingTable } from './pricing/pricing-table'
import { ProviderRegistry } from './providers/registry'
import { SettingsStore } from './settings/store'
import { openPool, type Pool } from './storage/connect'
import { EventRepository } from './storage/event-repository'
import { FileCache } from './storage/file-cache'
import { runMigrations } from './storage/migrations'
import { CursorRepository } from './sync/cursor-repository'
import { NodeIdentityRepository } from './sync/node-identity'
import { SyncQueue } from './sync/sync-queue'
import { HttpSyncTransport } from './sync/transport'
import { fetchTeamOverview } from './sync/team-overview-client'

app.on('window-all-closed', () => {
  // Tray-only app — never quit on window close.
})

let tray: Tray | null = null
let dropdownWin: BrowserWindow | null = null
let pricing: PricingTable | null = null
let pool: Pool | null = null
let events: EventRepository | null = null
let providers: ProviderRegistry | null = null
let aggregator: Aggregator | null = null
let alerts: AlertRepository | null = null
let baseTrayIcon: Electron.NativeImage | null = null

function getIconPath(): string {
  return path.join(
    app.isPackaged
      ? path.join(process.resourcesPath, 'icons', 'tray-Template.png')
      : path.join(__dirname, '../../resources/icons/tray-Template.png'),
  )
}

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

function getWindowPosition(
  trayBounds: Bounds,
  winBounds: { width: number; height: number },
): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2),
  })
  const windowWidth = winBounds.width
  const windowHeight = winBounds.height

  if (process.platform === 'darwin') {
    const x = Math.round(trayBounds.x + trayBounds.width / 2 - windowWidth / 2)
    const y = Math.round(trayBounds.y + trayBounds.height)
    return {
      x: Math.max(display.workArea.x, Math.min(x, display.workArea.x + display.workArea.width - windowWidth)),
      y,
    }
  }

  const screenMidY = display.bounds.y + display.bounds.height / 2
  const anchorAbove = trayBounds.y > screenMidY
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - windowWidth / 2)
  const y = anchorAbove
    ? Math.round(trayBounds.y - windowHeight)
    : Math.round(trayBounds.y + trayBounds.height)
  return {
    x: Math.max(display.workArea.x, Math.min(x, display.workArea.x + display.workArea.width - windowWidth)),
    y: Math.max(display.workArea.y, Math.min(y, display.workArea.y + display.workArea.height - windowHeight)),
  }
}

const PANEL_W = 390
const PANEL_H = 720

function createDropdownWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  })
  if (process.env['ELECTRON_RENDERER_URL'] !== undefined) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  win.on('blur', () => win.hide())
  return win
}

function toggleDropdown(): void {
  if (dropdownWin === null) return
  if (dropdownWin.isVisible()) {
    dropdownWin.hide()
    return
  }
  const trayBounds = tray?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 }
  const pos = getWindowPosition(trayBounds, { width: PANEL_W, height: PANEL_H })
  dropdownWin.setPosition(pos.x, pos.y, false)
  dropdownWin.show()
  dropdownWin.focus()
}

async function updateTrayPresentation(): Promise<void> {
  if (tray === null || aggregator === null) return
  const snap = await aggregator.snapshot()
  const usd = Number(snap.today.costMicroUsd) / 1_000_000
  const cost = `$${usd.toFixed(2)}`

  // Live count of "actionable" alerts (open or acked-but-unresolved). Snoozed
  // and resolved alerts don't pollute the tray. Falls back to 0 when the
  // repo isn't ready yet — first refresh runs before app boot completes.
  let openCount = 0
  if (alerts !== null) {
    try {
      const summary = await alerts.summary()
      openCount = summary.open + summary.acked
    } catch {
      // ignore — keep tray sane if the DB hiccups
    }
  }
  const hasAlerts = openCount > 0

  // Icon swap: warning-triangle template when alerts pending, default chart
  // glyph otherwise. Both are template images so macOS tints them with the
  // system foreground color.
  if (hasAlerts) {
    tray.setImage(getAlertTrayIcon())
  } else if (baseTrayIcon !== null) {
    tray.setImage(baseTrayIcon)
  }

  // Title text follows the user's signalling rule: when alerts pending,
  // the menubar shows ONLY the count next to the warning-triangle icon —
  // no word, no cost. The icon already carries the "alert" semantics so
  // any extra label would be redundant. When all clear, the cost takes
  // the slot. Linux still spells it out in the tooltip since it has no
  // icon-swap visual signal to lean on.
  const title = hasAlerts ? String(openCount) : cost
  if (process.platform === 'darwin') {
    tray.setTitle(title)
  } else {
    const alertWord = openCount === 1 ? 'alert' : 'alerts'
    const tip = hasAlerts
      ? `devbar — ${openCount} ${alertWord} (${cost} today)`
      : `devbar — ${cost} today`
    tray.setToolTip(tip)
  }
}

// Backwards-compatible alias used by older call sites.
const updateTrayTitle = updateTrayPresentation

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock?.hide()
  }

  pricing = loadBundledPricing()
  console.log(
    `pricing snapshot ${pricing.snapshotVersion}, ${pricing.modelCount} models loaded`,
  )

  // Postgres-in-Docker (dev) — see docs/auth-plan.md §3 + docker-compose.yml.
  // Shipped builds will swap in a SQLite implementation in a later slice.
  try {
    pool = await openPool({})
  } catch (err) {
    console.error(`postgres unreachable: ${(err as Error).message}`)
    console.error('hint: run `npm run db:up` to start the dev container')
    app.quit()
    return
  }
  // electron-vite emits CommonJS into out/main/index.js, so __dirname is
  // out/main; migrations live two levels up at the repo root in dev, and
  // bundled at app.getAppPath()/migrations in production builds.
  const migrationsDir = app.isPackaged
    ? path.join(app.getAppPath(), 'migrations')
    : path.resolve(__dirname, '../../migrations')
  const migrationStatus = await runMigrations(pool, migrationsDir)
  console.log(
    `storage migrated to v${migrationStatus.appliedVersion}` +
      (migrationStatus.ranThisRun.length > 0
        ? ` (ran ${migrationStatus.ranThisRun.join(',')})`
        : ''),
  )
  events = new EventRepository(pool)
  const initialCount = await events.count()
  console.log(`storage ready (${initialCount} events)`)

  aggregator = new Aggregator(pool)
  const fileCache = new FileCache(pool)
  providers = new ProviderRegistry({ pricing, events, fileCache })
  const settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'))

  const authRepo = new AuthRepository(pool)
  const keychain = new KeychainStore()
  const auth = new AuthService({ repo: authRepo, keychain })

  const alertRepo = new AlertRepository(pool)
  alerts = alertRepo
  const notifier = new AlertNotifier(settings)
  const sampler = new AlertSampler(alertRepo, aggregator, settings, {
    onRaise: (raises) => notifier.fire(raises),
    onAnyChange: () => {
      broadcastAlertsUpdated()
      // Re-paint the tray on every alert mutation so the count stays live
      // without requiring the user to open the dropdown.
      void updateTrayPresentation()
    },
  })

  // Cross-node sync. Queue is initialised even when sync is disabled so the
  // status IPC works (returns nodeId, no traffic). The transport is only
  // built when the user has configured a serverUrl — otherwise drains
  // are a no-op.
  const nodes = new NodeIdentityRepository(pool, {
    appVersion: app.getVersion(),
  })
  await nodes.ensure()
  const cursors = new CursorRepository(pool)
  const eventsRepo = events
  const buildSyncQueue = (): SyncQueue | null => {
    const cfg = settings.get().teamSync
    if (cfg.serverUrl === null || cfg.serverUrl.length === 0) return null
    return new SyncQueue({
      events: eventsRepo,
      cursors,
      nodes,
      transport: new HttpSyncTransport({ baseUrl: cfg.serverUrl }),
      getAccessToken: () => auth.accessTokenForSync(),
    })
  }
  let syncQueue: SyncQueue | null = buildSyncQueue()
  // Rebuild on serverUrl change so the user can flip backends without
  // restarting the app.
  settings.subscribe((s) => {
    if (s.teamSync.serverUrl === null) {
      syncQueue = null
    } else {
      syncQueue = buildSyncQueue()
    }
  })

  registerIpcHandlers({
    pricing,
    events,
    aggregator,
    providers,
    settings,
    auth,
    alerts: alertRepo,
    syncQueue,
    fetchTeamOverview: async (teamId, token) => {
      const baseUrl = settings.get().teamSync.serverUrl
      if (baseUrl === null) return null
      return fetchTeamOverview({ baseUrl, teamId, accessToken: token })
    },
  })

  // Best-effort silent restore — a stored refresh_token + active auth_user
  // row means we can mint a fresh access_token without any user gesture.
  void auth.restoreSession()

  app.on('before-quit', () => {
    void pool?.end().catch(() => {})
  })

  const iconPath = getIconPath()
  baseTrayIcon = nativeImage.createFromPath(iconPath)
  if (process.platform === 'darwin') baseTrayIcon.setTemplateImage(true)
  tray = new Tray(baseTrayIcon)
  if (process.platform === 'darwin') {
    tray.setTitle('$0.00')
  } else {
    tray.setToolTip('devbar')
  }

  dropdownWin = createDropdownWindow()
  tray.on('click', () => toggleDropdown())
  tray.on('right-click', () => toggleDropdown())

  const runRefresh = (label: string): void => {
    if (providers === null) return
    void (async () => {
      try {
        const results = await providers.refreshAll()
        const total = (await events?.count()) ?? 0
        console.log(
          `refresh ${label}: ${results
            .map((r) => `${r.provider}=${r.error ?? 'ok'}`)
            .join(', ')}; ${total} events stored`,
        )
        await updateTrayTitle()
        broadcastUsageUpdated()
      } catch (err) {
        console.warn(`refresh ${label} failed: ${(err as Error).message}`)
      }
    })()
  }

  // Kick the initial refresh in the background — don't block startup.
  runRefresh('startup')
  // Re-scan periodically so newly written JSONL rows show up without
  // requiring a manual click. Interval is read from settings.json
  // (refreshIntervalMs); changes require a restart until the edit UI ships.
  setInterval(() => runRefresh('periodic'), settings.get().refreshIntervalMs)

  // Start the alert sampler — runs every settings.alerts.samplingIntervalMs
  // (default 30s), evaluates CPU/memory/cost thresholds, raises new alerts
  // (deduped by signature), and fires OS notifications + ALERTS_UPDATED
  // broadcasts when something changes.
  sampler.start()
  app.on('before-quit', () => sampler.stop())

  // Sync drain loop. Always armed — but the queue.drain() call is itself a
  // cheap no-op when sync is disabled or unconfigured. Runs at the user's
  // chosen interval (default 5 min) and broadcasts status to the renderer.
  const runSyncDrain = async (): Promise<void> => {
    if (syncQueue === null) return
    const cfg = settings.get().teamSync
    if (!cfg.enabled || cfg.teamId === null || cfg.userId === null) return
    try {
      const out = await syncQueue.drain({
        enabled: true,
        teamId: cfg.teamId,
        userId: cfg.userId,
        privacyLevel: cfg.privacyLevel,
      })
      const status = await syncQueue.getStatus({
        enabled: true,
        teamId: cfg.teamId,
        userId: cfg.userId,
        privacyLevel: cfg.privacyLevel,
      })
      broadcastSyncStatusChanged(status)
      if (out.error !== null) {
        console.warn(`sync drain: ${out.error}`)
      } else if (out.uploaded > 0) {
        console.log(
          `sync drain: ${out.uploaded} sent, ${out.accepted} accepted, ` +
            `${out.duplicates} dedup, ${out.rejected} rejected`,
        )
      }
    } catch (err) {
      console.warn(`sync drain crashed: ${(err as Error).message}`)
    }
  }
  // First drain happens shortly after startup; subsequent ones every
  // teamSync.intervalMs.
  setTimeout(() => void runSyncDrain(), 10_000)
  setInterval(() => void runSyncDrain(), settings.get().teamSync.intervalMs)
})
