import { shell } from 'electron'

import {
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  OAUTH_SCOPES,
  oauthRedirectUri,
} from '@shared/auth-config'
import type { AuthUser } from '@shared/auth'

import { verifyGoogleIdToken } from './id-token-verify'
import { LoopbackCallbackServer } from './loopback-server'
import { generatePkce } from './pkce'

export interface GoogleOAuthOptions {
  clientId: string
  // Desktop OAuth clients don't have a secret — this is null in the normal
  // path. We accept it for the (deprecated) Web-app flow but reject it with
  // a clear error if PKCE alone won't work.
  clientSecret?: string | null
}

export interface GoogleOAuthResult {
  user: AuthUser
  refreshToken: string | null
  accessToken: string
  // Expiry as ms-since-epoch.
  accessTokenExpiresAt: number
}

interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
  token_type?: string
  id_token: string
}

// Drive the full PKCE-Loopback flow:
//   1. Generate PKCE pair.
//   2. Bind a loopback server on 127.0.0.1:<random-port>.
//   3. Open the system browser to Google's /authorize.
//   4. Wait for redirect → grab the auth code.
//   5. POST to /token with code + verifier.
//   6. Verify id_token, return user.
export async function runGoogleOAuth(
  opts: GoogleOAuthOptions,
): Promise<GoogleOAuthResult> {
  const pkce = generatePkce()
  const loopback = new LoopbackCallbackServer({ callbackPath: '/callback' })
  const expectedState = generateState()

  try {
    const port = await loopback.start()
    const redirectUri = oauthRedirectUri(port)

    const authUrl = new URL(GOOGLE_AUTH_URL)
    authUrl.searchParams.set('client_id', opts.clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', [...OAUTH_SCOPES].join(' '))
    authUrl.searchParams.set('code_challenge', pkce.challenge)
    authUrl.searchParams.set('code_challenge_method', pkce.method)
    authUrl.searchParams.set('state', expectedState)
    // Google-specific: request a refresh_token on first sign-in.
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')

    await shell.openExternal(authUrl.toString())
    const callback = await loopback.waitForCallback()

    const err = callback.query.get('error')
    if (err !== null) {
      throw new Error(`Google OAuth error: ${err}${
        callback.query.get('error_description') !== null
          ? ` (${callback.query.get('error_description')})`
          : ''
      }`)
    }
    if (callback.query.get('state') !== expectedState) {
      throw new Error('Google OAuth: state mismatch (possible CSRF)')
    }
    const code = callback.query.get('code')
    if (code === null) throw new Error('Google OAuth: missing `code` in callback')

    const body = new URLSearchParams()
    body.set('client_id', opts.clientId)
    if (opts.clientSecret !== null && opts.clientSecret !== undefined) {
      body.set('client_secret', opts.clientSecret)
    }
    body.set('code', code)
    body.set('code_verifier', pkce.verifier)
    body.set('grant_type', 'authorization_code')
    body.set('redirect_uri', redirectUri)

    const resp = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '<no body>')
      throw new Error(`Google /token returned ${resp.status}: ${text}`)
    }
    const tok = (await resp.json()) as TokenResponse

    const verified = await verifyGoogleIdToken(tok.id_token, opts.clientId)
    const expiresAt = Date.now() + Math.max(0, (tok.expires_in - 30) * 1000)

    return {
      user: verified.user,
      refreshToken: tok.refresh_token ?? null,
      accessToken: tok.access_token,
      accessTokenExpiresAt: expiresAt,
    }
  } finally {
    loopback.close()
  }
}

// Random `state` parameter for CSRF protection. Doesn't need to be PKCE-grade
// entropy — just unguessable in the OAuth round-trip.
function generateState(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export interface RefreshOptions {
  clientId: string
  clientSecret?: string | null
  refreshToken: string
}

export interface RefreshResult {
  user: AuthUser | null // Google may or may not include id_token on refresh.
  accessToken: string
  accessTokenExpiresAt: number
  // Some providers rotate refresh tokens; Google usually doesn't, but pass
  // through if a new one arrives so callers can re-persist.
  newRefreshToken: string | null
}

// Exchange a long-lived refresh_token for a fresh access_token (and possibly
// a new id_token + refresh_token). Used at app launch to silently restore an
// existing session without prompting the user.
export async function refreshGoogleAccessToken(
  opts: RefreshOptions,
): Promise<RefreshResult> {
  const body = new URLSearchParams()
  body.set('client_id', opts.clientId)
  if (opts.clientSecret !== null && opts.clientSecret !== undefined) {
    body.set('client_secret', opts.clientSecret)
  }
  body.set('refresh_token', opts.refreshToken)
  body.set('grant_type', 'refresh_token')

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<no body>')
    throw new Error(`Google /token (refresh) returned ${resp.status}: ${text}`)
  }
  const tok = (await resp.json()) as Partial<TokenResponse>

  if (typeof tok.access_token !== 'string' || typeof tok.expires_in !== 'number') {
    throw new Error('Google /token (refresh): missing access_token or expires_in')
  }

  let user: AuthUser | null = null
  if (typeof tok.id_token === 'string') {
    const verified = await verifyGoogleIdToken(tok.id_token, opts.clientId)
    user = verified.user
  }

  return {
    user,
    accessToken: tok.access_token,
    accessTokenExpiresAt: Date.now() + Math.max(0, (tok.expires_in - 30) * 1000),
    newRefreshToken: typeof tok.refresh_token === 'string' ? tok.refresh_token : null,
  }
}
