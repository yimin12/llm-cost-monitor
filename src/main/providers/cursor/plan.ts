import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { unknownPlan, type PlanInfo } from '@shared/plan-info'

import { resolveCursorHome } from '../../parsers/cursor'
import {
  buildCursorCookie,
  emailFromCursorJwt,
  readCursorAccessToken,
  resolveCursorStateDb,
} from './credentials'

// Re-export so existing callers (CursorProvider) keep working unchanged.
export { resolveCursorStateDb } from './credentials'

// Cursor stores its session token in the VS Code SQLite store it inherits:
//
//   macOS:   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
//   Linux:   ~/.config/Cursor/User/globalStorage/state.vscdb
//   Windows: %APPDATA%/Cursor/User/globalStorage/state.vscdb
//
// Tier lives on the customer's Stripe profile and is most reliably read from
// `GET https://cursor.com/api/auth/stripe`, authenticated with the cookie
// `WorkosCursorSessionToken=${userId}::${token}`. The response field
// `individualMembershipType` is `free | pro | pro_plus | ultra`; teams
// surface via `isTeamMember: true` and `/api/auth/me`'s `plan` string carries
// "enterprise" when applicable. Detection pipeline reverse-engineered from
// tasszz2k/agent-lens (src/cost.ts) + Tendo33/cursor-usage-tracker
// (src/cursorApi.ts).

interface CursorStripeProfile {
  individualMembershipType?: string | null
  membershipType?: string | null
  isTeamMember?: boolean
  isYearlyPlan?: boolean
  subscriptionStatus?: string | null
}

interface CursorMeProfile {
  email?: string
  plan?: string
  subscription?: { plan?: string }
  subscriptionTier?: string
  tier?: string
}

export interface CursorPlanDeps {
  cursorStateDb?: string
  // Legacy cursor-agent CLI auth.json path, still consulted as fallback.
  cursorHome?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  fetchImpl?: typeof fetch
  // Test seam: override the SQLite reader.
  readAccessToken?: (dbPath: string) => Promise<string | null>
}

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  hobby: 'Hobby',
  pro: 'Pro',
  pro_plus: 'Pro+',
  'pro+': 'Pro+',
  ultra: 'Ultra',
  team: 'Team',
  teams: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
}

function labelFor(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  return PLAN_LABEL[raw.toLowerCase().replace(/-/g, '_')] ?? raw
}

const STRIPE_URL = 'https://cursor.com/api/auth/stripe'
const ME_URL = 'https://cursor.com/api/auth/me'
const REQUEST_TIMEOUT_MS = 4_000

async function fetchJson<T>(
  url: string,
  cookie: string,
  fetchImpl: typeof fetch,
): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard',
      },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function tierFromStripe(stripe: CursorStripeProfile): string | null {
  const m = (stripe.individualMembershipType ?? stripe.membershipType ?? '')
    .toString()
    .toLowerCase()
  if (m === '') return null
  return m
}

// Legacy `<cursorHome>/auth.json` fallback for users who installed cursor-agent
// CLI separately. Kept for parity with the original detector.
interface CursorAgentAuth {
  auth_mode?: string
  CURSOR_API_KEY?: string | null
  api_key?: string | null
  email?: string | null
  plan?: string | null
  subscription?: string | null
  tokens?: { access_token?: string; email?: string }
}

async function readAgentAuthFile(cursorHome: string): Promise<CursorAgentAuth | null> {
  try {
    const raw = await readFile(join(cursorHome, 'auth.json'), 'utf8')
    return JSON.parse(raw) as CursorAgentAuth
  } catch {
    return null
  }
}

export async function detectCursorPlan(deps: CursorPlanDeps = {}): Promise<PlanInfo> {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const fetchImpl = deps.fetchImpl ?? fetch
  const readAccessToken = deps.readAccessToken ?? readCursorAccessToken
  const stateDb = deps.cursorStateDb ?? resolveCursorStateDb(env, platform)
  const cursorHome = deps.cursorHome ?? resolveCursorHome(env)

  // 1) Cursor IDE session token in the VS Code SQLite store.
  const stored = await readAccessToken(stateDb)
  if (stored !== null && stored.length > 0) {
    const { cookie, token } = buildCursorCookie(stored)
    const email = emailFromCursorJwt(token)

    const stripe = await fetchJson<CursorStripeProfile>(STRIPE_URL, cookie, fetchImpl)
    let tier = stripe !== null ? tierFromStripe(stripe) : null
    let isTeam = stripe?.isTeamMember === true

    // Enterprise / team disambiguation: /api/auth/me's `plan` string
    // sometimes carries "enterprise" where stripe shows "team".
    if (tier === null || tier === 'team' || isTeam) {
      const me = await fetchJson<CursorMeProfile>(ME_URL, cookie, fetchImpl)
      const mePlan = (me?.plan ?? me?.subscription?.plan ?? me?.subscriptionTier ?? me?.tier ?? '')
        .toString()
        .toLowerCase()
      if (mePlan.includes('enterprise')) tier = 'enterprise'
      else if (mePlan.includes('team') || mePlan.includes('business')) isTeam = true
      else if (tier === null && mePlan.length > 0) tier = mePlan
    }

    if (tier !== null) {
      const finalTier = isTeam && tier !== 'enterprise' ? 'team' : tier
      return {
        authMode: 'subscription',
        planName: labelFor(finalTier) ?? 'Cursor Account',
        source: stateDb,
        detail: email,
      }
    }
    return {
      authMode: 'oauth',
      planName: 'Cursor Account',
      source: stateDb,
      detail: email,
    }
  }

  // 2) Legacy cursor-agent CLI auth.json (separate install).
  const auth = await readAgentAuthFile(cursorHome)
  if (auth !== null) {
    const authPath = join(cursorHome, 'auth.json')
    if (
      auth.auth_mode === 'apikey' ||
      (auth.CURSOR_API_KEY ?? '') !== '' ||
      (auth.api_key ?? '') !== ''
    ) {
      return { authMode: 'apiKey', planName: 'API key', source: authPath, detail: null }
    }
    const tier = labelFor(auth.plan ?? auth.subscription)
    if (auth.tokens?.access_token !== undefined && auth.tokens.access_token.length > 0) {
      return {
        authMode: tier !== null ? 'subscription' : 'oauth',
        planName: tier ?? 'Cursor Account',
        source: authPath,
        detail: auth.email ?? auth.tokens?.email ?? null,
      }
    }
    return unknownPlan(`auth.json present but no recognised credential at ${authPath}`)
  }

  // 3) API-key env fallback.
  const apiKey = env['CURSOR_API_KEY']
  if (apiKey !== undefined && apiKey.length > 0) {
    return { authMode: 'apiKey', planName: 'API key', source: 'CURSOR_API_KEY env', detail: null }
  }

  return { authMode: 'none', planName: null, source: null, detail: null }
}
