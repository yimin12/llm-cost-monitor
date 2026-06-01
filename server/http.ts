import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { SyncPayload } from '../src/shared/sync'

import type { Authorizer } from './auth'
import { TeamService, TeamServiceError } from './team-service'

// Minimal HTTP layer using Node's built-in `http`. Two routes:
//   POST /v1/teams/:teamId/events:batchUpsert
//   GET  /v1/teams/:teamId/usage
// + GET /healthz for ops monitoring.
//
// We intentionally do NOT take a dependency on Express/Fastify/Hono —
// the server is small enough that a 60-line router keeps deps shallow
// and keeps `npm install` fast.
//
// Auth: the `authorize` callback is async because production mode runs
// JWKS-backed `jwtVerify` (see `./auth`). Tests inject a synchronous
// stub; `await` on a non-Promise resolves immediately.

interface RouteCtx {
  service: TeamService
  // Override for tests so we don't need a real server bound to a port.
  authorize: Authorizer | ((req: IncomingMessage) => { userId: string | null })
  log: (line: string) => void
}

function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.length === 0) {
          resolve({} as T)
          return
        }
        resolve(JSON.parse(text) as T)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  // Bigint inside payloads must be stringified upstream — JSON.stringify
  // on bigint throws. Daily aggregates and per-event costs are already
  // strings; bare bigints would only appear if the SDK contract leaked.
  res.end(JSON.stringify(body))
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: RouteCtx): Promise<void> {
  const url = req.url ?? '/'
  const method = req.method ?? 'GET'

  if (method === 'GET' && url === '/healthz') {
    sendJson(res, 200, { ok: true })
    return
  }

  // POST /v1/teams/:teamId/events:batchUpsert
  const upsertMatch = url.match(/^\/v1\/teams\/([^/]+)\/events:batchUpsert(\?.*)?$/)
  if (method === 'POST' && upsertMatch !== null) {
    const teamId = decodeURIComponent(upsertMatch[1]!)
    const auth = await ctx.authorize(req)
    if (auth.userId === null) {
      sendJson(res, 401, { error: 'unauthenticated' })
      return
    }
    let body: { events?: SyncPayload[] }
    try {
      body = await readJson<{ events?: SyncPayload[] }>(req)
    } catch {
      sendJson(res, 400, { error: 'invalid_json' })
      return
    }
    const events = body.events ?? []
    try {
      const result = await ctx.service.batchUpsert(teamId, events)
      sendJson(res, 200, result)
    } catch (err) {
      if (err instanceof TeamServiceError) {
        sendJson(res, err.code === 'forbidden' ? 403 : 400, { error: err.code, message: err.message })
        return
      }
      ctx.log(`batchUpsert error: ${(err as Error).message}`)
      sendJson(res, 500, { error: 'internal' })
    }
    return
  }

  // GET /v1/teams/:teamId/usage
  const usageMatch = url.match(/^\/v1\/teams\/([^/]+)\/usage(\?.*)?$/)
  if (method === 'GET' && usageMatch !== null) {
    const teamId = decodeURIComponent(usageMatch[1]!)
    const auth = await ctx.authorize(req)
    if (auth.userId === null) {
      sendJson(res, 401, { error: 'unauthenticated' })
      return
    }
    // Optional `todayStartMs` query — the client's local midnight in
    // millis. Lets the server's "today" boundary track the client's
    // timezone instead of always splitting on UTC midnight, which
    // otherwise leaves US users with an Account-today tile that lags
    // their Today KPI by several hours after their local midnight.
    let clientTodayStartMs: number | undefined
    const queryStr = usageMatch[2]
    if (queryStr !== undefined && queryStr.length > 1) {
      const params = new URLSearchParams(queryStr.slice(1))
      const raw = params.get('todayStartMs')
      if (raw !== null) {
        const parsed = Number(raw)
        if (Number.isFinite(parsed) && parsed > 0) {
          clientTodayStartMs = Math.floor(parsed)
        }
      }
    }
    try {
      // Optional ?window=<ms> overrides the default 30-day rollup window.
      // Clamp to [1h, 1y] so a typo can't ask for nanosecond windows or
      // multi-decade scans.
      const qs = new URL(url, 'http://host').searchParams
      const rawWindow = qs.get('window')
      const parsedWindow = rawWindow !== null ? Number(rawWindow) : NaN
      const windowMs = Number.isFinite(parsedWindow) && parsedWindow > 0
        ? Math.min(Math.max(parsedWindow, 60 * 60_000), 365 * 24 * 60 * 60_000)
        : undefined
      const overview = await ctx.service.getOverview(teamId, {
        requestingUserId: auth.userId,
        ...(clientTodayStartMs !== undefined ? { todayStartMs: clientTodayStartMs } : {}),
        ...(windowMs !== undefined ? { windowMs } : {}),
      })
      sendJson(res, 200, overview)
    } catch (err) {
      ctx.log(`getOverview error: ${(err as Error).message}`)
      sendJson(res, 500, { error: 'internal' })
    }
    return
  }

  // ─── admin management endpoints ──────────────────────────────────
  // POST   /v1/teams/:teamId/members            — add or reactivate
  // PATCH  /v1/teams/:teamId/members/:userId    — change role
  // DELETE /v1/teams/:teamId/members/:userId    — revoke
  // PATCH  /v1/teams/:teamId/privacy-floor      — set team-wide floor
  // All require the requesting user to be an active 'admin' on teamId.

  const requireAdmin = async (
    teamId: string,
  ): Promise<{ ok: true; userId: string } | { ok: false }> => {
    const auth = await ctx.authorize(req)
    if (auth.userId === null) {
      sendJson(res, 401, { error: 'unauthenticated' })
      return { ok: false }
    }
    const m = await ctx.service.getMembership(teamId, auth.userId)
    if (m === null || m.status !== 'active' || m.role !== 'admin') {
      sendJson(res, 403, { error: 'forbidden' })
      return { ok: false }
    }
    return { ok: true, userId: auth.userId }
  }

  const handleServiceError = (err: unknown, fallback: string): void => {
    if (err instanceof TeamServiceError) {
      const status =
        err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400
      sendJson(res, status, { error: err.code, message: err.message })
      return
    }
    ctx.log(`${fallback}: ${(err as Error).message}`)
    sendJson(res, 500, { error: 'internal' })
  }

  // POST /v1/teams/:teamId/members
  const addMemberMatch = url.match(/^\/v1\/teams\/([^/]+)\/members(\?.*)?$/)
  if (method === 'POST' && addMemberMatch !== null) {
    const teamId = decodeURIComponent(addMemberMatch[1]!)
    const ok = await requireAdmin(teamId)
    if (!ok.ok) return
    let body: { userId?: string; displayName?: string; role?: 'admin' | 'member' }
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, { error: 'invalid_json' })
      return
    }
    if (typeof body.userId !== 'string' || body.userId.trim().length === 0) {
      sendJson(res, 400, { error: 'invalid', message: 'userId required' })
      return
    }
    if (body.role !== undefined && body.role !== 'admin' && body.role !== 'member') {
      sendJson(res, 400, { error: 'invalid', message: 'role must be admin or member' })
      return
    }
    try {
      const role = await ctx.service.addMember(teamId, body.userId.trim(), body.role, body.displayName)
      sendJson(res, 200, { userId: body.userId.trim(), role })
    } catch (err) {
      handleServiceError(err, 'addMember')
    }
    return
  }

  // PATCH /v1/teams/:teamId/members/:userId  — role change
  // DELETE /v1/teams/:teamId/members/:userId — revoke
  const memberMatch = url.match(/^\/v1\/teams\/([^/]+)\/members\/([^/?]+)(\?.*)?$/)
  if (memberMatch !== null && (method === 'PATCH' || method === 'DELETE')) {
    const teamId = decodeURIComponent(memberMatch[1]!)
    const targetUserId = decodeURIComponent(memberMatch[2]!)
    const ok = await requireAdmin(teamId)
    if (!ok.ok) return
    if (method === 'DELETE') {
      try {
        await ctx.service.revokeMember(teamId, targetUserId)
        sendJson(res, 200, { userId: targetUserId, status: 'revoked' })
      } catch (err) {
        handleServiceError(err, 'revokeMember')
      }
      return
    }
    let body: { role?: 'admin' | 'member' }
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, { error: 'invalid_json' })
      return
    }
    if (body.role !== 'admin' && body.role !== 'member') {
      sendJson(res, 400, { error: 'invalid', message: 'role must be admin or member' })
      return
    }
    try {
      await ctx.service.setMemberRole(teamId, targetUserId, body.role)
      sendJson(res, 200, { userId: targetUserId, role: body.role })
    } catch (err) {
      handleServiceError(err, 'setMemberRole')
    }
    return
  }

  // PATCH /v1/teams/:teamId/privacy-floor
  const privacyMatch = url.match(/^\/v1\/teams\/([^/]+)\/privacy-floor(\?.*)?$/)
  if (method === 'PATCH' && privacyMatch !== null) {
    const teamId = decodeURIComponent(privacyMatch[1]!)
    const ok = await requireAdmin(teamId)
    if (!ok.ok) return
    let body: { level?: 'full' | 'redacted' | 'aggregateOnly' }
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, { error: 'invalid_json' })
      return
    }
    const level = body.level
    if (level !== 'full' && level !== 'redacted' && level !== 'aggregateOnly') {
      sendJson(res, 400, { error: 'invalid', message: 'invalid level' })
      return
    }
    try {
      await ctx.service.setPrivacyFloor(teamId, level)
      sendJson(res, 200, { level })
    } catch (err) {
      handleServiceError(err, 'setPrivacyFloor')
    }
    return
  }

  sendJson(res, 404, { error: 'not_found' })
}

export function createApp(ctx: RouteCtx): Server {
  return createServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
      ctx.log(`unhandled: ${(err as Error).message}`)
      try {
        sendJson(res, 500, { error: 'internal' })
      } catch {
        // socket already gone
      }
    })
  })
}

