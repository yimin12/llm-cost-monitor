import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectGooglePlan } from '../plan'

function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`
}

// Default fetch stub: returns 404 so the Code Assist call falls back
// to the OIDC-only display. Tests that exercise the Pro / tier path
// pass their own mock instead.
const fetchNotFound: typeof fetch = async () =>
  new Response('', { status: 404 }) as unknown as Response

function mockFetchJson(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Response) as typeof fetch
}

describe('detectGooglePlan', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lcm-gemini-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns "none" when no creds and no env key', async () => {
    const plan = await detectGooglePlan({ geminiHome: dir, env: {}, fetchImpl: fetchNotFound })
    expect(plan.authMode).toBe('none')
  })

  it('detects OAuth login and surfaces the email from the id_token', async () => {
    const idToken = fakeJwt({ email: 'g@example.com' })
    await writeFile(
      join(dir, 'oauth_creds.json'),
      JSON.stringify({ access_token: 'a', id_token: idToken, refresh_token: 'r' }),
    )
    const plan = await detectGooglePlan({ geminiHome: dir, env: {}, fetchImpl: fetchNotFound })
    // OAuth — Gemini CLI's free tier login, NOT a paid subscription.
    expect(plan.authMode).toBe('oauth')
    expect(plan.planName).toBe('Google Account')
    expect(plan.detail).toBe('g@example.com')
  })

  it('labels Workspace accounts (with hd claim) distinctly', async () => {
    const idToken = fakeJwt({ email: 'g@corp.com', hd: 'corp.com' })
    await writeFile(
      join(dir, 'oauth_creds.json'),
      JSON.stringify({ id_token: idToken }),
    )
    const plan = await detectGooglePlan({ geminiHome: dir, env: {}, fetchImpl: fetchNotFound })
    expect(plan.planName).toBe('Workspace Account')
  })

  it('falls back to google_accounts.json for the email if JWT decode fails', async () => {
    await writeFile(join(dir, 'oauth_creds.json'), JSON.stringify({ id_token: 'not.a.jwt' }))
    await writeFile(
      join(dir, 'google_accounts.json'),
      JSON.stringify({ active: 'fallback@example.com' }),
    )
    const plan = await detectGooglePlan({ geminiHome: dir, env: {}, fetchImpl: fetchNotFound })
    expect(plan.authMode).toBe('oauth')
    expect(plan.detail).toBe('fallback@example.com')
  })

  it('reports API key when GEMINI_API_KEY is set', async () => {
    const plan = await detectGooglePlan({
      geminiHome: dir,
      env: { GEMINI_API_KEY: 'AIza-xxx' },
    })
    expect(plan.authMode).toBe('apiKey')
    expect(plan.source).toBe('GEMINI_API_KEY env')
  })

  it('also picks up GOOGLE_API_KEY', async () => {
    const plan = await detectGooglePlan({
      geminiHome: dir,
      env: { GOOGLE_API_KEY: 'AIza-xxx' },
    })
    expect(plan.authMode).toBe('apiKey')
    expect(plan.source).toBe('GOOGLE_API_KEY env')
  })

  it('returns "unknown" when oauth_creds.json exists but lacks id_token', async () => {
    await writeFile(join(dir, 'oauth_creds.json'), JSON.stringify({ access_token: 'a' }))
    const plan = await detectGooglePlan({ geminiHome: dir, env: {}, fetchImpl: fetchNotFound })
    expect(plan.authMode).toBe('unknown')
  })

  it('uses paidTier.name verbatim when Google provides one', async () => {
    const idToken = fakeJwt({ email: 'g@example.com' })
    await writeFile(
      join(dir, 'oauth_creds.json'),
      JSON.stringify({
        access_token: 'a',
        id_token: idToken,
        expiry_date: Date.now() + 60_000,
      }),
    )
    const plan = await detectGooglePlan({
      geminiHome: dir,
      env: {},
      fetchImpl: mockFetchJson({
        currentTier: { id: 'standard-tier', name: 'Gemini Code Assist Standard' },
        paidTier: { id: 'standard-tier', name: 'Gemini Code Assist in Google One AI Pro' },
      }),
    })
    expect(plan.authMode).toBe('subscription')
    // Exact label Google sends — matches the Gemini CLI's own banner.
    expect(plan.planName).toBe('Gemini Code Assist in Google One AI Pro')
    expect(plan.detail).toBe('g@example.com')
  })

  it('prefers currentTier.name over the tier-id fallback', async () => {
    const idToken = fakeJwt({ email: 'g@example.com' })
    await writeFile(
      join(dir, 'oauth_creds.json'),
      JSON.stringify({ access_token: 'a', id_token: idToken, expiry_date: Date.now() + 60_000 }),
    )
    const plan = await detectGooglePlan({
      geminiHome: dir,
      env: {},
      fetchImpl: mockFetchJson({
        currentTier: { id: 'free-tier', name: 'Gemini Code Assist Free' },
      }),
    })
    expect(plan.authMode).toBe('subscription')
    expect(plan.planName).toBe('Gemini Code Assist Free')
  })

  it('falls back to a tier-id label when Google omits name', async () => {
    const idToken = fakeJwt({ email: 'g@example.com' })
    await writeFile(
      join(dir, 'oauth_creds.json'),
      JSON.stringify({ access_token: 'a', id_token: idToken, expiry_date: Date.now() + 60_000 }),
    )
    const plan = await detectGooglePlan({
      geminiHome: dir,
      env: {},
      fetchImpl: mockFetchJson({ currentTier: { id: 'standard-tier' } }),
    })
    expect(plan.planName).toBe('Code Assist · Standard')
  })

  it('falls back to Google Account when the access token is expired (no Code Assist call attempted)', async () => {
    const idToken = fakeJwt({ email: 'g@example.com' })
    await writeFile(
      join(dir, 'oauth_creds.json'),
      JSON.stringify({ access_token: 'a', id_token: idToken, expiry_date: Date.now() - 60_000 }),
    )
    let called = false
    const plan = await detectGooglePlan({
      geminiHome: dir,
      env: {},
      fetchImpl: ((): typeof fetch => {
        const f: typeof fetch = async () => {
          called = true
          return new Response('', { status: 200 }) as unknown as Response
        }
        return f
      })(),
    })
    expect(called).toBe(false)
    expect(plan.authMode).toBe('oauth')
    expect(plan.planName).toBe('Google Account')
  })
})
