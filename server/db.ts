import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import pg from 'pg'

// Server-side Postgres pool. The desktop app uses its own DB
// (`llm_cost_monitor`); the server runs against a separate DB
// (`lcm_team_sync` by default) with the schema in server-migrations/.
//
// Same bigint-as-bigint stance as the desktop: we install a custom
// type parser so BIGINT round-trips through JS as bigint, not number,
// preserving cost precision past 2^53.

const BIGINT_OID = 20
pg.types.setTypeParser(BIGINT_OID, (v) => BigInt(v))

export type Pool = pg.Pool

export interface PoolOpts {
  connectionString?: string
  max?: number
}

export function openPool(opts: PoolOpts = {}): Pool {
  const cs =
    opts.connectionString ??
    process.env['LCM_SERVER_DSN'] ??
    'postgres://lcm:lcm_dev@127.0.0.1:5433/lcm_team_sync'
  const pool = new pg.Pool({ connectionString: cs, max: opts.max ?? 5 })
  // Without an 'error' listener, an idle-client failure (DB restart, network
  // blip) is re-emitted as an uncaught exception and crashes the process. The
  // pool recovers on its own, so log and move on.
  pool.on('error', (err: Error) => {
    console.warn(`server pg pool: idle client error (recovering): ${err.message}`)
  })
  return pool
}

// Same migration loop shape as src/main/storage/migrations.ts so the
// invariants stay obvious — files in server-migrations/, lexical order,
// each one in its own transaction, idempotent via IF NOT EXISTS.
export async function runServerMigrations(
  pool: Pool,
  migrationsDir: string,
): Promise<{ appliedVersion: number; ranThisRun: number[] }> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`)
  const r0 = await pool.query<{ max: number | null }>(
    `SELECT MAX(version) AS max FROM schema_version`,
  )
  const current = Number(r0.rows[0]?.max ?? 0)

  const files = (await readdir(migrationsDir))
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
  const ran: number[] = []
  for (const f of files) {
    const v = parseInt(f.split('_')[0] ?? '0', 10)
    if (Number.isNaN(v) || v <= current) continue
    const sql = await readFile(join(migrationsDir, f), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('COMMIT')
      ran.push(v)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw new Error(`server migration ${f} failed: ${(err as Error).message}`)
    } finally {
      client.release()
    }
  }
  const r1 = await pool.query<{ max: number | null }>(
    `SELECT MAX(version) AS max FROM schema_version`,
  )
  return { appliedVersion: Number(r1.rows[0]?.max ?? 0), ranThisRun: ran }
}
