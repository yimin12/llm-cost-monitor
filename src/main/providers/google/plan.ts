import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { decodeJwt } from 'jose'

import { unknownPlan, type PlanInfo } from '@shared/plan-info'

import { resolveGeminiHome } from '../../parsers/gemini'
import {
  formatCacheAge,
  loadCachedPlan,
  saveCachedPlan,
  type CachedPlan,
} from './plan-cache'

interface GeminiOAuthCreds {
  access_token?: string
  id_token?: string
  refresh_token?: string
  expiry_date?: number
}

interface GoogleIdClaims {
  email?: string
  hd?: string // hosted domain — Workspace accounts only
}

interface GoogleAccounts {
  active?: string
}

// ── Shape of Google's Code Assist loadCodeAssist response. Endpoint
// is internal/undocumented (used by the Gemini CLI itself); shape
// derived from
// github.com/google-gemini/gemini-cli/packages/core/src/code_assist/types.ts.
// GeminiUserTier has a `name` field that's the *human-readable display
// string* — e.g. "Gemini Code Assist in Google One AI Pro" — the
// Gemini CLI uses to paint its own "Plan: …" banner. We prefer that
// over deriving a label from the tier id ourselves.
interface GeminiUserTier {
  id?: string // 'free-tier' | 'legacy-tier' | 'standard-tier'
  name?: string
}
interface LoadCodeAssistResponse {
  currentTier?: GeminiUserTier | null
  paidTier?: GeminiUserTier | null
}

const CODE_ASSIST_URL =
  'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
const CODE_ASSIST_TIMEOUT_MS = 4_000

// Condense Google's verbose tier name down to a single word the chip
// can hold without wrapping. The Code Assist API hands us strings
// like "Gemini Code Assist in Google One AI Pro" — fine for a banner,
// way too long for a 80-px chip. We scan in priority order (most
// specific first) and return the first keyword that matches.
function shortenTierName(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('ultra')) return 'Ultra'
  if (n.includes('enterprise')) return 'Enterprise'
  if (n.includes('pro')) return 'Pro'
  if (n.includes('standard')) return 'Standard'
  if (n.includes('legacy')) return 'Legacy'
  if (n.includes('free')) return 'Free'
  // Unknown / new tier — surface the original so we don't silently
  // mis-label a future tier as "Pro".
  return name
}

// Map a tier *id* to a short label as a last-resort fallback when
// Google's response omits `name`.
function tierIdLabel(id: string | undefined): string | null {
  if (id === 'standard-tier') return 'Standard'
  if (id === 'legacy-tier') return 'Legacy'
  if (id === 'free-tier') return 'Free'
  return null
}

// Decide the plan label + whether it's a paid subscription. Preference order:
//   1. paidTier.name  — Pro/Ultra/Enterprise users, condensed to one word.
//      Paid by definition.
//   2. currentTier.name — non-paid users (Free / Legacy) with a server-
//      provided name. Marked paid only if the label clearly says so.
//   3. tierIdLabel(paidTier.id ?? currentTier.id) — internal slugs.
//
// We need the paid/unpaid bit at the call site so the chip renders as
// `subscription` (gold "Plan: Pro") vs `oauth` (neutral "Google Account") —
// "subscription" should be reserved for tiers the user is actually paying for.
function planNameFromCodeAssist(
  r: LoadCodeAssistResponse,
): { name: string; isPaid: boolean } | null {
  if (r.paidTier?.name !== undefined && r.paidTier.name.length > 0) {
    return { name: shortenTierName(r.paidTier.name), isPaid: true }
  }
  if (r.paidTier?.id !== undefined) {
    const idLabel = tierIdLabel(r.paidTier.id)
    if (idLabel !== null) return { name: idLabel, isPaid: idLabel !== 'Free' && idLabel !== 'Legacy' }
  }
  if (r.currentTier?.name !== undefined && r.currentTier.name.length > 0) {
    const label = shortenTierName(r.currentTier.name)
    // Treat anything that doesn't read as Free/Legacy as paid — Standard
    // and above are billable Code Assist plans.
    return { name: label, isPaid: label !== 'Free' && label !== 'Legacy' }
  }
  const idLabel = tierIdLabel(r.currentTier?.id)
  if (idLabel !== null) return { name: idLabel, isPaid: idLabel !== 'Free' && idLabel !== 'Legacy' }
  return null
}

