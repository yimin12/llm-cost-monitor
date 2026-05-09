import type { AuthUser } from '@shared/auth'
import type { Pool } from '../storage/connect'
import { namedQuery } from '../storage/db-utils'

interface AuthUserRow {
  sub: string
  email: string
  email_verified: boolean
  name: string | null
  picture_url: string | null
  last_signed_in_at: bigint
  is_active: boolean
}

function rowToUser(r: AuthUserRow): AuthUser {
  return {
    sub: r.sub,
    email: r.email,
    emailVerified: r.email_verified,
    name: r.name,
    pictureUrl: r.picture_url,
    lastSignedInAt: Number(r.last_signed_in_at),
  }
}

// Single-account-active model for v1: at most one row with is_active=TRUE.
// Sign-in upserts + flips that row's is_active. Sign-out clears is_active
// (we keep the row so future Slice "switch account" can flip it back).
export class AuthRepository {
  constructor(private readonly pool: Pool) {}

  async upsertActive(user: AuthUser): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Demote any other active rows.
      await client.query('UPDATE auth_user SET is_active = FALSE WHERE is_active = TRUE')
      const q = namedQuery(
        `INSERT INTO auth_user (sub, email, email_verified, name, picture_url, last_signed_in_at, is_active)
         VALUES (@sub, @email, @email_verified, @name, @picture_url, @last_signed_in_at, TRUE)
         ON CONFLICT (sub) DO UPDATE SET
           email = EXCLUDED.email,
           email_verified = EXCLUDED.email_verified,
           name = EXCLUDED.name,
           picture_url = EXCLUDED.picture_url,
           last_signed_in_at = EXCLUDED.last_signed_in_at,
           is_active = TRUE`,
        {
          sub: user.sub,
          email: user.email,
          email_verified: user.emailVerified,
          name: user.name,
          picture_url: user.pictureUrl,
          last_signed_in_at: BigInt(user.lastSignedInAt),
        },
      )
      await client.query(q.text, q.values)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async findActive(): Promise<AuthUser | null> {
    const r = await this.pool.query<AuthUserRow>(
      'SELECT * FROM auth_user WHERE is_active = TRUE ORDER BY last_signed_in_at DESC LIMIT 1',
    )
    const row = r.rows[0]
    return row === undefined ? null : rowToUser(row)
  }

  async clearActive(): Promise<void> {
    await this.pool.query('UPDATE auth_user SET is_active = FALSE WHERE is_active = TRUE')
  }
}
