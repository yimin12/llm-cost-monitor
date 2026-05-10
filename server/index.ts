import { resolve } from 'node:path'

import { openPool, runServerMigrations } from './db'
import { createApp, defaultAuthorize } from './http'
import { TeamService } from './team-service'

const PORT = Number(process.env['LCM_SERVER_PORT'] ?? 4_017)
const MIGRATIONS_DIR = resolve(__dirname, '../server-migrations')

async function main(): Promise<void> {
  const pool = openPool()
  const status = await runServerMigrations(pool, MIGRATIONS_DIR)
  console.log(
    `[server] migrations applied: v${status.appliedVersion}` +
      (status.ranThisRun.length > 0 ? ` (ran ${status.ranThisRun.join(',')})` : ''),
  )

  const service = new TeamService(pool)
  const app = createApp({
    service,
    authorize: defaultAuthorize,
    log: (line) => console.log(`[server] ${line}`),
  })

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[server] listening on http://127.0.0.1:${PORT}`)
  })

  const shutdown = async (): Promise<void> => {
    console.log('[server] shutting down')
    app.close()
    await pool.end().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main().catch((err) => {
  console.error('[server] fatal:', err)
  process.exit(1)
})
