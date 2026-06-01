import type { IncomingMessage } from 'node:http'

import { createRemoteJWKSet, jwtVerify } from 'jose'

import { GOOGLE_JWKS_URL, GOOGLE_TOKEN_ISSUERS } from '../src/shared/auth-config'

// Server-side bearer-token authorizer. Two modes:
//
//   LCM_SERVER_AUTH=jwks (default in production):
//     `Authorization: Bearer <google id_token>` is verified against
//     Google's JWKS. Audience must equal LCM_SERVER_AUDIENCE (the
//     Desktop OAuth client_id). On success, returns { userId: sub }.
//
//   LCM_SERVER_AUTH=insecure-noverify:
//     Decodes the JWT payload without verification, returns the `sub`
//     claim. ONLY for local dev. The server logs a startup warning when
//     this mode is selected.
//
// The previous implementation defaulted to insecure-noverify silently.
// That was a real security hole: any caller could forge a `sub` and
// the server would trust it (see docs/team-sync.md threat model).

export type Authorizer = (req: IncomingMessage) => Promise<{ userId: string | null }>

export interface AuthorizerConfig {
  mode: 'jwks' | 'insecure-noverify'
  audience: string | null
  jwksUrl?: string
  issuers?: readonly string[]
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AuthorizerConfig {
  const mode = env['LCM_SERVER_AUTH'] === 'insecure-noverify' ? 'insecure-noverify' : 'jwks'
  const audience = env['LCM_SERVER_AUDIENCE'] ?? null
  return { mode, audience }
}

export function createAuthorizer(cfg: AuthorizerConfig): Authorizer {
  if (cfg.mode === 'insecure-noverify') {
    return insecureAuthorizer
  }
  if (cfg.audience === null || cfg.audience.length === 0) {
    throw new Error(
      'LCM_SERVER_AUDIENCE must be set when LCM_SERVER_AUTH=jwks (the Desktop OAuth client_id)',
    )
  }
  const jwks = createRemoteJWKSet(new URL(cfg.jwksUrl ?? GOOGLE_JWKS_URL))
  const issuers = cfg.issuers ?? GOOGLE_TOKEN_ISSUERS
  const audience = cfg.audience
  return async (req) => {
    const token = bearerOf(req)
    if (token === null) return { userId: null }
    try {
      const { payload } = await jwtVerify(token, jwks, {
        audience,
        issuer: [...issuers],
      })
      const sub = typeof payload.sub === 'string' ? payload.sub : null
      return { userId: sub }
    } catch {
      return { userId: null }
    }
  }
}

const insecureAuthorizer: Authorizer = async (req) => {
  const token = bearerOf(req)
  if (token === null) return { userId: null }
  const parts = token.split('.')
  if (parts.length === 3) {
    try {
      const json = Buffer.from(parts[1]!, 'base64url').toString('utf8')
      const claims = JSON.parse(json) as { sub?: string; email?: string }
      const sub = claims.sub ?? claims.email ?? null
      if (sub !== null) return { userId: sub }
    } catch {
      // fall through
    }
  }
  return { userId: token }
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers['authorization']
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length === 0 ? null : token
}
