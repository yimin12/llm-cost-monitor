import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectOpenAIPlan } from '../plan'

// Build an unsigned-but-decodable JWT (jose.decodeJwt does not verify).
function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`
}

describe('detectOpenAIPlan', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lcm-codex-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns "none" when no auth.json and no env key', async () => {
    const plan = await detectOpenAIPlan({ codexHome: dir, env: {} })
    expect(plan.authMode).toBe('none')
  })

  it('reads ChatGPT plan tier from id_token JWT', async () => {
    const idToken = fakeJwt({
      email: 'c@example.com',
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
    })
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({
        OPENAI_API_KEY: null,
        auth_mode: 'chatgpt',
        tokens: { id_token: idToken, access_token: 'a', refresh_token: 'r' },
      }),
    )
    const plan = await detectOpenAIPlan({ codexHome: dir, env: {} })
    expect(plan.authMode).toBe('subscription')
    expect(plan.planName).toBe('Plus')
    expect(plan.detail).toBe('c@example.com')
  })

  it('labels Pro/Team/Enterprise tiers correctly', async () => {
    for (const [raw, expected] of [
      ['pro', 'Pro'],
      ['team', 'Team'],
      ['enterprise', 'Enterprise'],
      ['business', 'Business'],
    ] as const) {
      const idToken = fakeJwt({
        'https://api.openai.com/auth': { chatgpt_plan_type: raw },
      })
      await writeFile(
        join(dir, 'auth.json'),
        JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: idToken } }),
      )
      const plan = await detectOpenAIPlan({ codexHome: dir, env: {} })
      expect(plan.planName).toBe(expected)
    }
  })

  it('reports API key when auth_mode=apikey', async () => {
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-xxx', auth_mode: 'apikey', tokens: null }),
    )
    const plan = await detectOpenAIPlan({ codexHome: dir, env: {} })
    expect(plan.authMode).toBe('apiKey')
  })

  it('reports API key when only OPENAI_API_KEY env is set', async () => {
    const plan = await detectOpenAIPlan({
      codexHome: dir,
      env: { OPENAI_API_KEY: 'sk-xxx' },
    })
    expect(plan.authMode).toBe('apiKey')
    expect(plan.source).toBe('OPENAI_API_KEY env')
  })

  it('returns "unknown" when chatgpt mode but id_token missing', async () => {
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a' } }),
    )
    const plan = await detectOpenAIPlan({ codexHome: dir, env: {} })
    expect(plan.authMode).toBe('unknown')
    expect(plan.detail).toContain('id_token')
  })

  it('falls back to ChatGPT label when JWT has no plan_type claim', async () => {
    const idToken = fakeJwt({ email: 'c@example.com' })
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: idToken } }),
    )
    const plan = await detectOpenAIPlan({ codexHome: dir, env: {} })
    expect(plan.authMode).toBe('subscription')
    expect(plan.planName).toBe('ChatGPT')
  })
})
