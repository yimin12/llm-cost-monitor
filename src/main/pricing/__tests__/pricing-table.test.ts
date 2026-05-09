import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { UsageEvent } from '@shared/usage-event'
import { PricingTable } from '../pricing-table'

function makeEvent(partial: Partial<UsageEvent> & Pick<UsageEvent, 'model'>): UsageEvent {
  return {
    id: 'test',
    provider: 'anthropic',
    providerRawTag: null,
    timestamp: 0,
    project: null,
    projectRawSlug: null,
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
    computedCostMicroUsd: 0n,
    pricingSnapshotVersion: 'test',
    sourceFile: '',
    sourceLineOffset: 0,
    ...partial,
  }
}

const synthetic = Buffer.from(
  JSON.stringify({
    sample_spec: { foo: 'bar' },
    'claude-3-5-sonnet-20240620': {
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cache_read_input_token_cost: 0.0000003,
      cache_creation_input_token_cost: 0.00000375,
      max_input_tokens: 200000,
      litellm_provider: 'anthropic',
    },
    'gpt-4o-mini': {
      input_cost_per_token: 0.00000015,
      output_cost_per_token: 0.0000006,
      max_input_tokens: 128000,
      litellm_provider: 'openai',
    },
    'anthropic/claude-3-haiku-20240307': {
      input_cost_per_token: 0.00000025,
      output_cost_per_token: 0.00000125,
      litellm_provider: 'anthropic',
    },
    'claude-sonnet-richer-alias': {
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cache_creation_input_token_cost: 0.00000375,
      litellm_provider: 'anthropic',
    },
    'anthropic.claude-sonnet-richer-alias': {
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cache_creation_input_token_cost: 0.00000375,
      cache_creation_input_token_cost_above_1hr: 0.000006,
      litellm_provider: 'anthropic',
    },
  }),
)

describe('PricingTable (synthetic)', () => {
  const t = PricingTable.fromBuffer(synthetic)

  it('skips sample_spec and counts real models only', () => {
    expect(t.modelCount).toBe(5)
  })

  it('produces a stable, prefix-sized snapshotVersion', () => {
    expect(t.snapshotVersion).toMatch(/^[0-9a-f]{12}$/)
    const t2 = PricingTable.fromBuffer(synthetic)
    expect(t2.snapshotVersion).toBe(t.snapshotVersion)
  })

  it('exact (case-insensitive) lookup', () => {
    const p = t.price('CLAUDE-3-5-Sonnet-20240620')
    expect(p?.inputPerM).toBe(3)
    expect(p?.outputPerM).toBe(15)
    expect(p?.cacheReadPerM).toBeCloseTo(0.3)
    expect(p?.cacheCreationPerM).toBeCloseTo(3.75)
    expect(p?.contextWindow).toBe(200000)
  })

  it('provider-prefixed match (anthropic/<model>)', () => {
    const p = t.price('claude-3-haiku-20240307')
    expect(p?.inputPerM).toBeCloseTo(0.25)
  })

  it('cost math: 1000 input + 500 output Sonnet 3.5 → 10500 µUSD ($0.0105)', () => {
    const event = makeEvent({
      model: 'claude-3-5-sonnet-20240620',
      inputTokens: 1000,
      outputTokens: 500,
    })
    expect(t.cost(event)).toBe(10500n)
  })

  it('cost math: cache-read uses cacheReadPerM', () => {
    const event = makeEvent({
      model: 'claude-3-5-sonnet-20240620',
      cacheReadTokens: 10000,
    })
    // 10000 × 0.3 = 3000 µUSD
    expect(t.cost(event)).toBe(3000n)
  })

  it('cost math: cache-creation 5m falls back to cacheCreationPerM when no 5m-specific rate', () => {
    const event = makeEvent({
      model: 'claude-3-5-sonnet-20240620',
      cacheCreation5mTokens: 1000,
    })
    // 1000 × 3.75 = 3750 µUSD
    expect(t.cost(event)).toBe(3750n)
  })

  it('cost math: exact model lookup supplements missing 1h cache rate from richer Anthropic alias', () => {
    const event = makeEvent({
      model: 'claude-sonnet-richer-alias',
      cacheCreation1hTokens: 1000,
    })
    // 1000 × 6 = 6000 µUSD, not the 5m cache-creation fallback of 3750 µUSD.
    expect(t.cost(event)).toBe(6000n)
  })

  it('cost math: unknown model uses Sonnet-tier fallback (never silently $0)', () => {
    const event = makeEvent({
      model: 'totally-made-up-model-9001',
      inputTokens: 1000,
      outputTokens: 1000,
    })
    // Fallback: input 3, output 15 → 1000*3 + 1000*15 = 18000 µUSD
    expect(t.cost(event)).toBe(18000n)
  })

  it('cost math: local provider keeps token usage but never charges money', () => {
    const event = makeEvent({
      provider: 'local',
      model: 'ollama/llama3.1:8b',
      inputTokens: 10_000,
      outputTokens: 5_000,
      reasoningTokens: 2_000,
    })
    expect(t.cost(event)).toBe(0n)
  })

  it('keyword fallback: "kimi-newer" hits no real entries but sonnet-keyword finds something', () => {
    const event = makeEvent({
      model: 'sonnet-experiment',
      inputTokens: 1000,
    })
    // "sonnet" keyword hits the Sonnet entry above; fallback NOT used.
    expect(t.cost(event)).toBe(3000n)
  })
})

describe('PricingTable (bundled)', () => {
  const path = resolve(__dirname, '../../../../resources/pricing.json')
  const t = PricingTable.fromFile(path)

  it('loads more than 1000 LiteLLM models', () => {
    expect(t.modelCount).toBeGreaterThan(1000)
  })

  it('snapshotVersion is a 12-char hex prefix', () => {
    expect(t.snapshotVersion).toMatch(/^[0-9a-f]{12}$/)
  })

  it('looks up Sonnet 3.5 and yields nonzero cost on a 1k-input event', () => {
    const event = makeEvent({
      model: 'claude-3-5-sonnet-20240620',
      inputTokens: 1000,
    })
    const cost = t.cost(event)
    expect(cost).toBeGreaterThan(0n)
  })

  it('looks up gpt-4o and yields nonzero cost', () => {
    const event = makeEvent({
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 1000,
    })
    expect(t.cost(event)).toBeGreaterThan(0n)
  })

  it('uses Claude Sonnet 4.6 1h cache pricing from richer Anthropic alias', () => {
    const event = makeEvent({
      model: 'claude-sonnet-4-6',
      cacheCreation1hTokens: 1000,
    })
    expect(t.cost(event)).toBe(6000n)
  })

  it('prices likely future hosted Chinese models as nonzero when present in bundled pricing', () => {
    for (const model of ['kimi-k2.5', 'deepseek-v3.2', 'qwen3-coder-next', 'cerebras/zai-glm-4.7']) {
      const event = makeEvent({
        model,
        inputTokens: 1000,
        outputTokens: 1000,
      })
      expect(t.cost(event), model).toBeGreaterThan(0n)
    }
  })

  it('unknown model still produces nonzero cost via fallback', () => {
    const event = makeEvent({
      model: 'pojo-private-llm-2099',
      inputTokens: 1000,
    })
    expect(t.cost(event)).toBe(3000n)
  })
})
