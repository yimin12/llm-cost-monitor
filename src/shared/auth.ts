// Identity-only auth shapes. We persist only what's needed to render the
// dropdown header (email, name, picture) plus Google's stable user id (sub).
// Refresh tokens never leave the main process; safeStorage handles them.

export interface AuthUser {
  // Google's stable user id. Survives email/name changes.
  readonly sub: string
  readonly email: string
  readonly emailVerified: boolean
  readonly name: string | null
  readonly pictureUrl: string | null
  readonly lastSignedInAt: number
}

export type AuthState =
  | { kind: 'signed-out' }
  | { kind: 'signing-in' }
  | { kind: 'signed-in'; user: AuthUser }
  | { kind: 'error'; message: string }
