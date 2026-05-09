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

describe('detectGooglePlan', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lcm-gemini-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns "none" when no creds and no env key', async () => {
    const plan = await detectGooglePlan({ geminiHome: dir, env: {} })
    expect(plan.authMode).toBe('none')
  })

  it('detects OAuth login and surfaces the email from the id_token', async () => {
    const idToken = fakeJwt({ email: 'g@example.com' })
    await writeFile(
      join(dir, 'oauth_creds.json'),
      JSON.stringify({ access_token: 'a', id_token: idToken, refresh_token: 'r' }),
    )
    const plan = await detectGooglePlan({ geminiHome: dir, env: {} })
    expect(plan.authMode).toBe('subscription')
    expect(plan.planName).toBe('Google Account')
    expect(plan.detail).toBe('g@example.com')
  })

  it('labels Workspace accounts (with hd claim) distinctly', async () => {
    const idToken = fakeJwt({ email: 'g@corp.com', hd: 'corp.com' })
    await writeFile(
      join(dir, 'oauth_creds.json'),
      JSON.stringify({ id_token: idToken }),
    )
    const plan = await detectGooglePlan({ geminiHome: dir, env: {} })
    expect(plan.planName).toBe('Workspace Account')
  })

  it('falls back to google_accounts.json for the email if JWT decode fails', async () => {
    await writeFile(join(dir, 'oauth_creds.json'), JSON.stringify({ id_token: 'not.a.jwt' }))
    await writeFile(
      join(dir, 'google_accounts.json'),
      JSON.stringify({ active: 'fallback@example.com' }),
    )
    const plan = await detectGooglePlan({ geminiHome: dir, env: {} })
    expect(plan.authMode).toBe('subscription')
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
    const plan = await detectGooglePlan({ geminiHome: dir, env: {} })
    expect(plan.authMode).toBe('unknown')
  })
})
