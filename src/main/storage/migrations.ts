import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { Pool } from './connect'

// Postgres equivalent of the SQLite migration loop in `db.ts`. Each .sql file
// in `migrations/` is run in lexical order inside its own transaction; the
// file's filename rank determines the version. We bump `schema_version` from
// inside each file (see migrations/0001_init.sql), so re-running is safe.
//
// Convention: filename = `NNNN_descriptor.sql`, NNNN is zero-padded version.

export interface MigrationStatus {
  appliedVersion: number
  ranThisRun: number[]
}

export async function runMigrations(
  pool: Pool,
  migrationsDir: string,
): Promise<MigrationStatus> {
  // Ensure schema_version exists before checking it (chicken-and-egg on a
  // fresh DB — first migration creates the table itself, but its version
  // bookkeeping needs the table to already exist).
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`)

  const current = await currentVersion(pool)

  const files = (await readdir(migrationsDir))
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()

  const ranThisRun: number[] = []
  for (const f of files) {
    const v = parseInt(f.split('_')[0] ?? '0', 10)
    if (Number.isNaN(v) || v <= current) continue

    const sql = await readFile(join(migrationsDir, f), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('COMMIT')
      ranThisRun.push(v)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw new Error(`migration ${f} failed: ${(err as Error).message}`)
    } finally {
      client.release()
    }
  }

  return { appliedVersion: await currentVersion(pool), ranThisRun }
}

async function currentVersion(pool: Pool): Promise<number> {
  const r = await pool.query<{ max: number | null }>(
    `SELECT MAX(version) AS max FROM schema_version`,
  )
  return r.rows[0]?.max ?? 0
}
