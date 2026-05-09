import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// One-shot loopback HTTP server bound to 127.0.0.1 on an OS-assigned port.
// Resolves with the parsed query string from the first GET request received,
// then shuts down. Times out cleanly if no request arrives.

export interface LoopbackOptions {
  // Path the OAuth provider is expected to redirect to. Default `/callback`.
  callbackPath?: string
  // How long to wait for the callback before rejecting. Default 5 minutes.
  timeoutMs?: number
}

export interface LoopbackResult {
  port: number
  query: URLSearchParams
}

const SUCCESS_BODY = `<!doctype html>
<html><head><meta charset="utf-8"><title>llm-cost-monitor — sign-in complete</title>
<style>body{font:14px -apple-system,Segoe UI,Roboto,sans-serif;color:#333;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{padding:32px 40px;border:1px solid #e1e4e8;border-radius:12px;
text-align:center;max-width:380px}
h1{font-size:18px;margin:0 0 12px}
p{margin:0;color:#666}</style></head>
<body><div class="card"><h1>✓ Signed in</h1>
<p>You can close this tab and return to llm-cost-monitor.</p></div></body></html>`

const ERROR_BODY = `<!doctype html>
<html><head><meta charset="utf-8"><title>llm-cost-monitor — sign-in error</title></head>
<body><h1>Sign-in error</h1><p>Check the app for details.</p></body></html>`

// Bind first, then call `listen.address()` to learn the chosen port. The auth
// URL gets built using that port, which is then handed to the system browser.
// Caller must `start()` to bind, then `await waitForCallback()` once the user
// finishes the redirect, then `close()`.
export class LoopbackCallbackServer {
  private server: Server | null = null
  private resolveCallback: ((result: LoopbackResult) => void) | null = null
  private rejectCallback: ((err: Error) => void) | null = null
  private port = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly opts: LoopbackOptions = {}) {}

  async start(): Promise<number> {
    if (this.server !== null) return this.port
    const callbackPath = this.opts.callbackPath ?? '/callback'
    this.server = createServer((req, res) => {
      try {
        if (req.method !== 'GET' || req.url === undefined) {
          res.writeHead(405).end()
          return
        }
        const url = new URL(req.url, `http://127.0.0.1:${this.port}`)
        if (url.pathname !== callbackPath) {
          res.writeHead(404).end()
          return
        }
        if (url.searchParams.has('error')) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(ERROR_BODY)
        } else {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SUCCESS_BODY)
        }
        if (this.resolveCallback !== null) {
          this.resolveCallback({ port: this.port, query: url.searchParams })
          this.resolveCallback = null
          this.rejectCallback = null
        }
      } catch (err) {
        res.writeHead(500).end()
        if (this.rejectCallback !== null) {
          this.rejectCallback(err as Error)
          this.resolveCallback = null
          this.rejectCallback = null
        }
      }
    })

    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        reject(err)
      }
      this.server?.once('error', onError)
      this.server?.listen({ host: '127.0.0.1', port: 0 }, () => {
        this.server?.removeListener('error', onError)
        const addr = this.server?.address() as AddressInfo | null
        if (addr === null || typeof addr === 'string') {
          reject(new Error('loopback: unexpected listen address'))
          return
        }
        this.port = addr.port
        resolve(this.port)
      })
    })
  }

  waitForCallback(): Promise<LoopbackResult> {
    return new Promise<LoopbackResult>((resolve, reject) => {
      this.resolveCallback = resolve
      this.rejectCallback = reject
      const timeoutMs = this.opts.timeoutMs ?? 5 * 60 * 1000
      this.timer = setTimeout(() => {
        if (this.rejectCallback !== null) {
          this.rejectCallback(new Error(`loopback: no callback within ${timeoutMs}ms`))
          this.resolveCallback = null
          this.rejectCallback = null
        }
      }, timeoutMs)
    }).finally(() => {
      if (this.timer !== null) {
        clearTimeout(this.timer)
        this.timer = null
      }
    })
  }

  close(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.server?.close()
    this.server = null
  }
}
