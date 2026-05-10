import { resolve } from 'node:path'

import { openPool, runServerMigrations } from './db'

// Standalone migration runner — useful for CI and for spinning up the
// server database the very first time. Idempotent on re-runs.

async function main(): Promise<void> {
  const pool = openPool()
  const status = await runServerMigrations(pool, resolve(__dirname, '../server-migrations'))
  console.log(
    `migrations applied: v${status.appliedVersion}` +
      (status.ranThisRun.length > 0 ? ` (ran ${status.ranThisRun.join(',')})` : ''),
  )
  await pool.end()
}

void main().catch((err) => {
  console.error('migrate:', err)
  process.exit(1)
})
