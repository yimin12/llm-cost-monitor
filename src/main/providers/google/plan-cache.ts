import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// Last-known-good Google plan, written after every successful Code Assist
// detection. The Gemini CLI access_token only lives ~1 hour; without this
// cache the chip flips from "Plan: Pro" back to "Google Account" whenever
// the user goes that long without invoking the CLI. We deliberately do
// NOT refresh the token ourselves (would require embedding the Gemini
// CLI's OAuth client credentials) — the cache makes the manual-refresh
// model durable instead of momentary.
//
// 30-day TTL = one billing cycle. After that we'd rather show the live
// (Google Account) label than a 2-month-stale tier.

export interface CachedPlan {
  // Short tier label as returned by shortenTierName() — "Pro", "Ultra", etc.
  tier: string
  // Whether the cached tier is a paid subscription (drives the chip color).
  isPaid: boolean
  email: string | null
  // ms epoch of the last successful detection.
  detectedAt: number
}

const CACHE_TTL_MS = 30 * 24 * 60 * 60_000

export async function loadCachedPlan(
  cachePath: string,
  now: () => number = Date.now,
): Promise<CachedPlan | null> {
  let raw: string
  try {
    raw = await readFile(cachePath, 'utf8')
  } catch {
    return null
  }
  let parsed: Partial<CachedPlan>
  try {
    parsed = JSON.parse(raw) as Partial<CachedPlan>
  } catch {
    return null
  }
  if (
    typeof parsed.tier !== 'string' ||
    parsed.tier.length === 0 ||
    typeof parsed.detectedAt !== 'number' ||
    typeof parsed.isPaid !== 'boolean'
  ) {
    return null
  }
  if (now() - parsed.detectedAt > CACHE_TTL_MS) return null
  return {
    tier: parsed.tier,
    isPaid: parsed.isPaid,
    email: typeof parsed.email === 'string' ? parsed.email : null,
    detectedAt: parsed.detectedAt,
  }
}

export async function saveCachedPlan(
  cachePath: string,
  info: Omit<CachedPlan, 'detectedAt'> & { detectedAt?: number },
  now: () => number = Date.now,
): Promise<void> {
  const payload: CachedPlan = {
    tier: info.tier,
    isPaid: info.isPaid,
    email: info.email,
    detectedAt: info.detectedAt ?? now(),
  }
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8')
  } catch {
    // best-effort persistence — never fail plan detection because the
    // cache file couldn't be written (readonly home, disk full, …).
  }
}

// Friendly "stale" hint surfaced in PlanInfo.source so the user can tell
// at a glance that the chip is showing a remembered value, not a live one.
export function formatCacheAge(detectedAtMs: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - detectedAtMs) / 60_000))
  if (minutes < 60) return `cached ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `cached ${hours}h ago`
  const days = Math.floor(hours / 24)
  return `cached ${days}d ago`
}
