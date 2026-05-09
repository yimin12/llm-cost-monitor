import { exec } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { unknownPlan, type PlanInfo } from '@shared/plan-info'

import { resolveClaudeHome } from '../../parsers/claude-code'

const execAsync = promisify(exec)

// Claude Code's OAuth credentials JSON shape. We only care about the
// subscription tier and a couple of identity hints. Fields are best-effort —
// Anthropic has changed this shape over time (e.g. `subscriptionType` →
// `subscription`), so we accept either.
interface ClaudeCredentials {
  claudeAiOauth?: {
    subscriptionType?: string | null
    subscription?: string | null
    accountUuid?: string | null
    emailAddress?: string | null
    expiresAt?: number | null
  }
}

export interface AnthropicPlanDeps {
  // Override homedir / env / runtime for tests.
  claudeHome?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  readKeychain?: () => Promise<string | null>
}

const SUBSCRIPTION_LABEL: Record<string, string> = {
  max: 'Max',
  pro: 'Pro',
  free: 'Free',
  team: 'Team',
  enterprise: 'Enterprise',
}

function labelFor(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  return SUBSCRIPTION_LABEL[raw.toLowerCase()] ?? raw
}

// macOS reads from Keychain; everything else falls back to ~/.claude/.credentials.json.
// The Keychain entry is stored by Claude Code under service "Claude Code-credentials".
async function defaultKeychainRead(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { timeout: 2000 },
    )
    const trimmed = stdout.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

async function readCredentialsFile(claudeHome: string): Promise<string | null> {
  try {
    return await readFile(join(claudeHome, '.credentials.json'), 'utf8')
  } catch {
    return null
  }
}

function parseCredentials(raw: string): ClaudeCredentials | null {
  try {
    return JSON.parse(raw) as ClaudeCredentials
  } catch {
    return null
  }
}

export async function detectAnthropicPlan(deps: AnthropicPlanDeps = {}): Promise<PlanInfo> {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const claudeHome = deps.claudeHome ?? resolveClaudeHome(env)

  // Subscription path (Claude Code OAuth) takes precedence: it's what the
  // CLI actually uses when both an API key env var and a logged-in session
  // exist. Verify-then-fall-through if we can't read the credentials.
  let credentialsRaw: string | null = null
  let credentialsSource: string | null = null
  if (platform === 'darwin') {
    const read = deps.readKeychain ?? defaultKeychainRead
    credentialsRaw = await read()
    if (credentialsRaw !== null) credentialsSource = 'macOS Keychain'
  }
  if (credentialsRaw === null) {
    credentialsRaw = await readCredentialsFile(claudeHome)
    if (credentialsRaw !== null) credentialsSource = `${claudeHome}/.credentials.json`
  }

  if (credentialsRaw !== null) {
    const parsed = parseCredentials(credentialsRaw)
    if (parsed === null) {
      return unknownPlan(`could not parse credentials from ${credentialsSource ?? 'unknown'}`)
    }
    const oauth = parsed.claudeAiOauth
    if (oauth !== undefined && oauth !== null) {
      const tier = labelFor(oauth.subscriptionType ?? oauth.subscription ?? null)
      return {
        authMode: 'subscription',
        planName: tier ?? 'Subscription',
        source: credentialsSource,
        detail: oauth.emailAddress ?? oauth.accountUuid ?? null,
      }
    }
  }

  // API key fallback. Claude Code respects ANTHROPIC_API_KEY.
  const apiKey = env['ANTHROPIC_API_KEY']
  if (apiKey !== undefined && apiKey.length > 0) {
    return {
      authMode: 'apiKey',
      planName: 'API key',
      source: 'ANTHROPIC_API_KEY env',
      detail: null,
    }
  }

  return { authMode: 'none', planName: null, source: null, detail: null }
}
