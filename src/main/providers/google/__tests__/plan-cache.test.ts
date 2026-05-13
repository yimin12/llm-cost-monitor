import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { formatCacheAge, loadCachedPlan, saveCachedPlan } from '../plan-cache'

describe('plan-cache', () => {
  let dir: string
  let cachePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lcm-google-plan-'))
    cachePath = join(dir, 'google-plan-cache.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('loadCachedPlan returns null when the file does not exist', async () => {
    expect(await loadCachedPlan(cachePath)).toBeNull()
  })

  it('round-trips a saved plan', async () => {
    const now = Date.UTC(2026, 4, 11, 12, 0, 0)
    await saveCachedPlan(
      cachePath,
      { tier: 'Pro', isPaid: true, email: 'me@example.com' },
      () => now,
    )
    const loaded = await loadCachedPlan(cachePath, () => now + 60_000)
    expect(loaded).toEqual({
      tier: 'Pro',
      isPaid: true,
      email: 'me@example.com',
      detectedAt: now,
    })
  })

  it('returns null when the cache is older than the 30-day TTL', async () => {
    const past = Date.UTC(2026, 3, 1)
    const now = Date.UTC(2026, 5, 1) // ~61 days later
    await saveCachedPlan(
      cachePath,
      { tier: 'Pro', isPaid: true, email: null },
      () => past,
    )
    expect(await loadCachedPlan(cachePath, () => now)).toBeNull()
  })

  it('returns null on malformed JSON', async () => {
    await writeFile(cachePath, '{ not json', 'utf8')
    expect(await loadCachedPlan(cachePath)).toBeNull()
  })

  it('returns null when required fields are missing', async () => {
    await writeFile(cachePath, JSON.stringify({ tier: 'Pro' }), 'utf8')
    expect(await loadCachedPlan(cachePath)).toBeNull()
  })

  it('saveCachedPlan creates intermediate directories', async () => {
    const nested = join(dir, 'a', 'b', 'c', 'cache.json')
    await saveCachedPlan(
      nested,
      { tier: 'Ultra', isPaid: true, email: 'u@x.y' },
      () => 1,
    )
    const raw = JSON.parse(await readFile(nested, 'utf8')) as { tier: string }
    expect(raw.tier).toBe('Ultra')
  })

  it('formatCacheAge surfaces a human-friendly delta', () => {
    const t = Date.UTC(2026, 4, 11, 12, 0, 0)
    expect(formatCacheAge(t, t + 30 * 60_000)).toBe('cached 30m ago')
    expect(formatCacheAge(t, t + 3 * 3600_000)).toBe('cached 3h ago')
    expect(formatCacheAge(t, t + 5 * 86_400_000)).toBe('cached 5d ago')
  })
})
