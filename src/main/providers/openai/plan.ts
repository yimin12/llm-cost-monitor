import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { decodeJwt } from 'jose'

import { unknownPlan, type PlanInfo } from '@shared/plan-info'

import { resolveCodexHome } from '../../parsers/codex'

interface CodexAuth {
  OPENAI_API_KEY?: string | null
  auth_mode?: 'chatgpt' | 'apikey' | string
  tokens?: {
    id_token?: string
    access_token?: string
    account_id?: string
  }
}

// Claims set on the ChatGPT id_token by OpenAI's auth backend. The
// `auth.chatgpt_plan_type` value is what determines whether the user is on
// Plus / Pro / Team / Enterprise / Free.
interface ChatGPTAuthClaims {
  email?: string
  'https://api.openai.com/auth'?: {
    chatgpt_plan_type?: string
    chatgpt_account_id?: string
  }
}

export interface OpenAIPlanDeps {
  codexHome?: string
  env?: NodeJS.ProcessEnv
}

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
}

function labelFor(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  return PLAN_LABEL[raw.toLowerCase()] ?? raw
}

async function readAuthFile(codexHome: string): Promise<CodexAuth | null> {
  try {
    const raw = await readFile(join(codexHome, 'auth.json'), 'utf8')
    return JSON.parse(raw) as CodexAuth
  } catch {
    return null
  }
}

export async function detectOpenAIPlan(deps: OpenAIPlanDeps = {}): Promise<PlanInfo> {
  const env = deps.env ?? process.env
  const codexHome = deps.codexHome ?? resolveCodexHome(env)
  const authPath = `${codexHome}/auth.json`

  const auth = await readAuthFile(codexHome)

  // ChatGPT subscription login: auth_mode=chatgpt, plan tier in id_token JWT.
  if (auth !== null && auth.auth_mode === 'chatgpt') {
    const idToken = auth.tokens?.id_token
    if (idToken === undefined || idToken.length === 0) {
      return unknownPlan(`auth_mode=chatgpt but missing id_token in ${authPath}`)
    }
    let claims: ChatGPTAuthClaims
    try {
      claims = decodeJwt<ChatGPTAuthClaims>(idToken)
    } catch (err) {
      return unknownPlan(`could not decode id_token: ${(err as Error).message}`)
    }
    const planType = claims['https://api.openai.com/auth']?.chatgpt_plan_type
    return {
      authMode: 'subscription',
      planName: labelFor(planType) ?? 'ChatGPT',
      source: authPath,
      detail: claims.email ?? null,
    }
  }

  // API key paths — `auth_mode=apikey`, an OPENAI_API_KEY in the file, or env var.
  if (auth !== null && (auth.auth_mode === 'apikey' || (auth.OPENAI_API_KEY ?? '') !== '')) {
    return {
      authMode: 'apiKey',
      planName: 'API key',
      source: authPath,
      detail: null,
    }
  }
  const envKey = env['OPENAI_API_KEY']
  if (envKey !== undefined && envKey.length > 0) {
    return {
      authMode: 'apiKey',
      planName: 'API key',
      source: 'OPENAI_API_KEY env',
      detail: null,
    }
  }

  return { authMode: 'none', planName: null, source: null, detail: null }
}
