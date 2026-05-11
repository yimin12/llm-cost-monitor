import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { decodeJwt } from 'jose'

import { unknownPlan, type PlanInfo } from '@shared/plan-info'

import { resolveGeminiHome } from '../../parsers/gemini'

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
// derived from github.com/google-gemini/gemini-cli/packages/core/src/code_assist/server.ts.
interface LoadCodeAssistResponse {
  currentTier?: { id?: string }
  paidTier?: {
    availableCredits?: Array<{ creditType?: string; creditAmount?: string }>
  }
}

const CODE_ASSIST_URL =
  'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
const CODE_ASSIST_TIMEOUT_MS = 4_000

// Decide the plan label from the Code Assist response. Mirrors the
// Gemini CLI's "Plan: …" banner string so devbar's chip matches what
// the user already sees in their terminal.
function planNameFromCodeAssist(r: LoadCodeAssistResponse): string | null {
  const credits = r.paidTier?.availableCredits ?? []
  if (credits.some((c) => c.creditType === 'GOOGLE_ONE_AI')) {
    return 'Code Assist · Google One AI Pro'
  }
  const tier = r.currentTier?.id
  if (tier === 'standard-tier') return 'Code Assist · Standard'
  if (tier === 'legacy-tier') return 'Code Assist · Legacy'
  if (tier === 'free-tier') return 'Code Assist · Free'
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
    // "Plan: …" banner. We only attempt it when the cached access
    // token is still valid — refreshing is the Gemini CLI's job, not
    // ours; on the next refresh tick we'll pick up the new token.
    const tokenStillValid =
      typeof creds.access_token === 'string' &&
      creds.access_token.length > 0 &&
      (creds.expiry_date === undefined || creds.expiry_date > Date.now())
    let codeAssistName: string | null = null
    if (tokenStillValid) {
      const tier = await fetchCodeAssistTier(creds.access_token!, fetchImpl)
      if (tier !== null) codeAssistName = planNameFromCodeAssist(tier)
    }
    if (codeAssistName !== null) {
      return {
        authMode: 'subscription',
        planName: codeAssistName,
        source: credsPath,
        detail: email,
      }
    }
    // Fallback when the Code Assist endpoint is unreachable, the
    // token's expired, or the response shape is unfamiliar.
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
