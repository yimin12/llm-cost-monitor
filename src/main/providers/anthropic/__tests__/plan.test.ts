import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectAnthropicPlan } from '../plan'

describe('detectAnthropicPlan', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lcm-claude-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns "none" when no creds and no API key', async () => {
    const plan = await detectAnthropicPlan({
      claudeHome: dir,
      env: {},
      platform: 'linux',
    })
    expect(plan.authMode).toBe('none')
    expect(plan.planName).toBeNull()
  })

  it('reads subscription tier from ~/.claude/.credentials.json on Linux', async () => {
    await writeFile(
      join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          subscriptionType: 'max',
          emailAddress: 'user@example.com',
          accessToken: 'tok',
        },
      }),
    )
    const plan = await detectAnthropicPlan({
      claudeHome: dir,
      env: {},
      platform: 'linux',
    })
    expect(plan.authMode).toBe('subscription')
    expect(plan.planName).toBe('Max')
    expect(plan.detail).toBe('user@example.com')
    expect(plan.source).toContain('.credentials.json')
  })

  it('reads subscription tier from macOS Keychain when present', async () => {
    const plan = await detectAnthropicPlan({
      claudeHome: dir,
      env: {},
      platform: 'darwin',
      readKeychain: async () =>
        JSON.stringify({
          claudeAiOauth: { subscriptionType: 'pro', emailAddress: 'm@example.com' },
        }),
    })
    expect(plan.authMode).toBe('subscription')
    expect(plan.planName).toBe('Pro')
    expect(plan.source).toBe('macOS Keychain')
  })

  it('falls back to .credentials.json when keychain read returns null', async () => {
    await writeFile(
      join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { subscriptionType: 'free' } }),
    )
    const plan = await detectAnthropicPlan({
      claudeHome: dir,
      env: {},
      platform: 'darwin',
      readKeychain: async () => null,
    })
    expect(plan.authMode).toBe('subscription')
    expect(plan.planName).toBe('Free')
  })

  it('reports API key when ANTHROPIC_API_KEY is set and no creds', async () => {
    const plan = await detectAnthropicPlan({
      claudeHome: dir,
      env: { ANTHROPIC_API_KEY: 'sk-ant-xxx' },
      platform: 'linux',
    })
    expect(plan.authMode).toBe('apiKey')
    expect(plan.source).toBe('ANTHROPIC_API_KEY env')
  })

  it('prefers subscription over API key when both are present', async () => {
    await writeFile(
      join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { subscriptionType: 'max' } }),
    )
    const plan = await detectAnthropicPlan({
      claudeHome: dir,
      env: { ANTHROPIC_API_KEY: 'sk-ant-xxx' },
      platform: 'linux',
    })
    expect(plan.authMode).toBe('subscription')
  })

  it('returns "unknown" on malformed JSON', async () => {
    await writeFile(join(dir, '.credentials.json'), '{not json')
    const plan = await detectAnthropicPlan({
      claudeHome: dir,
      env: {},
      platform: 'linux',
    })
    expect(plan.authMode).toBe('unknown')
    expect(plan.detail).toContain('parse')
  })

  it('handles both "subscription" and "subscriptionType" field names', async () => {
    await writeFile(
      join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { subscription: 'team' } }),
    )
    const plan = await detectAnthropicPlan({
      claudeHome: dir,
      env: {},
      platform: 'linux',
    })
    expect(plan.authMode).toBe('subscription')
    expect(plan.planName).toBe('Team')
  })
})
