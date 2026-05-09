import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

import {
  GOOGLE_JWKS_URL,
  GOOGLE_TOKEN_ISSUERS,
} from '@shared/auth-config'
import type { AuthUser } from '@shared/auth'

// Google's public keys rotate. `jose.createRemoteJWKSet` caches and refreshes
// for us with sane defaults; we only need to instantiate it once.
const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL))

export interface VerifiedIdToken {
  user: AuthUser
  payload: JWTPayload
}

// Verify an `id_token` issued by Google for our client. Throws on any
// signature failure, audience mismatch, expired token, or wrong issuer.
export async function verifyGoogleIdToken(
  idToken: string,
  audience: string,
): Promise<VerifiedIdToken> {
  const { payload } = await jwtVerify(idToken, jwks, {
    audience,
    issuer: [...GOOGLE_TOKEN_ISSUERS],
  })

  const sub = typeof payload.sub === 'string' ? payload.sub : null
  const email = typeof payload['email'] === 'string' ? (payload['email'] as string) : null
  if (sub === null || email === null) {
    throw new Error('id_token missing sub or email claim')
  }

  const user: AuthUser = {
    sub,
    email,
    emailVerified: payload['email_verified'] === true,
    name: typeof payload['name'] === 'string' ? (payload['name'] as string) : null,
    pictureUrl: typeof payload['picture'] === 'string' ? (payload['picture'] as string) : null,
    lastSignedInAt: Date.now(),
  }

  return { user, payload }
}
