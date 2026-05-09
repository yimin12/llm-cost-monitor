import fs from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  type AppSettings,
} from '@shared/settings'

export class SettingsStore {
  private cached: AppSettings

  constructor(private readonly filePath: string) {
    this.cached = this.loadOrInit()
  }

  get(): AppSettings {
    return this.cached
  }

  // No public set() yet — edit UI lands in a follow-up branch. When it does,
  // writes must go through tmp + rename for atomicity and update `cached`.

  private loadOrInit(): AppSettings {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      // Future migrations branch on parsed.schemaVersion. Today we only have v1
      // so unknown versions fall through to defaults rather than crashing.
      if (parsed.schemaVersion !== SETTINGS_SCHEMA_VERSION) return DEFAULT_SETTINGS
      return { ...DEFAULT_SETTINGS, ...parsed, providers: { ...DEFAULT_SETTINGS.providers, ...parsed.providers } }
    } catch {
      // Best-effort initialise the file so users can hand-edit before the UI
      // exists. Failures here are non-fatal — the app still runs on defaults.
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
