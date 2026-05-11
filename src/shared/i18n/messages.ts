// Translation bundles. Keep keys flat + descriptive (no nesting) so a
// missing translation is easy to grep for. English is the source of
// truth — every other locale must mirror its key set; the type system
// enforces this via `Messages = typeof EN`.
//
// Coverage policy: this file covers high-traffic shell strings (tab
// names, buttons, footer chrome). Per-tab content strings can be
// translated incrementally — the `t()` hook falls back to the EN
// value when a key is missing.

export const EN = {
  // ── shell chrome ─────────────────────────────────────────────────
  refresh: 'refresh',
  refreshing: 'refreshing',
  signIn: 'Sign in',
  signOut: 'Sign out',
  quit: 'Quit',
  liveAgo: 'live · {ago} ago',
  updatedAgo: 'updated {ago} ago',

  // ── tabs ────────────────────────────────────────────────────────
  tabOverview: 'Overview',
  tabProviders: 'Providers',
  tabSessions: 'Sessions',
  tabAlerts: 'Alerts',
  tabTeam: 'Team',
  tabSettings: 'Settings',

  // ── footer ──────────────────────────────────────────────────────
  footerVersion: 'v{version}',
  langPickerTitle: 'Language',

  // ── privacy banner ──────────────────────────────────────────────
  privacyOnDeviceOnly: 'On-device only.',
  privacySessionScanned: 'Session logs scanned locally; no telemetry, no cloud sync.',
} as const

// Keys are pinned to EN's shape but values are plain strings so
// non-English bundles can use their own literal values (without
// inheriting EN's `as const` literal-type narrowing).
export type MessageKey = keyof typeof EN
export type Messages = Record<MessageKey, string>

export const ZH_CN: Messages = {
  refresh: '刷新',
  refreshing: '刷新中',
  signIn: '登录',
  signOut: '退出登录',
  quit: '退出',
  liveAgo: '在线 · {ago}前',
  updatedAgo: '{ago}前更新',

  tabOverview: '概览',
  tabProviders: '提供方',
  tabSessions: '会话',
  tabAlerts: '提醒',
  tabTeam: '团队',
  tabSettings: '设置',

  footerVersion: 'v{version}',
  langPickerTitle: '语言',

  privacyOnDeviceOnly: '本地运行。',
  privacySessionScanned: '会话日志仅在本地解析,不上传任何遥测或云端。',
}

export const JA: Messages = {
  refresh: '更新',
  refreshing: '更新中',
  signIn: 'サインイン',
  signOut: 'サインアウト',
  quit: '終了',
  liveAgo: 'ライブ · {ago}前',
  updatedAgo: '{ago}前に更新',

  tabOverview: '概要',
  tabProviders: 'プロバイダ',
  tabSessions: 'セッション',
  tabAlerts: 'アラート',
  tabTeam: 'チーム',
  tabSettings: '設定',

  footerVersion: 'v{version}',
  langPickerTitle: '言語',

  privacyOnDeviceOnly: 'デバイス内のみ。',
  privacySessionScanned: 'セッションログはローカルで解析され、テレメトリも同期もありません。',
}

export const BUNDLES = {
  en: EN,
  'zh-CN': ZH_CN,
  ja: JA,
} as const

// Lightweight {placeholder} interpolation — keeps the API surface tiny.
// Missing placeholders are left as-is so the dev notices.
export function format(template: string, vars?: Record<string, string | number>): string {
  if (vars === undefined) return template
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k]
    return v === undefined ? m : String(v)
  })
}
