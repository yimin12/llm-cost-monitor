// Locale catalog + helpers shared between main and renderer. Keeping
// this list tiny on purpose — every entry is a maintenance promise.
// Add a new one only after you've translated the full message bundle
// for it; partial bundles fall through to English, which is OK for
// development but confusing in shipped builds.

export const LOCALES = ['en', 'zh-CN', 'ja'] as const
export type Locale = (typeof LOCALES)[number]

// Settings-level value. 'auto' resolves to the OS locale at runtime
// via `resolveLocale()`. We never persist a resolved locale —
// re-resolving on each launch lets a user who changes their OS
// language pick up the new value without touching app settings.
export const LOCALE_SETTINGS = ['auto', ...LOCALES] as const
export type LocaleSetting = (typeof LOCALE_SETTINGS)[number]

export const LOCALE_LABEL: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  ja: '日本語',
}

// 'auto' label is fetched separately because we want to show the
// resolved language in parentheses (e.g. "System Default · English").
export const LOCALE_AUTO_LABEL: Record<Locale, string> = {
  en: 'System Default',
  'zh-CN': '跟随系统',
  ja: 'システム設定',
}

// Resolve a setting + raw OS locale into one of our supported locales.
// Falls back to English when the OS locale is something we don't ship
// translations for.
export function resolveLocale(setting: LocaleSetting, osLocale: string): Locale {
  if (setting !== 'auto') return setting
  const lower = osLocale.toLowerCase()
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('ja')) return 'ja'
  return 'en'
}
