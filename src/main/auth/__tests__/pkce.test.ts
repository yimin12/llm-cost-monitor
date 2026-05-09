import { describe, expect, it } from 'vitest'

import { challengeFromVerifier, generatePkce } from '../pkce'

describe('PKCE', () => {
  it('matches the RFC 7636 Appendix B test vector', () => {
    // RFC 7636 Appendix B:
    //   code_verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    //   code_challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    expect(challengeFromVerifier('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('generates a verifier of legal length and alphabet', () => {
    const pair = generatePkce()
    expect(pair.method).toBe('S256')
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43)
    expect(pair.verifier.length).toBeLessThanOrEqual(128)
    // RFC 7636 §4.1: unreserved characters from [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"
    // base64url adds "-_" but not "." or "~" — both allowed by the RFC alphabet.
    expect(pair.verifier).toMatch(/^[A-Za-z0-9\-_]+$/)
    expect(pair.challenge).toMatch(/^[A-Za-z0-9\-_]+$/)
  })

  it('challenge is deterministic for a fixed verifier', () => {
    const pair = generatePkce()
    expect(challengeFromVerifier(pair.verifier)).toBe(pair.challenge)
  })

  it('generates a fresh verifier each call', () => {
    const a = generatePkce()
    const b = generatePkce()
    expect(a.verifier).not.toBe(b.verifier)
  })
})
