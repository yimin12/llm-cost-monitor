import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { AlertFilter } from '@shared/alerts'

import type { Aggregator } from '../aggregation/aggregator'
import type { AlertRepository } from '../alerts/alert-repository'
import type { PricingTable } from '../pricing/pricing-table'
import type { ProviderRegistry } from '../providers/registry'
import type { SettingsStore } from '../settings/store'
import type { EventRepository } from '../storage/event-repository'
import { scanYield } from '../git/git-scanner'
import { fetchTeamOverview } from '../sync/team-overview-client'
import type { AuthService } from '../auth/auth-service'

// Loopback HTTP API that mirrors the read-only window.api surface
// over plain JSON. Lets the renderer hit real data when it's opened
// in a regular browser tab (where Electron's IPC bridge isn't
// injected). Bound to 127.0.0.1 only — never reachable from the LAN.
//
// JSON wire format note: cost fields are `bigint` in the main-process
// types. JSON.stringify can't natively serialize bigint, so we tag
// every bigint as the string "<digits>n" via a replacer; the browser
// stub reverses with a matching reviver. Renderer code receives real
// `bigint` values whether the data came via Electron IPC or HTTP.

export interface WebApiDeps {
  aggregator: Aggregator
  events: EventRepository
  providers: ProviderRegistry
  pricing: PricingTable
  alerts: AlertRepository
  settings: SettingsStore
  auth: AuthService
}

const DEFAULT_PORT = Number(process.env['LCM_WEB_API_PORT'] ?? 4_018)
const ALLOWED_ORIGIN_DEV = 'http://localhost:5173'

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}n`
  return value
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN_DEV)
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.end(JSON.stringify(body, jsonReplacer))
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebApiDeps,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN_DEV)
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' })
    return
  }

  switch (path) {
    case '/healthz':
      sendJson(res, 200, { ok: true })
      return

    case '/v1/aggregates':
      sendJson(res, 200, await deps.aggregator.snapshot())
      return

    case '/v1/storage':
      sendJson(res, 200, { eventCount: await deps.events.count() })
      return

    case '/v1/providers':
      sendJson(res, 200, await deps.providers.describe())
      return

    case '/v1/pricing':
      sendJson(res, 200, {
        snapshotVersion: deps.pricing.snapshotVersion,
        modelCount: deps.pricing.modelCount,
      })
      return

    case '/v1/settings':
      sendJson(res, 200, deps.settings.get())
      return

    case '/v1/auth':
      sendJson(res, 200, deps.auth.current())
      return

    case '/v1/alerts/summary':
      sendJson(res, 200, await deps.alerts.summary())
      return

    case '/v1/alerts': {
      const raw = url.searchParams.get('filter')
      const filter: AlertFilter =
        raw === 'resolved' || raw === 'all' ? raw : 'open'
      sendJson(res, 200, await deps.alerts.list(filter))
      return
    }

    case '/v1/team-overview': {
      const cfg = deps.settings.get().teamSync
      if (!cfg.enabled || cfg.teamId === null) {
        sendJson(res, 200, null)
        return
      }
      const baseUrl = deps.settings.effectiveSyncUrl()
      if (baseUrl === null) {
        sendJson(res, 200, null)
        return
      }
      const token = await deps.auth.accessTokenForSync().catch(() => null)
      const overview = await fetchTeamOverview({ baseUrl, teamId: cfg.teamId, accessToken: token })
      sendJson(res, 200, overview)
      return
    }

    case '/v1/yield-score': {
      const periodRaw = url.searchParams.get('period') ?? '30d'
      const period: '7d' | '30d' | '90d' =
        periodRaw === '7d' || periodRaw === '90d' ? periodRaw : '30d'
      const PERIOD_MS: Record<typeof period, number> = {
        '7d': 7 * 24 * 3600_000,
        '30d': 30 * 24 * 3600_000,
        '90d': 90 * 24 * 3600_000,
      }
      const now = Date.now()
      const windowStartMs = now - PERIOD_MS[period]
      const enabled = deps.settings.get().privacy?.trackGitActivity === true
      if (!enabled) {
        sendJson(res, 200, {
          period,
          windowStartMs,
          generatedAt: now,
          durationMs: 0,
          totalCommits: 0,
          totalMerges: 0,
          costMicroUsd: '0',
          microPerCommit: null,
          repos: [],
          enabled: false,
        })
        return
      }
      const [scan, total] = await Promise.all([
        scanYield(windowStartMs),
        deps.aggregator.rangeTotal(windowStartMs, now),
      ])
      const microPerCommit =
        scan.totalCommits > 0
          ? (total.costMicroUsd / BigInt(scan.totalCommits)).toString()
          : null
      sendJson(res, 200, {
        period,
        windowStartMs,
        generatedAt: scan.scannedAt,
        durationMs: scan.durationMs,
        totalCommits: scan.totalCommits,
        totalMerges: scan.totalMerges,
        costMicroUsd: total.costMicroUsd.toString(),
        microPerCommit,
        repos: scan.repos,
        enabled: true,
      })
      return
    }

    default:
      sendJson(res, 404, { error: 'not_found' })
  }
}

export function startWebApiServer(deps: WebApiDeps, port: number = DEFAULT_PORT): Server {
  const server = createServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      console.error('[web-api] unhandled', err)
      try {
        sendJson(res, 500, { error: 'internal' })
      } catch {
        /* socket already gone */
      }
    })
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`[web-api] listening on http://127.0.0.1:${port}`)
  })
  return server
}
