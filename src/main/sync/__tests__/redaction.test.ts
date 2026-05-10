import { describe, expect, it } from 'vitest'

import type { UsageEvent } from '@shared/usage-event'

import {
  dailyKey,
  payloadHashFor,
  projectHash,
  redactEvent,
  redactToDaily,
  syncEventIdFor,
} from '../redaction'

function makeEvent(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: 'event-1',
    provider: 'anthropic',
    providerRawTag: 'claude',
    model: 'claude-3-5-sonnet',
    timestamp: Date.UTC(2026, 4, 8, 10, 0, 0), // 2026-05-08
    project: 'llm-cost-monitor',
    projectRawSlug: '-Users-me-llm-cost-monitor',
    sessionId: 'session-abc',
    messageId: 'msg-xyz',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    reasoningTokens: null,
    toolCallCount: null,
    latencyMs: 1234,
    computedCostMicroUsd: 1500n,
    pricingSnapshotVersion: '246413ab',
    sourceFile: '/path/x.jsonl',
    sourceLineOffset: 0,
    ...over,
  }
}

const ctx = {
  teamId: 'team-A',
  userId: 'user-1',
  nodeId: 'node-mac',
  capturedAt: 1_700_000_000_000,
}

describe('syncEventIdFor', () => {
  it('is deterministic for fixed inputs', () => {
    const a = syncEventIdFor('t', 'u', 'n', 'e1')
    const b = syncEventIdFor('t', 'u', 'n', 'e1')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when any of the four ids changes', () => {
    const base = syncEventIdFor('t', 'u', 'n', 'e1')
    expect(syncEventIdFor('t2', 'u', 'n', 'e1')).not.toBe(base)
    expect(syncEventIdFor('t', 'u2', 'n', 'e1')).not.toBe(base)
    expect(syncEventIdFor('t', 'u', 'n2', 'e1')).not.toBe(base)
    expect(syncEventIdFor('t', 'u', 'n', 'e2')).not.toBe(base)
  })
})

describe('payloadHashFor', () => {
  it('is stable across runs for the same event', () => {
    const e = makeEvent()
    expect(payloadHashFor(e)).toBe(payloadHashFor(e))
  })

  it('changes when token counts change', () => {
    const a = payloadHashFor(makeEvent({ inputTokens: 100 }))
    const b = payloadHashFor(makeEvent({ inputTokens: 101 }))
    expect(a).not.toBe(b)
  })

  it('changes when pricing snapshot rotates', () => {
    const a = payloadHashFor(makeEvent({ pricingSnapshotVersion: 'v1' }))
    const b = payloadHashFor(makeEvent({ pricingSnapshotVersion: 'v2' }))
    expect(a).not.toBe(b)
  })
})

describe('projectHash', () => {
  it('returns null for null input', () => {
    expect(projectHash('team', null)).toBeNull()
  })

  it('produces the same hash for the same project + team', () => {
    expect(projectHash('team-A', 'foo')).toBe(projectHash('team-A', 'foo'))
  })

  it('differs across teams (no cross-team correlation)', () => {
    expect(projectHash('team-A', 'foo')).not.toBe(projectHash('team-B', 'foo'))
  })
})

describe('redactEvent', () => {
  it('full mode preserves project and ids', () => {
    const out = redactEvent(makeEvent(), 'full', ctx)
    expect(out.project).toBe('llm-cost-monitor')
    expect(out.session_id).toBe('session-abc')
    expect(out.message_id).toBe('msg-xyz')
    expect(out.latency_ms).toBe(1234)
    expect(out.privacy_level).toBe('full')
  })

  it('redacted mode strips project, session, message, latency', () => {
    const out = redactEvent(makeEvent(), 'redacted', ctx)
    expect(out.project).toBeNull()
    expect(out.session_id).toBeNull()
    expect(out.message_id).toBeNull()
    expect(out.latency_ms).toBeNull()
    expect(out.project_hash).not.toBeNull()
    expect(out.privacy_level).toBe('redacted')
  })

  it('redacted mode keeps tokens, cost, model, timestamp', () => {
    const e = makeEvent({ inputTokens: 42, outputTokens: 7, computedCostMicroUsd: 999n })
    const out = redactEvent(e, 'redacted', ctx)
    expect(out.input_tokens).toBe(42)
    expect(out.output_tokens).toBe(7)
    expect(out.cost_micro_usd).toBe('999')
    expect(out.model).toBe('claude-3-5-sonnet')
    expect(out.timestamp).toBe(e.timestamp)
  })

  it('returns the same sync_event_id for the same (team,user,node,localId) tuple', () => {
    const a = redactEvent(makeEvent(), 'redacted', ctx)
    const b = redactEvent(makeEvent(), 'redacted', ctx)
    expect(a.sync_event_id).toBe(b.sync_event_id)
  })

  it('cost is sent as a string (preserves bigint precision)', () => {
    const out = redactEvent(makeEvent({ computedCostMicroUsd: 9_007_199_254_740_993n }), 'full', ctx)
    expect(out.cost_micro_usd).toBe('9007199254740993')
  })
})

describe('redactToDaily', () => {
  it('groups same (date, provider, model) into one bucket', () => {
    const events = [
      makeEvent({ id: 'a', inputTokens: 10, computedCostMicroUsd: 100n }),
      makeEvent({ id: 'b', inputTokens: 5, computedCostMicroUsd: 50n }),
    ]
    const out = redactToDaily(events, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]!.input_tokens).toBe(15)
    expect(out[0]!.event_count).toBe(2)
    expect(out[0]!.cost_micro_usd).toBe('150')
  })

  it('splits by model', () => {
    const out = redactToDaily(
      [makeEvent({ id: 'a' }), makeEvent({ id: 'b', model: 'opus-4' })],
      ctx,
    )
    expect(out).toHaveLength(2)
  })

  it('splits by date (UTC day boundary)', () => {
    const events = [
      makeEvent({ id: 'a', timestamp: Date.UTC(2026, 4, 8, 23, 59, 0) }),
      makeEvent({ id: 'b', timestamp: Date.UTC(2026, 4, 9, 0, 1, 0) }),
    ]
    const out = redactToDaily(events, ctx)
    expect(out.map((b) => b.date).sort()).toEqual(['2026-05-08', '2026-05-09'])
  })

  it('contains no event-level identifiers (acceptance: aggregateOnly leaks no ids)', () => {
    const out = redactToDaily([makeEvent({ id: 'secret' })], ctx)
    const json = JSON.stringify(out)
    expect(json).not.toContain('secret')
    expect(json).not.toContain('session-abc')
    expect(json).not.toContain('msg-xyz')
  })

  it('keeps the latest pricing snapshot when multiple snapshots contribute', () => {
    const out = redactToDaily(
      [
        makeEvent({ id: 'a', pricingSnapshotVersion: 'a-old' }),
        makeEvent({ id: 'b', pricingSnapshotVersion: 'b-new' }),
      ],
      ctx,
    )
    expect(out[0]!.pricing_snapshot_version).toBe('b-new')
  })
})

describe('dailyKey', () => {
  it('encodes date|provider|model', () => {
    expect(dailyKey(makeEvent())).toBe('2026-05-08|anthropic|claude-3-5-sonnet')
  })
})
