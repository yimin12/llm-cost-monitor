import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Pool } from '../../storage/connect'
import { createTestDatabase, dropTestDatabase } from '../../storage/__tests__/test-helpers'
import { NodeIdentityRepository } from '../node-identity'

describe('NodeIdentityRepository', () => {
  let pool: Pool
  let dbName: string

  beforeAll(async () => {
    const created = await createTestDatabase()
    pool = created.pool
    dbName = created.dbName
  })

  afterAll(async () => {
    await dropTestDatabase(pool, dbName)
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM local_node')
  })

  it('creates a row on first ensure() and returns it', async () => {
    const repo = new NodeIdentityRepository(pool, {
      platform: 'linux',
      appVersion: '0.1.2',
      newId: () => 'fixed-id-1',
      now: () => 1_700_000_000_000,
    })
    const id = await repo.ensure()
    expect(id.nodeId).toBe('fixed-id-1')
    expect(id.platform).toBe('linux')
    expect(id.appVersion).toBe('0.1.2')
    expect(id.createdAt).toBe(1_700_000_000_000)
  })

  it('returns the same node id on subsequent ensure() calls', async () => {
    const repo = new NodeIdentityRepository(pool, { newId: () => 'fixed-id-2' })
    const a = await repo.ensure()
    const b = await repo.ensure()
    expect(a.nodeId).toBe(b.nodeId)
  })

  it('does not regenerate the id even if the random source would change', async () => {
    let counter = 0
    const repo = new NodeIdentityRepository(pool, {
      newId: () => `id-${counter++}`,
    })
    const first = await repo.ensure()
    const second = await repo.ensure()
    expect(second.nodeId).toBe(first.nodeId)
    expect(counter).toBe(1) // newId only invoked on the first call
  })

  it('touches last_active_at without changing identity', async () => {
    let now = 1_000
    const repo = new NodeIdentityRepository(pool, {
      newId: () => 'stable',
      now: () => now,
    })
    const created = await repo.ensure()
    now = 5_000
    await repo.touch()
    const after = await repo.ensure()
    expect(after.nodeId).toBe(created.nodeId)
    expect(after.lastActiveAt).toBeGreaterThanOrEqual(5_000)
  })

  it('persists a display name set via setDisplayName', async () => {
    const repo = new NodeIdentityRepository(pool, { newId: () => 'a' })
    await repo.ensure()
    await repo.setDisplayName('work-laptop')
    const after = await repo.ensure()
    expect(after.displayName).toBe('work-laptop')
  })
})
