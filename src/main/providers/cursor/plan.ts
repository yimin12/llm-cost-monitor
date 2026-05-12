import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { unknownPlan, type PlanInfo } from '@shared/plan-info'

import { resolveCursorHome } from '../../parsers/cursor'

// Shape of `<cursorHome>/auth.json` written by cursor-agent on login.
// Cursor's CLI stores either an OAuth session (auth_mode = 'subscription' /
// 'oauth') or a raw API key. The exact field naming follows Cursor's own
// conventions; we accept a few variants so a CLI update can't silently
// regress us to "unknown".
interface CursorAuth {
  auth_mode?: string
  CURSOR_API_KEY?: string | null
  api_key?: string | null
  email?: string | null
  plan?: string | null
  subscription?: string | null
  tokens?: {
    access_token?: string
    refresh_token?: string
    email?: string
  }
}

export interface CursorPlanDeps {
  cursorHome?: string
  env?: NodeJS.ProcessEnv
}

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  hobby: 'Hobby',
  pro: 'Pro',
  business: 'Business',
  team: 'Team',
  ultra: 'Ultra',
  enterprise: 'Enterprise',
}

function labelFor(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  return PLAN_LABEL[raw.toLowerCase()] ?? raw
}

async function readAuthFile(cursorHome: string): Promise<CursorAuth | null> {
  try {
    const raw = await readFile(join(cursorHome, 'auth.json'), 'utf8')
    return JSON.parse(raw) as CursorAuth
  } catch {
    return null
  }
}

export async function detectCursorPlan(deps: CursorPlanDeps = {}): Promise<PlanInfo> {
  const env = deps.env ?? process.env
  const cursorHome = deps.cursorHome ?? resolveCursorHome(env)
  const authPath = join(cursorHome, 'auth.json')

  const auth = await readAuthFile(cursorHome)

  if (auth !== null) {
    // API key login takes precedence when explicitly set.
    if (
      auth.auth_mode === 'apikey' ||
      (auth.CURSOR_API_KEY ?? '') !== '' ||
      (auth.api_key ?? '') !== ''
    ) {
      return {
        authMode: 'apiKey',
        planName: 'API key',
        source: authPath,
        detail: null,
      }
    }

    // OAuth / subscription session.
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

  // API key env-var fallback.
  const apiKey = env['CURSOR_API_KEY']
  if (apiKey !== undefined && apiKey.length > 0) {
    return {
      authMode: 'apiKey',
      planName: 'API key',
      source: 'CURSOR_API_KEY env',
      detail: null,
    }
  }

  return { authMode: 'none', planName: null, source: null, detail: null }
}
