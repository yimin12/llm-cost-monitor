// OAuth scopes for identity-only sign-in. Three non-sensitive scopes — no
// Google verification gate. Adding sensitive scopes (Gmail, Sheets, Drive)
// triggers verification for production distribution; OK in "Testing" mode
// for personal use only.
export const OAUTH_SCOPES = ['openid', 'email', 'profile'] as const

// Loopback redirect URI. Web-app-type OAuth clients require this to match
// EXACTLY a pre-registered Authorized redirect URI in the GCP Console.
// Pick a port that's unlikely to conflict; document it in the README so
// the user can add it to their OAuth client config.
export const OAUTH_LOOPBACK_PORT = 51874
export const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_LOOPBACK_PORT}/callback`

// Google OAuth endpoints — stable URLs, baked in.
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
export const GOOGLE_TOKEN_ISSUERS = [
  'https://accounts.google.com',
  'accounts.google.com',
] as const
