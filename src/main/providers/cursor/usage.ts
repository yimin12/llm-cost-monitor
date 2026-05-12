import { canonical, inferred } from '@shared/provider-identity'
import type { UsageEvent } from '@shared/usage-event'

import { buildEventId } from '../../parsers/jsonl'
import type { PricingTable } from '../../pricing/pricing-table'
import {
  buildCursorCookie,
  readCursorAccessToken,
  resolveCursorStateDb,
} from './credentials'

// Cursor stores usage server-side. To populate the Providers card with real
// per-model spend we hit the same endpoints the cursor.com dashboard uses:
//
//   1. POST /api/usage-summary               → billing-cycle range + plan
//   2. POST /api/dashboard/get-daily-spend-by-category
//                                            → per-(day,model) totals
//
// Each `dailySpend` entry becomes one synthesized `UsageEvent` with the
// reported tokens + cost, dated to the entry's day. Costs come from
// Cursor (in cents → micro-USD) — we don't recompute via the pricing
// table because Cursor's request-based pricing isn't strictly token-
// proportional and their cents number is the authoritative billed amount.
// Pricing-table cost is fine for token-based providers (Claude/Codex/Gemini);
// for Cursor we trust the server's spendCents.

const USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary'
const DAILY_SPEND_URL = 'https://cursor.com/api/dashboard/get-daily-spend-by-category'
const LEGACY_USAGE_URL = 'https://cursor.com/api/usage'
const REQUEST_TIMEOUT_MS = 6_000
// Hard ceiling — Cursor power users can have hundreds of distinct (day,model)
// tuples per cycle, but never realistic millions. Defends against a runaway
// API response from creating an unbounded event-store explosion.
const MAX_EVENTS_PER_REFRESH = 10_000

interface CursorDailySpendEntry {
  category?: string
  totalTokens?: string | number
  spendCents?: number
  // Cursor's per-(day,model) tuples carry a date — exact field name has
  // varied across API revisions; we accept the common spellings.
  date?: string
  dayStartMs?: number
  dayMs?: number
  // Future-proofing: some responses include a `requestCount` per bucket.
  numRequests?: number
  requestCount?: number
}

interface CursorDailySpendRaw {
  dailySpend?: CursorDailySpendEntry[]
}

// Live response shape captured from cursor.com/api/usage-summary:
//   { billingCycleStart, billingCycleEnd, membershipType, limitType,
//     individualUsage: { plan: { used, limit, remaining, breakdown, … },
//                        onDemand: { enabled, used, limit, remaining } } }
// `plan.used` is request count for the current cycle (included tier).
// `onDemand.used` is additional usage beyond the included limit; field is
// in request units when the plan is request-counted and in cents when it's
// the credit/usd_credit billing model. We treat onDemand as cost if the
// user is over their plan limit, else as additional requests.
interface CursorPlanBucket {
  enabled?: boolean
  used?: number
  limit?: number | null
  remaining?: number | null
  breakdown?: { included?: number; bonus?: number; total?: number }
  totalPercentUsed?: number
}
interface CursorOnDemandBucket {
  enabled?: boolean
  used?: number
  usedCents?: number
  limit?: number | null
  remaining?: number | null
}
interface CursorUsageSummaryRaw {
  // Two field-name styles observed in different API revisions.
  billingCycleStart?: string
  billingCycleEnd?: string
  billingCycleStartMs?: number
  billingCycleEndMs?: number
  membershipType?: string
  individualUsage?: {
    plan?: CursorPlanBucket
    onDemand?: CursorOnDemandBucket
  }
  teamUsage?: {
    plan?: CursorPlanBucket
    onDemand?: CursorOnDemandBucket
  }
}

interface CursorLegacyPerModel {
  numRequests?: number
  numRequestsTotal?: number
  numTokens?: number
}
interface CursorLegacyUsageRaw {
  startOfMonth?: string
  [model: string]: CursorLegacyPerModel | string | undefined
}

