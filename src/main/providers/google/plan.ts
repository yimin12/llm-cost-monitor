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

export interface GooglePlanDeps {
  geminiHome?: string
  env?: NodeJS.ProcessEnv
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
    return {
      authMode: 'subscription',
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