async function fetchCodeAssistTier(
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<LoadCodeAssistResponse | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CODE_ASSIST_TIMEOUT_MS)
  try {
    const res = await fetchImpl(CODE_ASSIST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      // Empty metadata is accepted; the Gemini CLI passes ideType /
      // pluginType / platform / duetProject but none are required for
      // the tier lookup we need.
      body: JSON.stringify({ metadata: {} }),
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as LoadCodeAssistResponse
  } catch {
    // Network failure, timeout, 401 (token expired between read and
    // call). Caller falls back to the OIDC-only display.
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface GooglePlanDeps {
  geminiHome?: string
  env?: NodeJS.ProcessEnv
  // Injectable for tests. Defaults to global fetch. In tests we pass
  // an implementation that returns 404 so the Code Assist call never
  // actually hits the network.
  fetchImpl?: typeof fetch
  // Where to read/write the last-known-good plan cache (see plan-cache.ts).
  // null disables caching entirely — used in tests that want a pure
  // detector with no disk side effects. Production callers (the Electron
  // main process) wire this to `<userData>/google-plan-cache.json`.
  cachePath?: string | null
  // Test seam.
  now?: () => number
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

export async function detectGooglePlan(deps: GooglePlanDeps = {}): Promise<PlanInfo> {
  const env = deps.env ?? process.env
  const geminiHome = deps.geminiHome ?? resolveGeminiHome(env)
  const fetchImpl = deps.fetchImpl ?? fetch

  // OAuth login: ~/.gemini/oauth_creds.json. Gemini CLI uses the user's
  // personal Google Account; Workspace accounts surface a `hd` claim.
  const credsPath = join(geminiHome, 'oauth_creds.json')
  const creds = await readJsonFile<GeminiOAuthCreds>(credsPath)
  if (creds !== null && (creds.id_token ?? '') !== '') {
    let email: string | null = null
    let hostedDomain: string | null = null
    try {
      const claims = decodeJwt<GoogleIdClaims>(creds.id_token!)
      email = claims.email ?? null
      hostedDomain = claims.hd ?? null
    } catch {
      // fall through — we still know there's an OAuth creds file
    }
    if (email === null) {
      // fallback: Gemini CLI stores the active account separately
      const accounts = await readJsonFile<GoogleAccounts>(join(geminiHome, 'google_accounts.json'))
      email = accounts?.active ?? null
    }

    // Try Google's Code Assist loadCodeAssist endpoint to surface the
    // real subscription tier (Free / Standard / Google One AI Pro /
    // Legacy). The Gemini CLI itself uses this endpoint to print its
    // "Plan: …" banner. We attempt the call whenever we have an
    // access_token at all — Google's 401 on an expired token is the
    // authoritative signal, and the locally-cached `expiry_date` lags
    // behind whatever the CLI has refreshed to. If we get null back,
    // the user needs to run the Gemini CLI to refresh the token (we
    // deliberately don't refresh ourselves — that would require
    // embedding the CLI's OAuth client credentials).
    let codeAssistResult: { name: string; isPaid: boolean } | null = null
    if (typeof creds.access_token === 'string' && creds.access_token.length > 0) {
      const tier = await fetchCodeAssistTier(creds.access_token, fetchImpl)
      if (tier !== null) codeAssistResult = planNameFromCodeAssist(tier)
    }
    if (codeAssistResult !== null) {
      // Persist for the next Code Assist outage (token expiry, network
      // hiccup, …). Best-effort — saveCachedPlan never throws.
      if (deps.cachePath !== null && deps.cachePath !== undefined) {
        await saveCachedPlan(
          deps.cachePath,
          {
            tier: codeAssistResult.name,
            isPaid: codeAssistResult.isPaid,
            email,
          },
          deps.now,
        )
      }
      return {
        // Reserve `subscription` for paid tiers (Pro / Ultra / Standard /
        // Enterprise). Free / Legacy stay in OAuth-mode so the chip
        // doesn't pretend the user is paying when they aren't.
        authMode: codeAssistResult.isPaid ? 'subscription' : 'oauth',
        planName: codeAssistResult.name,
        source: credsPath,
        detail: email,
      }
    }
    // Code Assist unreachable. Before flipping to "Google Account", try
    // the last-known-good cache — the chip stays stable instead of
    // visibly flipping every ~hour as the CLI token expires.
    let cached: CachedPlan | null = null
    if (deps.cachePath !== null && deps.cachePath !== undefined) {
      cached = await loadCachedPlan(deps.cachePath, deps.now)
    }
    if (cached !== null) {
      return {
        authMode: cached.isPaid ? 'subscription' : 'oauth',
        planName: cached.tier,
        source: `${credsPath} (${formatCacheAge(cached.detectedAt, (deps.now ?? Date.now)())})`,
        detail: cached.email ?? email,
      }
    }
    // No cache either — fall back to the OIDC-only display.
    return {
      authMode: 'oauth',
      planName: hostedDomain !== null ? 'Workspace Account' : 'Google Account',
      source: credsPath,
      detail: email,
    }
  }

  // API key paths — Gemini CLI honours both env names.
  const apiKey = env['GEMINI_API_KEY'] ?? env['GOOGLE_API_KEY']
  if (apiKey !== undefined && apiKey.length > 0) {
    return {
      authMode: 'apiKey',
      planName: 'API key',
      source: env['GEMINI_API_KEY'] !== undefined ? 'GEMINI_API_KEY env' : 'GOOGLE_API_KEY env',
      detail: null,
    }
  }

  // No creds file and no env — but if oauth_creds existed but had no id_token,
  // surface that as unknown so the user can investigate.
  if (creds !== null) return unknownPlan(`oauth_creds.json present but no id_token at ${credsPath}`)

  return { authMode: 'none', planName: null, source: null, detail: null }
}
