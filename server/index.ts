import { resolve } from 'node:path'

import { configFromEnv, createAuthorizer } from './auth'
import { openPool, runServerMigrations } from './db'
import { createApp } from './http'
import { TeamService } from './team-service'

const PORT = Number(process.env['LCM_SERVER_PORT'] ?? 4_017)
// Default to loopback so `npm run server:dev` never exposes the API to
// the LAN. Containerized deploys set LCM_SERVER_BIND=0.0.0.0; the
// compose `ports:` mapping (`127.0.0.1:4017:4017` by default) is what
// gates external access.
const BIND = process.env['LCM_SERVER_BIND'] ?? '127.0.0.1'
const MIGRATIONS_DIR =
  process.env['LCM_SERVER_MIGRATIONS_DIR'] ?? resolve(__dirname, '../server-migrations')
// Cap on distinct devices (node_id) per (team, user). Operators can lift
// this for paid teams via env without a code change. NaN / non-positive
// values fall back to the TeamService default (5).
const MAX_DEVICES_PER_USER = Number(process.env['LCM_MAX_DEVICES_PER_USER'])

async function main(): Promise<void> {
  const pool = openPool()
  const status = await runServerMigrations(pool, MIGRATIONS_DIR)
  console.log(
    `[server] migrations applied: v${status.appliedVersion}` +
      (status.ranThisRun.length > 0 ? ` (ran ${status.ranThisRun.join(',')})` : ''),
  )

  const authCfg = configFromEnv()
  if (authCfg.mode === 'insecure-noverify') {
    console.warn(
      '[server] WARNING: LCM_SERVER_AUTH=insecure-noverify — JWTs are decoded without ' +
        'signature verification. Use only for local development. Production must set ' +
        'LCM_SERVER_AUTH=jwks and LCM_SERVER_AUDIENCE=<desktop oauth client_id>.',
    )
  }
  const authorize = createAuthorizer(authCfg)

  const service = new TeamService(
    pool,
    Number.isFinite(MAX_DEVICES_PER_USER) && MAX_DEVICES_PER_USER > 0
      ? { maxDevicesPerUser: MAX_DEVICES_PER_USER }
      : {},
  )
  console.log(
    `[server] device limit per user: ${
      Number.isFinite(MAX_DEVICES_PER_USER) && MAX_DEVICES_PER_USER > 0
        ? MAX_DEVICES_PER_USER
        : 5
    }`,
  )
  const app = createApp({
    service,
    authorize,
    log: (line) => console.log(`[server] ${line}`),
  })

  app.listen(PORT, BIND, () => {
    console.log(`[server] listening on http://${BIND}:${PORT}`)
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