export interface CursorUsageProbeDeps {
  pricing: PricingTable
  cursorStateDb?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  fetchImpl?: typeof fetch
  readAccessToken?: (dbPath: string) => Promise<string | null>
  // Test seam: stable "now" for deterministic event timestamps.
  now?: () => number
}

async function getJson<T>(
  url: string,
  cookie: string,
  fetchImpl: typeof fetch,
): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard',
      },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function postJson<T>(
  url: string,
  cookie: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function readInt(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.floor(v))
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
  }
  return 0
}

function readFloat(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

// Extract a millisecond timestamp from one of the field-name variations
// Cursor has used: `dayStartMs` / `dayMs` (numeric ms) or `date` (ISO string
// or YYYY-MM-DD). Returns the day midnight UTC when only a date is given so
// re-fetches stay deterministic.
function timestampFromEntry(e: CursorDailySpendEntry, fallback: number): number {
  if (typeof e.dayStartMs === 'number' && Number.isFinite(e.dayStartMs)) return e.dayStartMs
  if (typeof e.dayMs === 'number' && Number.isFinite(e.dayMs)) return e.dayMs
  if (typeof e.date === 'string') {
    // Accept both ISO datetime and bare YYYY-MM-DD.
    const parsed = Date.parse(/T/.test(e.date) ? e.date : `${e.date}T00:00:00.000Z`)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback
}

// Build a UsageEvent for one cursor.com daily-spend tuple. Cost comes from
// Cursor's `spendCents` (their authoritative billed amount in cents),
// converted to micro-USD. Token count is whatever Cursor reports for the
// bucket; we put everything on `inputTokens` since the API doesn't split.
function eventFromDailyEntry(
  e: CursorDailySpendEntry,
  fallbackTs: number,
  pricingSnapshotVersion: string,
  index: number,
): UsageEvent | null {
  const model = (e.category ?? '').toString().trim()
  if (model === '') return null
  const timestamp = timestampFromEntry(e, fallbackTs)
  const inputTokens = readInt(e.totalTokens)
  const spendCents = readFloat(e.spendCents)
  if (inputTokens === 0 && spendCents === 0) return null
  // cents → micro-USD: 1¢ = 10_000 µUSD. Accept fractional cents and round.
  const costMicroUsd = BigInt(Math.round(spendCents * 10_000))
  const rawTag = canonical(model) ?? inferred(model)
  // Stable id: (provider, day-bucket, model, index) — re-fetching the same
  // shape produces identical ids so the upsert path dedupes cleanly.
  const dayBucket = Math.floor(timestamp / 86_400_000)
  const id = buildEventId(['cursor', dayBucket, model, index])
  return {
    id,
    provider: 'cursor',
    providerRawTag: rawTag,
    model,
    timestamp,
    project: '(cursor)',
    projectRawSlug: 'cursor',
    sessionId: null,
    messageId: null,
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    reasoningTokens: null,
    toolCallCount: null,
    latencyMs: null,
    computedCostMicroUsd: costMicroUsd,
    pricingSnapshotVersion,
    sourceFile: DAILY_SPEND_URL,
    sourceLineOffset: index,
  }
}

// Fallback path for users whose cursor.com account still surfaces data on
// the legacy `/api/usage?user=` endpoint. Synthesizes one event per request
// distributed across the cycle. Used only when the daily-spend endpoint
// returns empty or 404.
function eventsFromLegacy(
  raw: CursorLegacyUsageRaw,
  pricingSnapshotVersion: string,
  pricing: PricingTable,
  nowMs: number,
): UsageEvent[] {
  const cycleStartMs = (() => {
    if (typeof raw.startOfMonth === 'string') {
      const parsed = Date.parse(raw.startOfMonth)
      if (!Number.isNaN(parsed)) return parsed
    }
    return nowMs - 30 * 24 * 60 * 60_000
  })()
  const events: UsageEvent[] = []
  let index = 0
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'startOfMonth' || value === undefined || typeof value === 'string') continue
    const bucket = value as CursorLegacyPerModel
    const numRequests = readInt(bucket.numRequests ?? bucket.numRequestsTotal)
    if (numRequests === 0) continue
    const totalTokens = readInt(bucket.numTokens)
    const perTokens = numRequests > 0 ? Math.round(totalTokens / numRequests) : 0
    const step = numRequests === 1 ? 0 : (nowMs - cycleStartMs) / numRequests
    const capped = Math.min(numRequests, MAX_EVENTS_PER_REFRESH)
    for (let i = 0; i < capped; i++) {
      const ts = numRequests === 1
        ? Math.round((cycleStartMs + nowMs) / 2)
        : Math.round(cycleStartMs + step * (i + 0.5))
      const rawTag = canonical(key) ?? inferred(key)
      const id = buildEventId(['cursor', 'legacy', key, ts, index])
      const partial: UsageEvent = {
        id,
        provider: 'cursor',
        providerRawTag: rawTag,
        model: key,
        timestamp: ts,
        project: '(cursor)',
        projectRawSlug: 'cursor',
        sessionId: null,
        messageId: null,
        inputTokens: perTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        reasoningTokens: null,
        toolCallCount: null,
        latencyMs: null,
        computedCostMicroUsd: 0n,
        pricingSnapshotVersion,
        sourceFile: LEGACY_USAGE_URL,
        sourceLineOffset: index,
      }
      events.push({ ...partial, computedCostMicroUsd: pricing.cost(partial) })
      index++
      if (events.length >= MAX_EVENTS_PER_REFRESH) return events
    }
  }
  return events
}

