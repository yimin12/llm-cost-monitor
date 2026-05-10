import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

import { openPool, runServerMigrations, type Pool } from '../db'

const MAINTENANCE_DSN =
  process.env['LCM_TEST_MAINTENANCE_DSN'] ??
  'postgres://lcm:lcm_dev@127.0.0.1:5433/postgres'

const TEMPLATE_DSN_BASE =
  process.env['LCM_TEST_DSN_BASE'] ?? 'postgres://lcm:lcm_dev@127.0.0.1:5433'

function randomDbName(): string {
  return `lcm_srv_test_${randomBytes(6).toString('hex')}`
}

const MIGRATIONS_DIR = resolve(__dirname, '../../server-migrations')

// Same shape as src/main/storage/__tests__/test-helpers.ts: each test
// gets its own isolated database.
export async function createServerTestDatabase(): Promise<{ pool: Pool; dbName: string }> {
  const dbName = randomDbName()
  const admin = openPool({ connectionString: MAINTENANCE_DSN })
  try {
    await admin.query(`CREATE DATABASE ${dbName}`)
  } finally {
    await admin.end().catch(() => {})
  }
  const pool = openPool({ connectionString: `${TEMPLATE_DSN_BASE}/${dbName}` })
  await runServerMigrations(pool, MIGRATIONS_DIR)
  return { pool, dbName }
}

export async function dropServerTestDatabase(pool: Pool, dbName: string): Promise<void> {
  await pool.end().catch(() => {})
  const admin = openPool({ connectionString: MAINTENANCE_DSN })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
  } finally {
    await admin.end().catch(() => {})
  }
}
