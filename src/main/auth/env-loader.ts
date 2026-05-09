import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// We pull OAuth credentials from `~/.env` (per user instruction) — outside
// the project tree so they never accidentally land in the repo. Never log
// values; only main process reads this; never crosses IPC to renderer.

export interface AuthSecrets {
  gcpClientId: string
  gcpClientSecret: string | null
}

const KEY_NAMES: Record<keyof AuthSecrets, string> = {
  gcpClientId: 'GCP_CLIENTID',
  gcpClientSecret: 'GCP_CLIENTSECRET',
}

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

export function loadAuthSecrets(envPath: string = join(homedir(), '.env')): AuthSecrets | null {
  let raw: string
  try {
    raw = readFileSync(envPath, 'utf8')
  } catch {
    return null
  }
  const parsed = parseEnvFile(raw)
  const id = parsed[KEY_NAMES.gcpClientId]
  if (id === undefined || id.length === 0) return null
  const secret = parsed[KEY_NAMES.gcpClientSecret]
  return {
    gcpClientId: id,
    gcpClientSecret: secret !== undefined && secret.length > 0 ? secret : null,
  }
}
