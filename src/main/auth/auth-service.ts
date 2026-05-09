import type { AuthState, AuthUser } from '@shared/auth'
import { loadAuthSecrets, type AuthSecrets } from './env-loader'
import { runGoogleOAuth, type GoogleOAuthResult } from './google-oauth'

// Auth service. Holds in-memory `AuthState` + a subscriber set; the IPC layer
// rebroadcasts state changes to any open BrowserWindow.
//
// Persistence (Keychain refresh token + Postgres `auth_user` row) lands in
// Slice A4. For now, sign-out is a no-op beyond clearing in-memory state and
// signing in again starts from scratch.

type Listener = (state: AuthState) => void

export class AuthService {
  private state: AuthState = { kind: 'signed-out' }
  private listeners = new Set<Listener>()
  private inflight: Promise<AuthState> | null = null
  // Keep the most recent sign-in's tokens in memory only — Slice A4 will
  // persist refresh_token to Keychain via electron's safeStorage.
  private session: GoogleOAuthResult | null = null

  readonly secrets: AuthSecrets | null

  constructor() {
    this.secrets = loadAuthSecrets()
    if (this.secrets === null) {
      console.warn(
        'auth: no GCP credentials in ~/.env (need GCP_CLIENTID); sign-in disabled',
      )
    } else {
      // Don't infer client type from .env — Desktop OAuth clients can have a
      // leftover secret line that's simply unused. Just report what's loaded.
      console.log(
        `auth: GCP credentials loaded (client_id starts with ${this.secrets.gcpClientId.slice(0, 8)}…, secret in .env: ${this.secrets.gcpClientSecret === null ? 'no' : 'yes'})`,
      )
    }
  }

  get isConfigured(): boolean {
    return this.secrets !== null
  }

  current(): AuthState {
    return this.state
  }

  currentUser(): AuthUser | null {
    return this.state.kind === 'signed-in' ? this.state.user : null
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setState(next: AuthState): void {
    this.state = next
    for (const l of this.listeners) l(next)
  }

  // Idempotent: concurrent calls fold into the same in-flight flow so two
  // browser tabs don't open if the user double-clicks the "Sign in" button.
  signIn(): Promise<AuthState> {
    if (this.inflight !== null) return this.inflight
    if (!this.isConfigured) {
      this.setState({
        kind: 'error',
        message: 'OAuth client not configured. Add GCP_CLIENTID to ~/.env.',
      })
      return Promise.resolve(this.state)
    }
    this.inflight = this.runFlow().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async runFlow(): Promise<AuthState> {
    const secrets = this.secrets
    if (secrets === null) return this.state

    this.setState({ kind: 'signing-in' })
    try {
      const result = await runGoogleOAuth({
        clientId: secrets.gcpClientId,
        clientSecret: secrets.gcpClientSecret,
      })
      this.session = result
      this.setState({ kind: 'signed-in', user: result.user })
      console.log(`auth: signed in as ${result.user.email}`)
      return this.state
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Surface the error in the UI without leaking secrets — Google's error
      // bodies don't include tokens, so passing through is fine.
      console.warn(`auth: sign-in failed: ${message}`)
      this.setState({ kind: 'error', message })
      return this.state
    }
  }

  async signOut(): Promise<void> {
    this.session = null
    this.setState({ kind: 'signed-out' })
  }
}
