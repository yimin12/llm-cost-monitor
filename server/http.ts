import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { SyncPayload } from '../src/shared/sync'

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
// AUTH (v1): the desktop sends `Authorization: Bearer <google-id-token>`.
// In production the server would verify the JWT signature; for the v1
// scaffold we trust the client and use the token's `sub` claim as the
// requesting user identity. A second commit will tighten this with
// `verifyGoogleIdToken` from src/main/auth.

interface RouteCtx {
  service: TeamService
  // Override for tests so we don't need a real server bound to a port.
  authorize: (req: IncomingMessage) => { userId: string | null }
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
    const auth = ctx.authorize(req)
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
    const auth = ctx.authorize(req)
    if (auth.userId === null) {
      sendJson(res, 401, { error: 'unauthenticated' })
      return
    }
    try {
      const overview = await ctx.service.getOverview(teamId, {
        requestingUserId: auth.userId,
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
    const auth = ctx.authorize(req)
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

// Trivial bearer-token authorizer. Production would replace this with a
// JWT verifier. For now we accept any token, decode the JWT payload
// without verification, and use its `sub` claim if present, otherwise
// the literal token string. Disabled-by-default in local dev when
// LCM_SERVER_AUTH=insecure-noverify (the default).
export function defaultAuthorize(req: IncomingMessage): { userId: string | null } {
  const header = req.headers['authorization']
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return { userId: null }
  const token = header.slice('Bearer '.length).trim()
  if (token.length === 0) return { userId: null }
  // Try to decode JWT payload (middle segment, base64url JSON). On parse
  // failure we still allow the raw token through as the userId.
  const parts = token.split('.')
  if (parts.length === 3) {
    try {
      const json = Buffer.from(parts[1]!, 'base64url').toString('utf8')
      const claims = JSON.parse(json) as { sub?: string; email?: string }
      const sub = claims.sub ?? claims.email ?? null
      if (sub !== null) return { userId: sub }
    } catch {
      // fall through
    }
  }
  return { userId: token }
}
