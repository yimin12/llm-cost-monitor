import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectCursorPlan } from '../plan'

describe('detectCursorPlan', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lcm-cursor-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns "none" when no auth file and no env key', async () => {
    const plan = await detectCursorPlan({ cursorHome: dir, env: {} })
    expect(plan.authMode).toBe('none')
    expect(plan.planName).toBeNull()
  })

  it('detects API key from CURSOR_API_KEY env var', async () => {
    const plan = await detectCursorPlan({
      cursorHome: dir,
      env: { CURSOR_API_KEY: 'sk-cur-xxx' },
    })
    expect(plan.authMode).toBe('apiKey')
    expect(plan.planName).toBe('API key')
    expect(plan.source).toBe('CURSOR_API_KEY env')
  })

  it('reads API key from auth.json (auth_mode=apikey)', async () => {
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', CURSOR_API_KEY: 'sk-x' }),
    )
    const plan = await detectCursorPlan({ cursorHome: dir, env: {} })
    expect(plan.authMode).toBe('apiKey')
    expect(plan.planName).toBe('API key')
  })

  it('reads subscription tier from auth.json with access_token', async () => {
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({
        auth_mode: 'subscription',
        plan: 'pro',
        email: 'me@example.com',
        tokens: { access_token: 'tok' },
      }),
    )
    const plan = await detectCursorPlan({ cursorHome: dir, env: {} })
    expect(plan.authMode).toBe('subscription')
    expect(plan.planName).toBe('Pro')
    expect(plan.detail).toBe('me@example.com')
  })

  it('falls back to oauth when access_token present but no tier label', async () => {
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({
        tokens: { access_token: 'tok', email: 'x@y.z' },
      }),
    )
    const plan = await detectCursorPlan({ cursorHome: dir, env: {} })
    expect(plan.authMode).toBe('oauth')
    expect(plan.planName).toBe('Cursor Account')
    expect(plan.detail).toBe('x@y.z')
  })
})
