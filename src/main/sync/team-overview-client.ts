import type { TeamOverview } from '@shared/ipc-channels'

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
