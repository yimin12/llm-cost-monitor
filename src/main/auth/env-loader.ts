import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { BUNDLED_GOOGLE_OAUTH } from '@shared/oauth-config'

// Resolves the Google OAuth client identity for this process.
//
// Two sources, mutually exclusive — *never interleaved*:
//   1. `~/.env` (or `envPath` arg in tests). The moment the user sets
//      *either* `GCP_CLIENTID` or `GCP_CLIENTSECRET` there, env becomes
//      authoritative for both fields. A missing companion field stays
//      `null` (Desktop OAuth + PKCE works without a secret).
//   2. `BUNDLED_GOOGLE_OAUTH` from `@shared/oauth-config` — checked
//      into the repo. Used only when env provides neither key. Lets a
//      fresh clone sign in with zero setup.
//
// Why atomic, not per-field: mixing env's `clientId` (e.g. for a
// personal GCP project) with the bundled `clientSecret` (issued to the
// project's main client) pairs an OAuth client of project A with the
// secret of project B — Google rejects that with `invalid_client` and
// the cause is invisible from the surface log. Atomicity makes the
// failure mode obvious: env override → user owns the entire credential
// pair, bundle → both halves come from the binary.
//
// Returns null when *neither* source produces a `clientId`. Never logs
// values; only the main process reads this; never crosses IPC.

export interface AuthSecrets {
  gcpClientId: string
  gcpClientSecret: string | null
  // Where the values came from — surfaced in the boot log so a confused
  // user can tell whether their .env override took effect. Compile-time
  // enum: 'mixed' was deliberately retired; partial env overrides used
  // to silently borrow bundled secrets, hiding cross-project bugs.
  source: 'env' | 'bundled'
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

  const hasEnvId = envId !== undefined && envId.length > 0
  const hasEnvSecret = envSecret !== undefined && envSecret.length > 0

  // Atomic selection — see the file header. If the user touched *any*
  // GCP_* key in their .env, env owns both halves; missing fields stay
  // null. Otherwise we fall through to the bundled defaults.
  if (hasEnvId || hasEnvSecret) {
    if (!hasEnvId) {
      // GCP_CLIENTSECRET without GCP_CLIENTID is ambiguous and would
      // otherwise quietly borrow the bundled clientId. Refuse it so the
      // user sees a clear "set both, or remove both" hint at boot.
      console.warn(
        `auth: ${envPath} sets GCP_CLIENTSECRET but no GCP_CLIENTID. ` +
        `Set both keys to use a custom OAuth client, or remove both to fall ` +
        `back to the bundled credentials.`,
      )
      return null
    }
    return {
      gcpClientId: envId!,
      gcpClientSecret: hasEnvSecret ? envSecret! : null,
      source: 'env',
    }
  }

  if (bundledId.length === 0) return null
  return {
    gcpClientId: bundledId,
    gcpClientSecret: bundledSecret.length > 0 ? bundledSecret : null,
    source: 'bundled',
  }
}
