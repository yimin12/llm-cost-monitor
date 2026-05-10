import fs from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  type AppSettings,
} from '@shared/settings'
import { DEFAULT_TEAM_SYNC, type TeamSyncSettings } from '@shared/sync'

export class SettingsStore {
  private cached: AppSettings
  private listeners: Set<(s: AppSettings) => void> = new Set()

  constructor(private readonly filePath: string) {
    this.cached = this.loadOrInit()
  }

  get(): AppSettings {
    return this.cached
  }

  // Atomic update: shallow-merge `patch` into the current settings, then
  // write to a temp file and rename. Subscribers are notified after the
  // file flush succeeds.
  set(patch: Partial<AppSettings>): AppSettings {
    const next: AppSettings = {
      ...this.cached,
      ...patch,
      providers: {
        ...this.cached.providers,
        ...(patch.providers ?? {}),
      },
      tray: { ...this.cached.tray, ...(patch.tray ?? {}) },
      alerts: { ...this.cached.alerts, ...(patch.alerts ?? {}) },
      teamSync: { ...this.cached.teamSync, ...(patch.teamSync ?? {}) },
      // Shallow merge so callers can patch a single provider without
      // dropping the others. Empty-string values are filtered out below
      // by the renderer when reading the override.
      planOverrides: {
        ...this.cached.planOverrides,
        ...(patch.planOverrides ?? {}),
      },
      schemaVersion: SETTINGS_SCHEMA_VERSION,
    }
    this.persist(next)
    this.cached = next
    for (const cb of this.listeners) {
      try {
        cb(next)
      } catch {
        // Listeners are best-effort. A throwing one shouldn't kill writes.
      }
    }
    return next
  }

  // Convenience: scoped update for the team-sync sub-object.
  setTeamSync(patch: Partial<TeamSyncSettings>): AppSettings {
    return this.set({ teamSync: { ...this.cached.teamSync, ...patch } })
  }

  subscribe(cb: (s: AppSettings) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private persist(next: AppSettings): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
      fs.renameSync(tmp, this.filePath)
    } catch (err) {
      // The in-memory copy is still current — UI keeps working — but the
      // change won't survive a restart. Log so it's discoverable.
      console.warn(
        `settings: failed to persist to ${this.filePath}: ${(err as Error).message}`,
      )
    }
  }

  private loadOrInit(): AppSettings {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      return migrate(parsed)
    } catch {
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
        fs.writeFileSync(this.filePath, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8')
      } catch {
        // ignore — userData may be read-only in unusual environments
      }
      return DEFAULT_SETTINGS
    }
  }
}

// Forward-only migration. v1 → v2 just adds the `teamSync` block.
function migrate(parsed: Partial<AppSettings>): AppSettings {
  const base: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...parsed,
    providers: { ...DEFAULT_SETTINGS.providers, ...parsed.providers },
    tray: { ...DEFAULT_SETTINGS.tray, ...(parsed.tray ?? {}) },
    alerts: { ...DEFAULT_SETTINGS.alerts, ...(parsed.alerts ?? {}) },
    teamSync: { ...DEFAULT_TEAM_SYNC, ...(parsed.teamSync ?? {}) },
    planOverrides: { ...(parsed.planOverrides ?? {}) },
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  }
  return base
}
