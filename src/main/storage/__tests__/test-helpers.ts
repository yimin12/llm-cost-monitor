import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

import { openPool, type Pool } from '../connect'
import { runMigrations } from '../migrations'

const MAINTENANCE_DSN =
  process.env['LCM_TEST_MAINTENANCE_DSN'] ??
  'postgres://lcm:lcm_dev@127.0.0.1:5433/llm_cost_monitor'

const TEMPLATE_DSN_BASE =
  process.env['LCM_TEST_DSN_BASE'] ?? 'postgres://lcm:lcm_dev@127.0.0.1:5433'

function randomDbName(): string {
  return `lcm_test_${randomBytes(6).toString('hex')}`
}

const MIGRATIONS_DIR = resolve(__dirname, '../../../../migrations')

// Create a fresh isolated Postgres database and run migrations into it.
// Tests use this to get a clean slate without interfering with the dev DB.
// Caller MUST call `dropTestDatabase` after to avoid leaks.
export async function createTestDatabase(): Promise<{
  pool: Pool
  dbName: string
}> {
  const dbName = randomDbName()
  // Connect to the maintenance DB only long enough to issue CREATE DATABASE,
  // then immediately disconnect — pg can't drop a DB while a connection holds it.
  const admin = await openPool({ connectionString: MAINTENANCE_DSN })
  try {
    await admin.query(`CREATE DATABASE ${dbName}`)
  } finally {
    await admin.end().catch(() => {})
  }

  const pool = await openPool({
    connectionString: `${TEMPLATE_DSN_BASE}/${dbName}`,
  })
  await runMigrations(pool, MIGRATIONS_DIR)
  return { pool, dbName }
}

export async function dropTestDatabase(pool: Pool, dbName: string): Promise<void> {
  await pool.end().catch(() => {})
  const admin = await openPool({ connectionString: MAINTENANCE_DSN })
  try {
    // Force-disconnect any stragglers, then drop. WITH (FORCE) is Postgres 13+.
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
  } finally {
    await admin.end().catch(() => {})
  }
}
