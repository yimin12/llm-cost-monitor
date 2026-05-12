import { homedir } from 'node:os'
import { join } from 'node:path'

import { decodeJwt } from 'jose'

// Shared helpers for reading Cursor's local credentials and building the
// `WorkosCursorSessionToken` cookie expected by cursor.com API endpoints.
// Used by both plan detection (./plan.ts) and usage probing (./usage.ts).

interface CursorJwtClaims {
  sub?: string
  email?: string
}

export function resolveCursorStateDb(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env['CURSOR_STATE_DB']
  if (override !== undefined && override.length > 0) return override
  const home = homedir()
  if (platform === 'darwin') {
    return join(
      home,
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb',
    )
  }
  if (platform === 'win32') {
    const appData = env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    return join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  return join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

// Default DB reader: lazy-loads better-sqlite3 so the module stays usable
// in CI / server builds without the native binding. Opens readonly so we
// don't block Cursor.app's own writers.
export async function readCursorAccessToken(dbPath: string): Promise<string | null> {
  try {
    const { default: Database } = (await import('better-sqlite3')) as {
      default: new (
        path: string,
        opts?: { readonly?: boolean; fileMustExist?: boolean },
      ) => {
        prepare: (sql: string) => { get: (...args: unknown[]) => unknown }
        close: () => void
      }
    }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
        .get() as { value?: string | Buffer } | undefined
      if (row === undefined) return null
      const v = row.value
      if (v === undefined || v === null) return null
      return typeof v === 'string' ? v : v.toString('utf8')
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

// Tokens are stored either as a raw JWT or `${workosUserId}::${jwt}`.
export function splitCursorToken(stored: string): { userId: string | null; token: string } {
  const sep = stored.indexOf('::')
  if (sep > 0) {
    return { userId: stored.slice(0, sep), token: stored.slice(sep + 2) }
  }
  return { userId: null, token: stored }
}

export function userIdFromCursorJwt(token: string): string | null {
  try {
    const claims = decodeJwt<CursorJwtClaims>(token)
    return claims.sub ?? null
  } catch {
    return null
  }
}

export function emailFromCursorJwt(token: string): string | null {
  try {
    const claims = decodeJwt<CursorJwtClaims>(token)
    return claims.email ?? null
  } catch {
    return null
  }
}

// Build the cookie cursor.com expects: `WorkosCursorSessionToken=${userId}::${token}`.
// `userId` is resolved from the stored token's `userId::` prefix when present,
// else from the JWT's `sub` claim.
export function buildCursorCookie(stored: string): { cookie: string; userId: string | null; token: string } {
  const { userId: prefixUid, token } = splitCursorToken(stored)
  const userId = prefixUid ?? userIdFromCursorJwt(token)
  const cookie =
    userId !== null
      ? `WorkosCursorSessionToken=${userId}::${token}`
      : `WorkosCursorSessionToken=${token}`
  return { cookie, userId, token }
}
