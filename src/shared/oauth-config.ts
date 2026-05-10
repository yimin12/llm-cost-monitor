// Bundled Google OAuth client identity. Committed on purpose so the
// app builds + signs in out-of-the-box on any developer machine —
// no `~/.env` setup required.
//
// Why this is safe to commit:
// ─────────────────────────────
// This client is registered in GCP as **Application type: Desktop app**.
// Per Google's own docs[1] and IETF RFC 8252[2], `client_secret` for a
// Desktop / Installed Application is **non-confidential**:
//
//   > The client secret is not applicable to requests from clients
//   > registered as Android, iOS, or Chrome applications.
//   > —developers.google.com/identity/protocols/oauth2/native-app
//
// Google groups Desktop apps (loopback redirect) into the same public-
// client category as those mobile/Chrome client types. PKCE is the
// actual security boundary: the auth code can't be redeemed without the
// `code_verifier` that never leaves the main process. See
// src/main/auth/pkce.ts + src/main/auth/google-oauth.ts.
//
// Embedding both halves in the binary is the documented pattern that
// gcloud CLI, Cursor, Raycast, the Stripe CLI, etc. all use. The
// "secret" extractable from any distributed build is by design.
//
// [1] https://developers.google.com/identity/protocols/oauth2/native-app
// [2] https://datatracker.ietf.org/doc/html/rfc8252#section-8.5
//
// HOW TO POPULATE FOR A NEW PROJECT
// ─────────────────────────────────
// 1. GCP Console → APIs & Services → Credentials → Create credentials
//    → OAuth client ID → Application type: **Desktop app**.
// 2. Copy "Client ID" and "Client secret" from the dialog.
// 3. Paste them below, replacing the empty strings.
// 4. Commit. Anyone who clones the repo can now sign in immediately.
//
// HOW TO ROTATE
// ─────────────
// Same steps — GCP Console lets you reset the client secret on the
// existing client. Update the value here, commit, ship a new release.
// Old refresh tokens minted against the previous secret keep working
// at Google's token endpoint (it accepts the bundled secret OR PKCE).
//
// PER-DEVELOPER / CI OVERRIDE
// ───────────────────────────
// If a developer (or CI) wants to bind to a different GCP project (e.g.
// staging client, abuse-isolated personal client), put it in
// `~/.env` and the env-loader will prefer those values:
//
//     GCP_CLIENTID=…apps.googleusercontent.com
//     GCP_CLIENTSECRET=GOCSPX-…
//
// Env values win over the bundled defaults below.

export interface BundledOAuthConfig {
  // Google OAuth client_id for this Desktop app. Public per RFC 8252.
  clientId: string
  // Google OAuth client_secret for this Desktop app. Non-confidential
  // per Google's Desktop-app classification — see header. Empty string
  // means "no secret bundled"; the PKCE flow still works as long as
  // clientId is set.
  clientSecret: string
}

// ⬇ Paste your Desktop OAuth client values here, then commit.
// Leave as empty strings to keep the env-only behaviour we had before.
export const BUNDLED_GOOGLE_OAUTH: BundledOAuthConfig = {
  clientId: '',
  clientSecret: '',
}
