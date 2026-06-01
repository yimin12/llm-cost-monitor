import type { webcrypto } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { configFromEnv, createAuthorizer } from '../auth'

// Build a fake IncomingMessage with just the Authorization header. We
// avoid spinning up a real HTTP server for each test — the authorizer
// only reads `req.headers['authorization']`.
function reqWithAuth(value: string | undefined): IncomingMessage {
  return { headers: value === undefined ? {} : { authorization: value } } as unknown as IncomingMessage
}

const TEST_AUDIENCE = 'test-client.apps.googleusercontent.com'
const TEST_ISSUER = 'https://accounts.example.com'

describe('configFromEnv', () => {
  it('defaults to jwks mode', () => {
    const cfg = configFromEnv({})
    expect(cfg.mode).toBe('jwks')
    expect(cfg.audience).toBe(null)
  })

  it('honors LCM_SERVER_AUTH=insecure-noverify', () => {
    const cfg = configFromEnv({ LCM_SERVER_AUTH: 'insecure-noverify' })
    expect(cfg.mode).toBe('insecure-noverify')
  })

  it('reads LCM_SERVER_AUDIENCE', () => {
    const cfg = configFromEnv({ LCM_SERVER_AUDIENCE: 'my-aud' })
    expect(cfg.audience).toBe('my-aud')
  })
})

describe('createAuthorizer (jwks mode)', () => {
  let kid: string
  let privateKey: webcrypto.CryptoKey
  let jwksServer: Server
  let jwksUrl: string

  beforeAll(async () => {
    const kp = await generateKeyPair('RS256')
    privateKey = kp.privateKey
    kid = 'test-key-1'
    const pubJwk = await exportJWK(kp.publicKey)
    pubJwk.kid = kid
    pubJwk.alg = 'RS256'
    pubJwk.use = 'sig'
    const body = JSON.stringify({ keys: [pubJwk] })
    jwksServer = createServer((_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(body)
    })
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', () => resolve()))
    const addr = jwksServer.address() as AddressInfo
    jwksUrl = `http://127.0.0.1:${addr.port}/jwks`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => jwksServer.close(() => resolve()))
  })

  async function makeToken(over: {
    sub?: string
    aud?: string
    iss?: string
    expSecondsFromNow?: number
  } = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    return await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid })
      .setSubject(over.sub ?? 'user-123')
      .setAudience(over.aud ?? TEST_AUDIENCE)
      .setIssuer(over.iss ?? TEST_ISSUER)
      .setIssuedAt(now)
      .setExpirationTime(now + (over.expSecondsFromNow ?? 300))
      .sign(privateKey)
  }

  it('throws if audience is not set', () => {
    expect(() => createAuthorizer({ mode: 'jwks', audience: null })).toThrow(/LCM_SERVER_AUDIENCE/)
  })

  it('returns null userId when no Authorization header', async () => {
    const authz = createAuthorizer({
      mode: 'jwks',
      audience: TEST_AUDIENCE,
      jwksUrl,
      issuers: [TEST_ISSUER],
    })
    expect(await authz(reqWithAuth(undefined))).toEqual({ userId: null })
  })

  it('returns null userId for malformed bearer', async () => {
    const authz = createAuthorizer({
      mode: 'jwks',
      audience: TEST_AUDIENCE,
      jwksUrl,
      issuers: [TEST_ISSUER],
    })
    expect(await authz(reqWithAuth('Bearer not-a-jwt'))).toEqual({ userId: null })
  })

  it('verifies a valid token and returns sub', async () => {
    const authz = createAuthorizer({
      mode: 'jwks',
      audience: TEST_AUDIENCE,
      jwksUrl,
      issuers: [TEST_ISSUER],
    })
    const token = await makeToken({ sub: 'user-abc' })
    expect(await authz(reqWithAuth(`Bearer ${token}`))).toEqual({ userId: 'user-abc' })
  })

  it('rejects token with wrong audience', async () => {
    const authz = createAuthorizer({
      mode: 'jwks',
      audience: TEST_AUDIENCE,
      jwksUrl,
      issuers: [TEST_ISSUER],
    })
    const token = await makeToken({ aud: 'wrong-audience' })
    expect(await authz(reqWithAuth(`Bearer ${token}`))).toEqual({ userId: null })
  })

  it('rejects token with wrong issuer', async () => {
    const authz = createAuthorizer({
      mode: 'jwks',
      audience: TEST_AUDIENCE,
      jwksUrl,
      issuers: [TEST_ISSUER],
    })
    const token = await makeToken({ iss: 'https://evil.example.com' })
    expect(await authz(reqWithAuth(`Bearer ${token}`))).toEqual({ userId: null })
  })

  it('rejects expired token', async () => {
    const authz = createAuthorizer({
      mode: 'jwks',
      audience: TEST_AUDIENCE,
      jwksUrl,
      issuers: [TEST_ISSUER],
    })
    const token = await makeToken({ expSecondsFromNow: -10 })
    expect(await authz(reqWithAuth(`Bearer ${token}`))).toEqual({ userId: null })
  })
})

describe('createAuthorizer (insecure-noverify)', () => {
  it('decodes JWT payload sub without signature check', async () => {
    const authz = createAuthorizer({ mode: 'insecure-noverify', audience: null })
    // base64url JSON: {"sub":"user-xyz"}
    const payload = Buffer.from(JSON.stringify({ sub: 'user-xyz' }), 'utf8').toString('base64url')
    const token = `aaa.${payload}.bbb`
    expect(await authz(reqWithAuth(`Bearer ${token}`))).toEqual({ userId: 'user-xyz' })
  })

  it('falls back to email if no sub', async () => {
    const authz = createAuthorizer({ mode: 'insecure-noverify', audience: null })
    const payload = Buffer.from(JSON.stringify({ email: 'a@b.com' }), 'utf8').toString('base64url')
    const token = `aaa.${payload}.bbb`
    expect(await authz(reqWithAuth(`Bearer ${token}`))).toEqual({ userId: 'a@b.com' })
  })

  it('falls back to raw token when JWT body not parseable', async () => {
    const authz = createAuthorizer({ mode: 'insecure-noverify', audience: null })
    expect(await authz(reqWithAuth('Bearer plain-token'))).toEqual({ userId: 'plain-token' })
  })

  it('returns null when no Authorization header', async () => {
    const authz = createAuthorizer({ mode: 'insecure-noverify', audience: null })
    expect(await authz(reqWithAuth(undefined))).toEqual({ userId: null })
  })
})
