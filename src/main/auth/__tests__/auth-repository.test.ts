import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { AuthUser } from '@shared/auth'
import type { Pool } from '../../storage/connect'
import {
  createTestDatabase,
  dropTestDatabase,
} from '../../storage/__tests__/test-helpers'
import { AuthRepository } from '../auth-repository'

function makeUser(partial: Partial<AuthUser> & Pick<AuthUser, 'sub' | 'email'>): AuthUser {
  return {
    emailVerified: true,
    name: 'Test User',
    pictureUrl: null,
    lastSignedInAt: 1_700_000_000_000,
    ...partial,
  }
}

describe('AuthRepository (Postgres)', () => {
  let pool: Pool
  let dbName: string
  let repo: AuthRepository

  beforeAll(async () => {
    const ctx = await createTestDatabase()
    pool = ctx.pool
    dbName = ctx.dbName
  }, 30_000)

  afterAll(async () => {
    await dropTestDatabase(pool, dbName)
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE auth_user')
    repo = new AuthRepository(pool)
  })

  it('schema_version is at v2+ after migrations (auth user table exists)', async () => {
    const r = await pool.query<{ max: number }>(
      'SELECT MAX(version) AS max FROM schema_version',
    )
    expect(r.rows[0]?.max ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('upsertActive + findActive round-trip', async () => {
    const user = makeUser({
      sub: 'google-sub-1',
      email: 'me@example.com',
      pictureUrl: 'https://example.com/avatar.png',
    })
    await repo.upsertActive(user)
    const found = await repo.findActive()
    expect(found).toEqual(user)
  })

  it('upsertActive demotes any prior active user', async () => {
    await repo.upsertActive(makeUser({ sub: 'sub-A', email: 'a@example.com' }))
    await repo.upsertActive(makeUser({ sub: 'sub-B', email: 'b@example.com' }))

    const r = await pool.query<{ sub: string; is_active: boolean }>(
      'SELECT sub, is_active FROM auth_user ORDER BY sub',
    )
    expect(r.rows).toHaveLength(2)
    expect(r.rows.find((row) => row.sub === 'sub-A')?.is_active).toBe(false)
    expect(r.rows.find((row) => row.sub === 'sub-B')?.is_active).toBe(true)

    const active = await repo.findActive()
    expect(active?.sub).toBe('sub-B')
  })

  it('clearActive flips active row but preserves history', async () => {
    await repo.upsertActive(makeUser({ sub: 'sub-A', email: 'a@example.com' }))
    await repo.clearActive()

    expect(await repo.findActive()).toBeNull()

    const r = await pool.query<{ sub: string; is_active: boolean }>(
      'SELECT sub, is_active FROM auth_user',
    )
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]?.is_active).toBe(false)
  })

  it('re-upsertActive on the same sub flips it back active', async () => {
    const user = makeUser({ sub: 'sub-A', email: 'a@example.com' })
    await repo.upsertActive(user)
    await repo.clearActive()
    await repo.upsertActive({ ...user, lastSignedInAt: 1_800_000_000_000 })

    const found = await repo.findActive()
    expect(found?.sub).toBe('sub-A')
    expect(found?.lastSignedInAt).toBe(1_800_000_000_000)
  })
})
