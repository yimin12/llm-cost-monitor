import pg from 'pg'

// pg returns BIGINT (oid 20) as a string by default to avoid silent precision
// loss on values > 2^53. We want bigint everywhere — `computed_cost_micro_usd`
// crosses 2^53 in the long tail, and the rest of the codebase already passes
// bigint through IPC + storage. This parser is set once at module load time.
pg.types.setTypeParser(20, (v: string): bigint => BigInt(v))

export type Pool = pg.Pool
export const PoolCtor = pg.Pool

const DEFAULT_DSN =
  'postgres://lcm:lcm_dev@127.0.0.1:5433/llm_cost_monitor'

export interface ConnectOptions {
  // Override the connection string. Defaults to env DATABASE_URL or DEFAULT_DSN.
  connectionString?: string
  // Per-attempt timeout when establishing the first connection.
  connectTimeoutMs?: number
  // Total time we'll spend waiting for Postgres to be ready before giving up.
  // Postgres-in-Docker often takes 2–4 s after `docker compose up`.
  readyTimeoutMs?: number
}

function dsn(opts: ConnectOptions): string {
  return opts.connectionString ?? process.env['DATABASE_URL'] ?? DEFAULT_DSN
}

// Open a pg.Pool and wait for the first connection to succeed. Retries with
// exponential-ish backoff (capped at 1 s) until `readyTimeoutMs` elapses.
// Throws a descriptive error if Postgres never becomes reachable.
export async function openPool(opts: ConnectOptions = {}): Promise<Pool> {
  const connectionString = dsn(opts)
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: opts.connectTimeoutMs ?? 5_000,
    max: 8,
    idleTimeoutMillis: 30_000,
  })

  // An idle client can drop at any time — Postgres restart, the Docker
  // container hiccuping, a server-side idle timeout, or the laptop waking
  // from sleep. pg re-emits that as a pool 'error' event; with no listener
  // Node treats it as an uncaught exception and crashes the Electron main
  // process ("Connection terminated unexpectedly"). The pool self-heals
  // (discards the dead client, opens a fresh one on the next acquire), so we
  // only need to swallow the event and log it.
  pool.on('error', (err: Error) => {
    console.warn(`pg pool: idle client error (recovering): ${err.message}`)
  })

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 30_000)
  let lastErr: unknown
  let delay = 200
  while (Date.now() < deadline) {
    try {
      const client = await pool.connect()
      client.release()
      return pool
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(1_000, Math.floor(delay * 1.7))
    }
  }
  await pool.end().catch(() => {})
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  throw new Error(`Postgres unreachable after ${opts.readyTimeoutMs ?? 30_000}ms: ${msg}`)
}
