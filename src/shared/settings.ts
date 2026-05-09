// User-editable settings persisted to userData/settings.json. The file is
// loaded once on app start; an edit UI does not exist yet, so handle this as
// read-mostly. Schema bumps go through `schemaVersion`.

export const SETTINGS_SCHEMA_VERSION = 1

export interface ProviderSettings {
  enabled: boolean
}

export interface AppSettings {
  schemaVersion: number
  refreshIntervalMs: number
  providers: Record<string, ProviderSettings>
  tray: { showCost: boolean }
  alerts: { thresholds: never[] }
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
}
