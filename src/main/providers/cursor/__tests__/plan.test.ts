import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { detectCursorPlan } from '../plan'

async function makeJwt(claims: Record<string, string>): Promise<string> {
  const key = new TextEncoder().encode('test-secret-no-verify')
  return new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().sign(key)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('detectCursorPlan', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lcm-cursor-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns "none" when no IDE token, no auth.json, no env key', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const plan = await detectCursorPlan({
      cursorStateDb: join(dir, 'absent.vscdb'),
      cursorHome: dir,
      env: {},
      readAccessToken: async () => null,
      fetchImpl,
    })
    expect(plan.authMode).toBe('none')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('detects Pro tier from /api/auth/stripe using IDE token', async () => {
    const jwt = await makeJwt({ sub: 'user_abc', email: 'me@example.com' })
    const calls: { url: string; cookie: string | null }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const cookie = (init?.headers as Record<string, string>)['Cookie'] ?? null
      calls.push({ url, cookie })
      return jsonResponse({ individualMembershipType: 'pro', isTeamMember: false })
    }) as unknown as typeof fetch

    const plan = await detectCursorPlan({
      cursorStateDb: '/dev/null/state.vscdb',
      cursorHome: dir,
      env: {},
      readAccessToken: async () => jwt,
      fetchImpl,
    })

    expect(plan.authMode).toBe('subscription')
    expect(plan.planName).toBe('Pro')
    expect(plan.detail).toBe('me@example.com')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://cursor.com/api/auth/stripe')
    expect(calls[0]!.cookie).toBe(`WorkosCursorSessionToken=user_abc::${jwt}`)
  })

  it('handles `userId::token` prefix already on the stored token', async () => {
    const jwt = await makeJwt({ sub: 'sub_from_jwt' })
    const stored = `prefix_uid::${jwt}`
    let seenCookie = ''
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenCookie = (init?.headers as Record<string, string>)['Cookie'] ?? ''
      return jsonResponse({ individualMembershipType: 'ultra' })
    }) as unknown as typeof fetch

    const plan = await detectCursorPlan({
      cursorStateDb: '/dev/null',
      cursorHome: dir,
      env: {},
      readAccessToken: async () => stored,
      fetchImpl,
    })
    expect(plan.planName).toBe('Ultra')
    expect(seenCookie).toContain('prefix_uid::')
  })

  it('maps `pro_plus` to "Pro+"', async () => {
    const jwt = await makeJwt({ sub: 'u' })
    const fetchImpl = (async () =>
      jsonResponse({ individualMembershipType: 'pro_plus' })) as unknown as typeof fetch

    const plan = await detectCursorPlan({
      cursorStateDb: '/dev/null',
      cursorHome: dir,
      env: {},
      readAccessToken: async () => jwt,
      fetchImpl,
    })
    expect(plan.planName).toBe('Pro+')
  })

  it('upgrades to Team when isTeamMember=true and /me says team', async () => {
    const jwt = await makeJwt({ sub: 'u', email: 'x@y.z' })
    const fetchImpl = (async (url: string) => {
      if (url.includes('stripe')) {
        return jsonResponse({ individualMembershipType: 'pro', isTeamMember: true })
      }
      return jsonResponse({ plan: 'team' })
    }) as unknown as typeof fetch

    const plan = await detectCursorPlan({
      cursorStateDb: '/dev/null',
      cursorHome: dir,
      env: {},
      readAccessToken: async () => jwt,
      fetchImpl,
    })
    expect(plan.planName).toBe('Team')
  })

  it('upgrades to Enterprise when /me.plan contains "enterprise"', async () => {
    const jwt = await makeJwt({ sub: 'u' })
    const fetchImpl = (async (url: string) => {
      if (url.includes('stripe')) {
        return jsonResponse({ individualMembershipType: 'pro', isTeamMember: true })
      }
      return jsonResponse({ plan: 'enterprise' })
    }) as unknown as typeof fetch

    const plan = await detectCursorPlan({
      cursorStateDb: '/dev/null',
      cursorHome: dir,
      env: {},
      readAccessToken: async () => jwt,
      fetchImpl,
    })
    expect(plan.planName).toBe('Enterprise')
  })

  it('falls back to oauth label when Stripe endpoint is unreachable', async () => {
    const jwt = await makeJwt({ sub: 'u', email: 'me@x.y' })
    const fetchImpl = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof fetch

    const plan = await detectCursorPlan({
      cursorStateDb: '/dev/null',
      cursorHome: dir,
      env: {},
      readAccessToken: async () => jwt,
      fetchImpl,
    })
    expect(plan.authMode).toBe('oauth')
    expect(plan.planName).toBe('Cursor Account')
    expect(plan.detail).toBe('me@x.y')
  })

  it('falls back to legacy cursor-agent auth.json when IDE store is empty', async () => {
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ plan: 'pro', email: 'agent@x', tokens: { access_token: 't' } }),
    )
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const plan = await detectCursorPlan({
      cursorStateDb: '/dev/null',
      cursorHome: dir,
      env: {},
      readAccessToken: async () => null,
      fetchImpl,
    })
    expect(plan.authMode).toBe('subscription')
    expect(plan.planName).toBe('Pro')
    expect(plan.source).toBe(join(dir, 'auth.json'))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('detects API key from CURSOR_API_KEY env var', async () => {
    const plan = await detectCursorPlan({
      cursorStateDb: '/dev/null',
      cursorHome: dir,
      env: { CURSOR_API_KEY: 'sk-cur-xxx' },
      readAccessToken: async () => null,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })
    expect(plan.authMode).toBe('apiKey')
    expect(plan.planName).toBe('API key')
    expect(plan.source).toBe('CURSOR_API_KEY env')
  })
})
