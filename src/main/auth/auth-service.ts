import type { AuthState, AuthUser } from '@shared/auth'
import { loadAuthSecrets, type AuthSecrets } from './env-loader'

// Stub auth service for Slice A2. Holds an in-memory `AuthState` and exposes
// signin/signout no-ops + a state-change subscriber. Slice A3 wires real
// OAuth into this same surface — callers won't change.

type Listener = (state: AuthState) => void

export class AuthService {
  private state: AuthState = { kind: 'signed-out' }
  private listeners = new Set<Listener>()
  readonly secrets: AuthSecrets | null

  constructor() {
    this.secrets = loadAuthSecrets()
    // Surface configuration status in the dev console without leaking values.
    if (this.secrets === null) {
      console.warn(
        'auth: no GCP credentials in ~/.env (need GCP_CLIENTID); sign-in disabled',
      )
    } else {
      console.log(
        `auth: GCP credentials loaded (client_id starts with ${this.secrets.gcpClientId.slice(0, 8)}…, secret: ${this.secrets.gcpClientSecret === null ? 'absent (Desktop client?)' : 'present (Web client)'})`,
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

  // Slice A2 stubs — real implementations in A3.
  async signIn(): Promise<AuthState> {
    if (!this.isConfigured) {
      this.setState({
        kind: 'error',
        message: 'OAuth client not configured. Add GCP_CLIENTID to ~/.env.',
      })
      return this.state
    }
    // TODO Slice A3: PKCE + loopback + token exchange.
    this.setState({
      kind: 'error',
      message: 'Sign-in flow not yet implemented (Slice A3).',
    })
    return this.state
  }

  async signOut(): Promise<void> {
    // TODO Slice A4: clear Keychain refresh token, delete auth_user row.
    this.setState({ kind: 'signed-out' })
  }
}
