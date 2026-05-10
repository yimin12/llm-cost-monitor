import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the bundled module so we can flip "shipped a value / didn't" per test.
vi.mock('@shared/oauth-config', () => ({
  BUNDLED_GOOGLE_OAUTH: {
    clientId: '',
    clientSecret: '',
  },
}))

import { BUNDLED_GOOGLE_OAUTH } from '@shared/oauth-config'
import { loadAuthSecrets } from '../env-loader'

function writeEnv(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lcm-env-'))
  const path = join(dir, '.env')
  writeFileSync(path, content, 'utf8')
  return path
}

describe('loadAuthSecrets', () => {
  beforeEach(() => {
    // Each test sets the bundled values explicitly. Start from a known
    // empty state so tests don't leak into each other.
    BUNDLED_GOOGLE_OAUTH.clientId = ''
    BUNDLED_GOOGLE_OAUTH.clientSecret = ''
  })

  afterEach(() => {
    BUNDLED_GOOGLE_OAUTH.clientId = ''
    BUNDLED_GOOGLE_OAUTH.clientSecret = ''
  })

  it('returns null when neither env nor bundled has a clientId', () => {
    const path = writeEnv('# empty\n')
    expect(loadAuthSecrets(path)).toBeNull()
  })

  it('reads bundled values when env file is absent', () => {
    BUNDLED_GOOGLE_OAUTH.clientId = 'bundled.apps.googleusercontent.com'
    BUNDLED_GOOGLE_OAUTH.clientSecret = 'bundled-secret'
    // Point at a path that doesn't exist.
    const r = loadAuthSecrets('/tmp/lcm-does-not-exist.env')
    expect(r).toEqual({
      gcpClientId: 'bundled.apps.googleusercontent.com',
      gcpClientSecret: 'bundled-secret',
      source: 'bundled',
    })
  })

  it('env values override bundled defaults', () => {
    BUNDLED_GOOGLE_OAUTH.clientId = 'bundled.apps.googleusercontent.com'
    BUNDLED_GOOGLE_OAUTH.clientSecret = 'bundled-secret'
    const path = writeEnv(
      'GCP_CLIENTID=env.apps.googleusercontent.com\nGCP_CLIENTSECRET=env-secret\n',
    )
    const r = loadAuthSecrets(path)
    expect(r?.gcpClientId).toBe('env.apps.googleusercontent.com')
    expect(r?.gcpClientSecret).toBe('env-secret')
    expect(r?.source).toBe('env')
  })

  it('mixed: env clientId, bundled secret → source=mixed', () => {
    BUNDLED_GOOGLE_OAUTH.clientId = 'bundled.apps.googleusercontent.com'
    BUNDLED_GOOGLE_OAUTH.clientSecret = 'bundled-secret'
    const path = writeEnv('GCP_CLIENTID=env.apps.googleusercontent.com\n')
    const r = loadAuthSecrets(path)
    expect(r?.gcpClientId).toBe('env.apps.googleusercontent.com')
    expect(r?.gcpClientSecret).toBe('bundled-secret')
    expect(r?.source).toBe('mixed')
  })

  it('returns null secret when neither env nor bundled has one (PKCE-only)', () => {
    BUNDLED_GOOGLE_OAUTH.clientId = 'bundled.apps.googleusercontent.com'
    // clientSecret stays empty — pure PKCE flow.
    const r = loadAuthSecrets('/tmp/lcm-does-not-exist.env')
    expect(r?.gcpClientId).toBe('bundled.apps.googleusercontent.com')
    expect(r?.gcpClientSecret).toBeNull()
  })

  it('ignores empty-string env values (does not override with nothing)', () => {
    BUNDLED_GOOGLE_OAUTH.clientId = 'bundled.apps.googleusercontent.com'
    BUNDLED_GOOGLE_OAUTH.clientSecret = 'bundled-secret'
    const path = writeEnv('GCP_CLIENTID=\nGCP_CLIENTSECRET=\n')
    const r = loadAuthSecrets(path)
    expect(r?.gcpClientId).toBe('bundled.apps.googleusercontent.com')
    expect(r?.gcpClientSecret).toBe('bundled-secret')
  })

  it('skips comments and blank lines', () => {
    BUNDLED_GOOGLE_OAUTH.clientId = ''
    const path = writeEnv([
      '# a comment',
      '',
      'GCP_CLIENTID=ok.apps.googleusercontent.com',
      '   ',
      'GCP_CLIENTSECRET=ok-secret',
    ].join('\n'))
    const r = loadAuthSecrets(path)
    expect(r?.gcpClientId).toBe('ok.apps.googleusercontent.com')
    expect(r?.gcpClientSecret).toBe('ok-secret')
  })
})
