import type { TeamMemberRole, TeamOverview } from '@shared/ipc-channels'

export interface FetchTeamOverviewOpts {
  baseUrl: string
  teamId: string
  accessToken: string | null
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

// GET the team usage rollup. Returns null on failure — the renderer treats
// "no team data" as an empty state, not an error, since the dashboard is
// best-effort and shouldn't block usage of the local panel.
export async function fetchTeamOverview(
  opts: FetchTeamOverviewOpts,
): Promise<TeamOverview | null> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = opts.baseUrl.replace(/\/+$/, '')
  const url = `${base}/v1/teams/${encodeURIComponent(opts.teamId)}/usage`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8_000)
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (opts.accessToken !== null) headers['Authorization'] = `Bearer ${opts.accessToken}`
    const res = await fetchImpl(url, { headers, signal: ctrl.signal })
    if (!res.ok) return null
    return (await res.json()) as TeamOverview
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── Admin management calls ─────────────────────────────────────────
// Surface 200/4xx/5xx as a tagged union so the IPC layer can map errors
// back to a renderer-side toast without leaking raw response objects.
export type ManageResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; message?: string }

export interface ManageOpts {
  baseUrl: string
  teamId: string
  accessToken: string | null
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

async function callManage<T>(
  opts: ManageOpts,
  path: string,
  init: { method: 'POST' | 'PATCH' | 'DELETE'; body?: unknown },
): Promise<ManageResult<T>> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = opts.baseUrl.replace(/\/+$/, '')
  const url = `${base}/v1/teams/${encodeURIComponent(opts.teamId)}${path}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8_000)
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts.accessToken !== null) headers['Authorization'] = `Bearer ${opts.accessToken}`
    const reqInit: RequestInit = {
      method: init.method,
      headers,
      signal: ctrl.signal,
    }
    if (init.body !== undefined) reqInit.body = JSON.stringify(init.body)
    const res = await fetchImpl(url, reqInit)
    if (res.ok) return { ok: true, value: (await res.json()) as T }
    let payload: { error?: string; message?: string } = {}
    try {
      payload = (await res.json()) as { error?: string; message?: string }
    } catch {
      /* non-json error body */
    }
    const failure: ManageResult<T> = {
      ok: false,
      status: res.status,
      error: payload.error ?? `http_${res.status}`,
    }
    if (payload.message !== undefined) failure.message = payload.message
    return failure
  } catch (err) {
    return { ok: false, status: 0, error: 'network', message: (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

export function addTeamMember(
  opts: ManageOpts,
  body: { userId: string; displayName?: string; role?: TeamMemberRole },
): Promise<ManageResult<{ userId: string; role: TeamMemberRole }>> {
  return callManage(opts, '/members', { method: 'POST', body })
}

export function revokeTeamMember(
  opts: ManageOpts,
  userId: string,
): Promise<ManageResult<{ userId: string; status: 'revoked' }>> {
  return callManage(opts, `/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })
}

export function setTeamMemberRole(
  opts: ManageOpts,
  userId: string,
  role: TeamMemberRole,
): Promise<ManageResult<{ userId: string; role: TeamMemberRole }>> {
  return callManage(opts, `/members/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: { role },
  })
}

export function setTeamPrivacyFloor(
  opts: ManageOpts,
  level: 'full' | 'redacted' | 'aggregateOnly',
): Promise<ManageResult<{ level: string }>> {
  return callManage(opts, '/privacy-floor', {
    method: 'PATCH',
    body: { level },
  })
}
