import { SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'

import { PricingTable } from '../../../pricing/pricing-table'
import { fetchCursorUsageEvents } from '../usage'

const PRICING_FIXTURE = Buffer.from(
  JSON.stringify({
    sample_spec: { foo: 'bar' },
    'gpt-4': {
      input_cost_per_token: 0.00003,
      output_cost_per_token: 0.00006,
      max_input_tokens: 8192,
      litellm_provider: 'openai',
    },
  }),
)
const PRICING = PricingTable.fromBuffer(PRICING_FIXTURE)

async function makeJwt(claims: Record<string, string>): Promise<string> {
  const key = new TextEncoder().encode('test')
  return new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().sign(key)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('fetchCursorUsageEvents', () => {
  it('returns [] when no access token is available', async () => {
    const events = await fetchCursorUsageEvents({
      pricing: PRICING,
      cursorStateDb: '/dev/null',
      readAccessToken: async () => null,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })
    expect(events).toEqual([])
  })

  it('returns [] when the token has no usable user id', async () => {
    const jwt = await makeJwt({ email: 'no-sub@example.com' })
    const events = await fetchCursorUsageEvents({
      pricing: PRICING,
      cursorStateDb: '/dev/null',
      readAccessToken: async () => jwt,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })
    expect(events).toEqual([])
  })

  it('returns [] when /api/usage-summary itself fails (auth-level error)', async () => {
    const jwt = await makeJwt({ sub: 'u' })
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    const events = await fetchCursorUsageEvents({
      pricing: PRICING,
      cursorStateDb: '/dev/null',
      readAccessToken: async () => jwt,
      fetchImpl,
    })
    expect(events).toEqual([])
  })

  it('synthesizes one event per included-plan request using the summary', async () => {
    const jwt = await makeJwt({ sub: 'user_xyz' })
    const cycleStart = '2026-05-01T00:00:00.000Z'
    const cycleEnd = '2026-06-01T00:00:00.000Z'
    const now = Date.UTC(2026, 4, 11)

    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      if (url.includes('usage-summary')) {
        return jsonResponse({
          billingCycleStart: cycleStart,
          billingCycleEnd: cycleEnd,
          membershipType: 'pro',
          individualUsage: {
            plan: { enabled: true, used: 3, limit: 2000, remaining: 1997 },
            onDemand: { enabled: false, used: 0 },
          },
        })
      }
      throw new Error(`unexpected url: ${url}`)
    }) as unknown as typeof fetch

    const events = await fetchCursorUsageEvents({
      pricing: PRICING,
      cursorStateDb: '/dev/null',
      readAccessToken: async () => jwt,
      fetchImpl,
      now: () => now,
    })

    // Only the summary endpoint should be hit when it returns data.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('usage-summary')

    expect(events).toHaveLength(3)
    for (const e of events) {
      expect(e.provider).toBe('cursor')
      expect(e.model).toBe('cursor-auto')
      expect(e.timestamp).toBeGreaterThanOrEqual(Date.parse(cycleStart))
      expect(e.timestamp).toBeLessThanOrEqual(now)
      // Plan-bucket events are "included" — no incremental cost.
      expect(e.computedCostMicroUsd).toBe(0n)
    }
  })

  it('adds on-demand events tagged separately and attributes onDemand.usedCents to them', async () => {
    const jwt = await makeJwt({ sub: 'u' })
    const now = Date.UTC(2026, 4, 11)
    const fetchImpl = (async (url: string) => {
      if (url.includes('usage-summary')) {
        return jsonResponse({
          billingCycleStartMs: Date.UTC(2026, 4, 1),
          billingCycleEndMs: Date.UTC(2026, 5, 1),
          individualUsage: {
            plan: { used: 2 },
            onDemand: { enabled: true, used: 4, usedCents: 12.5 },
          },
        })
      }
      throw new Error(`unexpected url: ${url}`)
    }) as unknown as typeof fetch

    const events = await fetchCursorUsageEvents({
      pricing: PRICING,
      cursorStateDb: '/dev/null',
      readAccessToken: async () => jwt,
      fetchImpl,
      now: () => now,
    })

    // 2 included + 4 on-demand = 6 events.
    expect(events).toHaveLength(6)
    const included = events.filter((e) => e.model === 'cursor-auto')
    const onDemand = events.filter((e) => e.model === 'cursor-auto-on-demand')
    expect(included).toHaveLength(2)
    expect(onDemand).toHaveLength(4)
    // Included → no cost. On-demand: 12.5¢ = 125_000 µUSD total across 4 events.
    expect(included.every((e) => e.computedCostMicroUsd === 0n)).toBe(true)
    const totalCents = onDemand.reduce((acc, e) => acc + e.computedCostMicroUsd, 0n)
    expect(totalCents).toBe(125000n)
  })

  it('IDs are stable so re-fetching the same response upserts cleanly', async () => {
    const jwt = await makeJwt({ sub: 'u' })
    const now = Date.UTC(2026, 4, 11)
    const fetchImpl = (async (url: string) => {
      if (url.includes('usage-summary')) {
        return jsonResponse({
          billingCycleStartMs: Date.UTC(2026, 4, 1),
          billingCycleEndMs: Date.UTC(2026, 5, 1),
          individualUsage: { plan: { used: 3 } },
        })
      }
      throw new Error(`unexpected url: ${url}`)
    }) as unknown as typeof fetch

    const first = await fetchCursorUsageEvents({
      pricing: PRICING,
      cursorStateDb: '/dev/null',
      readAccessToken: async () => jwt,
      fetchImpl,
      now: () => now,
    })
    const second = await fetchCursorUsageEvents({
      pricing: PRICING,
      cursorStateDb: '/dev/null',
      readAccessToken: async () => jwt,
      fetchImpl,
      now: () => now,
    })
    expect(first.map((e) => e.id).sort()).toEqual(second.map((e) => e.id).sort())
  })

  it('falls back to daily-spend then legacy when summary has zero usage', async () => {
    const jwt = await makeJwt({ sub: 'user_old' })
    const now = Date.UTC(2026, 4, 11)
    const fetchImpl = (async (url: string) => {
      if (url.includes('usage-summary')) {
        return jsonResponse({
          billingCycleStartMs: Date.UTC(2026, 4, 1),
          individualUsage: { plan: { used: 0 } },
        })
      }
      if (url.includes('get-daily-spend-by-category')) {
        // Match the real-world failure: 500 from cursor.com.
        return new Response('Internal Server Error', { status: 500 })
      }
      if (url.includes('/api/usage?')) {
        return jsonResponse({
          startOfMonth: new Date(Date.UTC(2026, 4, 1)).toISOString(),
          'gpt-4': { numRequests: 2, numTokens: 600 },
        })
      }
      throw new Error(`unexpected url: ${url}`)
    }) as unknown as typeof fetch

    const events = await fetchCursorUsageEvents({
      pricing: PRICING,
      cursorStateDb: '/dev/null',
      readAccessToken: async () => jwt,
      fetchImpl,
      now: () => now,
    })

    expect(events).toHaveLength(2)
    expect(events.every((e) => e.model === 'gpt-4')).toBe(true)
  })
})