// Cursor's `usage-summary` carries a `billingCycleStart` / `…End` pair —
// always as ISO date strings in the current shape, with the `…Ms` variants
// kept as a forwards-compat fallback.
function cycleRangeFromSummary(
  s: CursorUsageSummaryRaw | null,
  nowMs: number,
): { startMs: number; endMs: number } {
  const fromMs = (v: number | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const fromStr = (v: string | undefined): number | null => {
    if (typeof v !== 'string') return null
    const p = Date.parse(v)
    return Number.isNaN(p) ? null : p
  }
  const startMs =
    fromMs(s?.billingCycleStartMs) ??
    fromStr(s?.billingCycleStart) ??
    nowMs - 30 * 24 * 60 * 60_000
  const endMs =
    fromMs(s?.billingCycleEndMs) ??
    fromStr(s?.billingCycleEnd) ??
    Math.max(nowMs, startMs + 30 * 24 * 60 * 60_000)
  return { startMs, endMs }
}

// Synthesize N events spanning [cycleStart, now], representing N completed
// requests. Each event is dated to one timestamp on a deterministic spread
// so refreshes upsert by id instead of double-counting. Cost is split
// evenly across the events from `totalCostMicroUsd`.
function eventsFromCount(
  count: number,
  cycleStartMs: number,
  nowMs: number,
  model: string,
  totalCostMicroUsd: bigint,
  pricingSnapshotVersion: string,
): UsageEvent[] {
  if (count <= 0) return []
  const capped = Math.min(count, MAX_EVENTS_PER_REFRESH)
  const perCost = capped > 0 ? totalCostMicroUsd / BigInt(capped) : 0n
  // Any rounding remainder lands on the last event so the totals add up.
  const remainder = totalCostMicroUsd - perCost * BigInt(capped)
  const out: UsageEvent[] = []
  const span = Math.max(0, nowMs - cycleStartMs)
  for (let i = 0; i < capped; i++) {
    const ts =
      capped === 1
        ? Math.round((cycleStartMs + nowMs) / 2)
        : Math.round(cycleStartMs + (span * (i + 0.5)) / capped)
    const dayBucket = Math.floor(ts / 86_400_000)
    const id = buildEventId(['cursor', 'summary', dayBucket, model, i])
    const cost = i === capped - 1 ? perCost + remainder : perCost
    out.push({
      id,
      provider: 'cursor',
      providerRawTag: canonical(model) ?? inferred(model),
      model,
      timestamp: ts,
      project: '(cursor)',
      projectRawSlug: 'cursor',
      sessionId: null,
      messageId: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      reasoningTokens: null,
      toolCallCount: null,
      latencyMs: null,
      computedCostMicroUsd: cost,
      pricingSnapshotVersion,
      sourceFile: USAGE_SUMMARY_URL,
      sourceLineOffset: i,
    })
  }
  return out
}

export async function fetchCursorUsageEvents(
  deps: CursorUsageProbeDeps,
): Promise<UsageEvent[]> {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const fetchImpl = deps.fetchImpl ?? fetch
  const readAccessToken = deps.readAccessToken ?? readCursorAccessToken
  const stateDb = deps.cursorStateDb ?? resolveCursorStateDb(env, platform)
  const nowMs = (deps.now ?? Date.now)()

  const stored = await readAccessToken(stateDb)
  if (stored === null || stored.length === 0) return []

  const { cookie, userId } = buildCursorCookie(stored)
  if (userId === null) return []

  // Primary source: /api/usage-summary. Carries billing cycle, plan tier,
  // and `individualUsage.plan.used` (request count this cycle) plus an
  // `onDemand` bucket for usage beyond the included limit.
  const summary = await getJson<CursorUsageSummaryRaw>(USAGE_SUMMARY_URL, cookie, fetchImpl)
  if (summary === null) {
    // Auth failed entirely — nothing else will work either.
    return []
  }
  const { startMs: cycleStartMs } = cycleRangeFromSummary(summary, nowMs)

  const plan = summary.individualUsage?.plan
  const onDemand = summary.individualUsage?.onDemand
  const planUsed = readInt(plan?.used)
  const onDemandUsed = readInt(onDemand?.used)
  // Cents observed only on the onDemand side; the plan bucket is "included"
  // requests (no incremental cost).
  const onDemandCents = readFloat(onDemand?.usedCents ?? 0)
  const onDemandCostMicroUsd = BigInt(Math.round(onDemandCents * 10_000))

  // Cursor doesn't break the summary down by model. We tag everything as
  // `auto` (their default model-routing label) so the card aggregates
  // under one row instead of spreading across an unhelpful "unknown" bucket.
  const events: UsageEvent[] = [
    ...eventsFromCount(planUsed, cycleStartMs, nowMs, 'cursor-auto', 0n, deps.pricing.snapshotVersion),
    ...eventsFromCount(
      onDemandUsed,
      cycleStartMs,
      nowMs,
      'cursor-auto-on-demand',
      onDemandCostMicroUsd,
      deps.pricing.snapshotVersion,
    ),
  ]

  if (events.length > 0) return events

  // Secondary attempt: per-model daily breakdown. Frequently 500s for
  // individuals on the current API (cursor.com only exposes this to team
  // dashboards reliably), but try it cleanly when summary gave us nothing.
  const periodEndMs = nowMs
  const dailySpend = await postJson<CursorDailySpendRaw>(
    DAILY_SPEND_URL,
    cookie,
    { userId, periodStartMs: cycleStartMs, periodEndMs, groupBy: 1, spendType: 1 },
    fetchImpl,
  )
  if (Array.isArray(dailySpend?.dailySpend) && dailySpend.dailySpend.length > 0) {
    let index = 0
    for (const entry of dailySpend.dailySpend) {
      const evt = eventFromDailyEntry(entry, nowMs, deps.pricing.snapshotVersion, index)
      if (evt !== null) {
        events.push(evt)
        index++
        if (events.length >= MAX_EVENTS_PER_REFRESH) break
      }
    }
  }
  if (events.length > 0) return events

  // Final fallback: legacy `/api/usage?user=` (very old accounts only).
  const legacy = await getJson<CursorLegacyUsageRaw>(
    `${LEGACY_USAGE_URL}?user=${encodeURIComponent(userId)}`,
    cookie,
    fetchImpl,
  )
  if (legacy !== null) {
    events.push(...eventsFromLegacy(legacy, deps.pricing.snapshotVersion, deps.pricing, nowMs))
  }
  return events
}
