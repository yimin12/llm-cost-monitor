import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { BUNDLED_GOOGLE_OAUTH } from '@shared/oauth-config'

// Resolves the Google OAuth client identity for this process.
//
// Priority order (first non-empty wins):
//   1. `~/.env` (or `envPath` arg in tests) — explicit per-machine
//      override. Useful for CI, staging, or a dev who wants to bind
//      this build to their own GCP project.
//   2. `BUNDLED_GOOGLE_OAUTH` from `@shared/oauth-config` — checked
//      into the repo. Lets a fresh clone sign in with zero setup.
//
// Returns null when *neither* source provides a `clientId`. The
// `client_secret` is optional throughout — Desktop OAuth + PKCE works
// without it (see oauth-config.ts header). Never log values; only the
// main process reads this; never crosses IPC to renderer.

export interface AuthSecrets {
  gcpClientId: string
  gcpClientSecret: string | null
  // Where the values came from. Surfaced in console logs so a confused
  // user can tell whether their .env override took effect.
  source: 'env' | 'bundled' | 'mixed'
}

const KEY_NAMES = {
  gcpClientId: 'GCP_CLIENTID',
  gcpClientSecret: 'GCP_CLIENTSECRET',
} as const

// Tiny .env parser. Handles `KEY=value`, ignores blank lines and `#` comments.
// No quote-stripping (we don't expect quoted secrets here). If a value has
// trailing whitespace we trim it.
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue
    out[key] = value
  }
  return out
}

function readEnvFile(envPath: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(envPath, 'utf8'))
  } catch {
    return {}
  }
}

export function loadAuthSecrets(envPath: string = join(homedir(), '.env')): AuthSecrets | null {
  const env = readEnvFile(envPath)
  const envId = env[KEY_NAMES.gcpClientId]
  const envSecret = env[KEY_NAMES.gcpClientSecret]

  const bundledId = BUNDLED_GOOGLE_OAUTH.clientId.trim()
  const bundledSecret = BUNDLED_GOOGLE_OAUTH.clientSecret.trim()

  // clientId: env wins when present + non-empty.
  const idFromEnv = envId !== undefined && envId.length > 0
  const id = idFromEnv ? envId : (bundledId.length > 0 ? bundledId : null)
  if (id === null) return null

  // clientSecret: env wins when explicitly set, else fall back to
  // bundled. Empty string is treated as "no secret" (PKCE-only flow).
  const secretFromEnv = envSecret !== undefined && envSecret.length > 0
  const secret = secretFromEnv ? envSecret : (bundledSecret.length > 0 ? bundledSecret : null)

  const source: AuthSecrets['source'] =
    idFromEnv && secretFromEnv
      ? 'env'
      : !idFromEnv && (secret === null || secret === bundledSecret)
        ? 'bundled'
        : 'mixed'

  return {
    gcpClientId: id,
    gcpClientSecret: secret,
    source,
  }
}
