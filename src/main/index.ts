import { app, Tray, BrowserWindow, nativeImage, screen } from 'electron'
import path from 'path'

import { Aggregator } from './aggregation/aggregator'
import { AuthService } from './auth/auth-service'
import { broadcastUsageUpdated, registerIpcHandlers } from './ipc'
import { loadBundledPricing } from './pricing/load-bundled'
import type { PricingTable } from './pricing/pricing-table'
import { ProviderRegistry } from './providers/registry'
import { openPool, type Pool } from './storage/connect'
import { EventRepository } from './storage/event-repository'
import { FileCache } from './storage/file-cache'
import { runMigrations } from './storage/migrations'

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

function createDropdownWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 600,
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
  const pos = getWindowPosition(trayBounds, { width: 420, height: 600 })
  dropdownWin.setPosition(pos.x, pos.y, false)
  dropdownWin.show()
  dropdownWin.focus()
}

async function updateTrayTitle(): Promise<void> {
  if (tray === null || aggregator === null) return
  const snap = await aggregator.snapshot()
  const usd = Number(snap.today.costMicroUsd) / 1_000_000
  const formatted = `$${usd.toFixed(2)}`
  if (process.platform === 'darwin') {
    tray.setTitle(formatted)
  } else {
    tray.setToolTip(`llm-cost-monitor — ${formatted} today`)
  }
}

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

  const auth = new AuthService()

  registerIpcHandlers({ pricing, events, aggregator, providers, auth })

  app.on('before-quit', () => {
    void pool?.end().catch(() => {})
  })

  const iconPath = getIconPath()
  const icon = nativeImage.createFromPath(iconPath)
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(icon)
  if (process.platform === 'darwin') {
    tray.setTitle('$0.00')
  } else {
    tray.setToolTip('llm-cost-monitor')
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
  // Re-scan every 5 minutes so newly written JSONL rows show up without
  // requiring a manual click. Cheap with the mtime cache once slice 11 lands;
  // for now it just re-reads everything (~1s for 678 events on the test data).
  setInterval(() => runRefresh('periodic'), 5 * 60 * 1000)
})
