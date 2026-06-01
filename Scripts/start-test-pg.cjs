#!/usr/bin/env node
// Spins up an embedded Postgres on 127.0.0.1:5433 for vitest. Test helpers
// in src/main/storage/__tests__/test-helpers.ts hard-code that endpoint;
// this script lets us run the DB-backed suite without Docker Desktop.
//
// Lifecycle:
//   - On launch: extract the bundled binaries to ./.embedded-pg/, run
//     initdb if missing, start postgres in the background.
//   - On exit (SIGINT/SIGTERM/normal): graceful stop.
const path = require('node:path')
const fs = require('node:fs')
const EmbeddedPostgres = require('embedded-postgres').default

const dataDir = path.join(__dirname, '..', '.embedded-pg', 'data')
fs.mkdirSync(path.dirname(dataDir), { recursive: true })

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'lcm',
  password: 'lcm_dev',
  port: 5433,
  persistent: true,
})

async function main() {
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    console.log('[test-pg] initdb…')
    await pg.initialise()
  }
  console.log('[test-pg] starting on 127.0.0.1:5433')
  await pg.start()
  // Ensure the database the tests open as MAINTENANCE_DSN exists.
  try {
    await pg.createDatabase('llm_cost_monitor')
  } catch (e) {
    if (!String(e.message ?? e).includes('already exists')) throw e
  }
  console.log('[test-pg] ready')

  const stop = async (sig) => {
    console.log(`[test-pg] ${sig}, stopping…`)
    try { await pg.stop() } catch {}
    process.exit(0)
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
  // Keep alive
  setInterval(() => {}, 1 << 30)
}

main().catch((err) => {
  console.error('[test-pg] fatal:', err)
  process.exit(1)
})
