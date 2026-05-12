// Display-format helpers used across tabs. Cost values arrive as bigint
// micro-USD over IPC; we never compute in numbers — only render.

export function microToUsd(micro: bigint | number): string {
  const n = typeof micro === 'bigint' ? Number(micro) : micro
  const usd = n / 1_000_000
  if (usd >= 1000) return `$${usd.toFixed(0)}`
  if (usd >= 100) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'Codex',
  google: 'Gemini',
  cursor: 'Cursor',
  moonshotai: 'Kimi',
  deepseek: 'DeepSeek',
  xai: 'Grok',
  zai: 'GLM',
}
export const PROVIDER_COLOR: Record<string, string> = {
  anthropic: '#d4a373',
  openai: '#10a37f',
  google: '#4285f4',
  cursor: '#1f1f1f',
  moonshotai: '#9b87f5',
  deepseek: '#5b8def',
  xai: '#cdd2d6',
  zai: '#f59e0b',
}

export const providerName = (id: string): string => PROVIDER_LABEL[id] ?? id
export const providerColor = (id: string): string => PROVIDER_COLOR[id] ?? '#8e8e93'
