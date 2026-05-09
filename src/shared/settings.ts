// User-editable settings persisted to userData/settings.json. The file is
// loaded once on app start; an edit UI does not exist yet, so handle this as
// read-mostly. Schema bumps go through `schemaVersion`.

export const SETTINGS_SCHEMA_VERSION = 2

export interface ProviderSettings {
  enabled: boolean
}

export interface AlertThresholds {
  // System metrics. Numeric percentages 0–100.
  cpuPct: number
  memPct: number
  // Cost metrics. Plain USD (not micro). null disables that check.
  dailyCostUsd: number | null
  monthlyForecastUsd: number | null
}

export interface AlertSettings {
  enabled: boolean
  thresholds: AlertThresholds
  // How long Snooze keeps an alert hidden before it pops back to Open.
  snoozeMinutes: number
  // Sampler tick frequency. Lower = more responsive, more wakes.
  samplingIntervalMs: number
  // OS notifications on raise. Doesn't affect in-app alert visibility.
  notifications: boolean
}

export interface AppSettings {
  schemaVersion: number
  refreshIntervalMs: number
  providers: Record<string, ProviderSettings>
  tray: { showCost: boolean }
  alerts: AlertSettings
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
  alerts: {
    enabled: true,
    thresholds: {
      cpuPct: 90,
      memPct: 90,
      dailyCostUsd: 10,
      monthlyForecastUsd: 100,
    },
    snoozeMinutes: 60,
    samplingIntervalMs: 30_000,
    notifications: true,
  },
}
