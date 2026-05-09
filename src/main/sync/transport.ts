import type { BatchUpsertResponse, SyncPayload } from '@shared/sync'

// Transport for POSTing batches to the team backend. Kept narrow and
// injectable so tests can swap a mock — the queue depends on this
// interface, not on global fetch.
export interface SyncTransport {
  batchUpsert(
    teamId: string,
    payloads: readonly SyncPayload[],
    accessToken: string | null,
  ): Promise<BatchUpsertResponse>
}

export class TransportError extends Error {
  // 'network' — DNS failure, connection refused, server down. Retryable.
  // 'server' — 5xx from server. Retryable.
  // 'auth' — 401/403. Stops the queue; user must re-auth.
  // 'client' — 4xx (other). Drops the batch and writes an audit row.
  // 'parse' — server returned malformed JSON. Treats as 'server' for retry.
  readonly kind: 'network' | 'server' | 'auth' | 'client' | 'parse'
  readonly status: number | null
  readonly retryable: boolean

  constructor(
    kind: TransportError['kind'],
    message: string,
    status: number | null = null,
  ) {
    super(message)
    this.name = 'TransportError'
    this.kind = kind
    this.status = status
    this.retryable = kind === 'network' || kind === 'server' || kind === 'parse'
  }
}

export interface HttpTransportOptions {
  // e.g. https://sync.example.com — trailing slash stripped.
  baseUrl: string
  // Override fetch for tests.
  fetchImpl?: typeof fetch
  // Default 15s. Aborted via AbortSignal.
  timeoutMs?: number
}

// Real implementation that talks to the backend over HTTPS.
export class HttpSyncTransport implements SyncTransport {
  private readonly base: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: HttpTransportOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 15_000
  }

  async batchUpsert(
    teamId: string,
    payloads: readonly SyncPayload[],
    accessToken: string | null,
  ): Promise<BatchUpsertResponse> {
    const url = `${this.base}/v1/teams/${encodeURIComponent(teamId)}/events:batchUpsert`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (accessToken !== null) headers['Authorization'] = `Bearer ${accessToken}`
      let res: Response
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ events: payloads }),
          signal: ctrl.signal,
        })
      } catch (err) {
        const msg = (err as Error).message
        throw new TransportError('network', msg)
      }

      if (res.status === 401 || res.status === 403) {
        throw new TransportError('auth', `auth failed (${res.status})`, res.status)
      }
      if (res.status >= 500) {
        throw new TransportError('server', `server error (${res.status})`, res.status)
      }
      if (res.status >= 400) {
        // Read at most a small slice of body for diagnostics; don't echo
        // unbounded server output into our logs.
        const body = await res.text().catch(() => '')
        throw new TransportError('client', `${res.status}: ${body.slice(0, 256)}`, res.status)
      }

      let parsed: BatchUpsertResponse
      try {
        parsed = (await res.json()) as BatchUpsertResponse
      } catch {
        throw new TransportError('parse', 'malformed JSON response', res.status)
      }
      return parsed
    } finally {
      clearTimeout(timer)
    }
  }
}
