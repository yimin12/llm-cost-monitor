import type { AuthState, AuthUser } from '@shared/auth'

import type { AuthRepository } from './auth-repository'
import { loadAuthSecrets, type AuthSecrets } from './env-loader'
import {
  refreshGoogleAccessToken,
  runGoogleOAuth,
  type GoogleOAuthResult,
} from './google-oauth'
import type { KeychainStore } from './keychain-store'

// Auth service. Holds in-memory `AuthState` + a subscriber set; the IPC layer
// rebroadcasts state changes to any open BrowserWindow.
//
// Persistence (Slice A4): refresh_token in OS Keychain via safeStorage,
// auth_user row in Postgres. On startup, `restoreSession()` silently mints a
// fresh access_token from the stored refresh_token; failure → signed-out.

type Listener = (state: AuthState) => void

export interface AuthServiceDeps {
  repo: AuthRepository
  keychain: KeychainStore
}

export class AuthService {
  private state: AuthState = { kind: 'signed-out' }
  private listeners = new Set<Listener>()
  private inflight: Promise<AuthState> | null = null
  private session: GoogleOAuthResult | null = null

  readonly secrets: AuthSecrets | null

  constructor(private readonly deps: AuthServiceDeps) {
    this.secrets = loadAuthSecrets()
    if (this.secrets === null) {
      console.warn(
        'auth: no GCP credentials in ~/.env (need GCP_CLIENTID); sign-in disabled',
      )
    } else {
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

  // Called once at app startup (after Pool is open and migrations run).
  // Tries to mint a fresh access_token from a stored refresh_token + restore
  // the user row. Silent on failure — the user just sees "signed out".
  async restoreSession(): Promise<AuthState> {
    if (!this.isConfigured) return this.state
    const refreshToken = await this.deps.keychain.readRefreshToken()
    if (refreshToken === null) return this.state

    const storedUser = await this.deps.repo.findActive()
    if (storedUser === null) {
      // Inconsistent state — keychain has a token but no user row. Wipe.
      await this.deps.keychain.deleteRefreshToken().catch(() => {})
      return this.state
    }

    try {
      const refreshed = await refreshGoogleAccessToken({
        clientId: this.secrets!.gcpClientId,
        clientSecret: this.secrets!.gcpClientSecret,
        refreshToken,
      })
      this.session = {
        user: refreshed.user ?? storedUser,
        refreshToken: refreshed.newRefreshToken ?? refreshToken,
        accessToken: refreshed.accessToken,
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
      }
      // If Google rotated the refresh token, persist the new one.
      if (refreshed.newRefreshToken !== null) {
        await this.deps.keychain.writeRefreshToken(refreshed.newRefreshToken)
      }
      const finalUser: AuthUser = {
        ...(refreshed.user ?? storedUser),
        // Don't bump last_signed_in_at on a silent restore — keep the truth
        // about when the user actually pressed the button.
        lastSignedInAt: storedUser.lastSignedInAt,
      }
      this.setState({ kind: 'signed-in', user: finalUser })
      console.log(`auth: session restored for ${finalUser.email}`)
      return this.state
    } catch (err) {
      // Refresh failed — token revoked, expired, network down, etc.
      // Don't surface as an error in the UI; the user can press "Sign in"
      // again. Wipe the bad token to avoid a loop.
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`auth: session restore failed (${message}); wiping stored token`)
      await this.deps.keychain.deleteRefreshToken().catch(() => {})
      await this.deps.repo.clearActive().catch(() => {})
      return this.state
    }
  }

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

      // Persist before broadcasting so the renderer never sees a "signed-in
      // but not actually persisted" intermediate state.
      await this.deps.repo.upsertActive(result.user)
      if (result.refreshToken !== null) {
        try {
          await this.deps.keychain.writeRefreshToken(result.refreshToken)
        } catch (err) {
          // Keychain failures are non-fatal — sign-in still works for this
          // session, but won't survive restart.
          console.warn(
            `auth: refresh token NOT persisted (${(err as Error).message}); session won't survive restart`,
          )
        }
      }

      this.setState({ kind: 'signed-in', user: result.user })
      console.log(`auth: signed in as ${result.user.email}`)
      return this.state
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`auth: sign-in failed: ${message}`)
      this.setState({ kind: 'error', message })
      return this.state
    }
  }

  async signOut(): Promise<void> {
    this.session = null
    await this.deps.repo.clearActive().catch(() => {})
    await this.deps.keychain.deleteRefreshToken().catch(() => {})
    this.setState({ kind: 'signed-out' })
    console.log('auth: signed out')
  }
}
