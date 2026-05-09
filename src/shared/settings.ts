// User-editable settings persisted to userData/settings.json. Loaded once
// on app start and mutated through SettingsStore.set(). Schema bumps go
// through `schemaVersion`.

import { DEFAULT_TEAM_SYNC, type TeamSyncSettings } from './sync'

export const SETTINGS_SCHEMA_VERSION = 2

export interface ProviderSettings {
  enabled: boolean
}

export interface AppSettings {
  schemaVersion: number
  refreshIntervalMs: number
  providers: Record<string, ProviderSettings>
  tray: { showCost: boolean }
  alerts: { thresholds: never[] }
  // Cross-node sync configuration. Disabled by default; user opts in via UI.
  // See plan.md Phase 5 + src/shared/sync.ts.
  teamSync: TeamSyncSettings
}

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  refreshIntervalMs: 5 * 60 * 1000,
  providers: {
    anthropic: { enabled: true },
    openai: { enabled: true },
    google: { enabled: true },
    deepseek: { enabled: false },
    moonshotai: { enabled: false },
    xai: { enabled: false },
    zai: { enabled: false },
  },
  tray: { showCost: true },
  alerts: { thresholds: [] },
  teamSync: DEFAULT_TEAM_SYNC,
}
