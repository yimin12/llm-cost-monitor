import { createHash, randomBytes } from 'node:crypto'

// PKCE per RFC 7636. The verifier is a high-entropy random string the client
// keeps secret; the challenge is its SHA-256 hash, sent to the auth server in
// the initial /authorize call. The token-exchange step proves possession of
// the verifier — a stolen `code` is useless without it.

export interface PkcePair {
  verifier: string
  challenge: string
  method: 'S256'
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Compute the S256 challenge from a known verifier. Exposed for tests so we
// can verify against RFC 7636 vectors deterministically.
export function challengeFromVerifier(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

export function generatePkce(): PkcePair {
  // RFC 7636 §4.1: verifier is 43–128 chars from [A-Za-z0-9-._~]. base64url
  // of 32 random bytes gives 43 chars and stays within the allowed alphabet.
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: challengeFromVerifier(verifier), method: 'S256' }
}
