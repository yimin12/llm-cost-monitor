// OAuth scopes for identity-only sign-in. Three non-sensitive scopes — no
// Google verification gate. Adding sensitive scopes (Gmail, Sheets, Drive)
// triggers verification for production distribution; OK in "Testing" mode
// for personal use only.
export const OAUTH_SCOPES = ['openid', 'email', 'profile'] as const

// Desktop OAuth client → loopback redirect with OS-assigned port (port 0).
// Per <https://developers.google.com/identity/protocols/oauth2/native-app>,
// any 127.0.0.1:* is allowed without per-port pre-registration. We construct
// the redirect URI at flow time from the port the OS gives us.
export const oauthRedirectUri = (port: number): string =>
  `http://127.0.0.1:${port}/callback`

// Google OAuth endpoints — stable URLs, baked in.
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
export const GOOGLE_TOKEN_ISSUERS = [
  'https://accounts.google.com',
  'accounts.google.com',
] as const
