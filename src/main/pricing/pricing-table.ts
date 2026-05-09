import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { UsageEvent } from '@shared/usage-event'

export interface ModelPrice {
  // All values are USD per 1M tokens, stored as float (range fits cleanly).
  readonly inputPerM: number
  readonly outputPerM: number
  readonly cacheReadPerM: number | null
  readonly cacheCreationPerM: number | null
  readonly cacheCreation5mPerM: number | null
  readonly cacheCreation1hPerM: number | null
  readonly reasoningPerM: number | null
  readonly contextWindow: number | null
  readonly provider: string | null
}

// Sonnet-tier defaults, used only when a model is completely unknown.
// Better to over-estimate than silently emit $0 and let the user think coding is free.
const FALLBACK: ModelPrice = {
  inputPerM: 3,
  outputPerM: 15,
  cacheReadPerM: 0.3,
  cacheCreationPerM: 3.75,
  cacheCreation5mPerM: 3.75,
  cacheCreation1hPerM: 6.0,
  reasoningPerM: null,
  contextWindow: 200_000,
  provider: 'fallback',
}

// Keys we keep from each LiteLLM entry. Same set as the Swift port.
const PROVIDER_PREFIXES = ['anthropic/', 'openai/', 'google/', 'vertex_ai/', 'bedrock/']
const LOCAL_PROVIDERS = new Set(['local', 'ollama', 'lmstudio', 'lm_studio', 'llama_cpp', 'llamacpp'])
const SUPPLEMENTAL_PREFIXES = [
  'anthropic.',
  'global.anthropic.',
  'us.anthropic.',
  'eu.anthropic.',
  'au.anthropic.',
  ...PROVIDER_PREFIXES,
]
const KEYWORDS = [
  'opus',
  'sonnet',
  'haiku',
  'gpt',
  'gemini',
  'o1',
  'o3',
  'o4',
  'kimi',
  'qwen',
  'deepseek',
  'glm',
  'grok',
  'mistral',
  'mixtral',
  'llama',
]

function readNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function buildEntries(root: Record<string, unknown>): Map<string, ModelPrice> {
  const out = new Map<string, ModelPrice>()
  for (const [key, value] of Object.entries(root)) {
    if (value === null || typeof value !== 'object') continue
    const dict = value as Record<string, unknown>

    const inputCost = readNumber(dict['input_cost_per_token'])
    const outputCost = readNumber(dict['output_cost_per_token'])
    // LiteLLM's first entry is `sample_spec` — has no real prices; skip it (and
    // any other entry that lacks both input and output cost).
    if (inputCost === null && outputCost === null) continue

    const cacheRead = readNumber(dict['cache_read_input_token_cost'])
    const cacheCreation = readNumber(dict['cache_creation_input_token_cost'])
    const cache5m =
      readNumber(dict['cache_creation_input_token_cost_above_5m']) ??
      readNumber(dict['cache_creation_5m_input_token_cost'])
    const cache1h =
      readNumber(dict['cache_creation_input_token_cost_above_1hr']) ??
      readNumber(dict['cache_creation_1h_input_token_cost'])
    const reasoning = readNumber(dict['output_reasoning_token_cost'])

    const cw = readNumber(dict['max_input_tokens']) ?? readNumber(dict['max_tokens'])
    const provider = typeof dict['litellm_provider'] === 'string' ? (dict['litellm_provider'] as string) : null

    out.set(key.toLowerCase(), {
      inputPerM: (inputCost ?? 0) * 1_000_000,
      outputPerM: (outputCost ?? 0) * 1_000_000,
      cacheReadPerM: cacheRead === null ? null : cacheRead * 1_000_000,
      cacheCreationPerM: cacheCreation === null ? null : cacheCreation * 1_000_000,
      cacheCreation5mPerM: cache5m === null ? null : cache5m * 1_000_000,
      cacheCreation1hPerM: cache1h === null ? null : cache1h * 1_000_000,
      reasoningPerM: reasoning === null ? null : reasoning * 1_000_000,
      contextWindow: cw === null ? null : Math.trunc(cw),
      provider,
    })
  }
  return out
}

function tokensTimesPerMillion(tokens: number, perMillion: number): bigint {
  if (tokens <= 0 || perMillion <= 0) return 0n
  // tokens × (USD per 1M) = micro-USD, since (1M tokens × USD/M) ÷ 1M = USD,
  // i.e. tokens × USD/M ≡ tokens × USD/M (already in micro-USD because USD/M is
  // pre-scaled by 1e6). Round to integer micro-USD at the boundary.
  return BigInt(Math.round(tokens * perMillion))
}

function mergeMissingPrice(base: ModelPrice, supplement: ModelPrice): ModelPrice {
  return {
    inputPerM: base.inputPerM,
    outputPerM: base.outputPerM,
    cacheReadPerM: base.cacheReadPerM ?? supplement.cacheReadPerM,
    cacheCreationPerM: base.cacheCreationPerM ?? supplement.cacheCreationPerM,
    cacheCreation5mPerM: base.cacheCreation5mPerM ?? supplement.cacheCreation5mPerM,
    cacheCreation1hPerM: base.cacheCreation1hPerM ?? supplement.cacheCreation1hPerM,
    reasoningPerM: base.reasoningPerM ?? supplement.reasoningPerM,
    contextWindow: base.contextWindow ?? supplement.contextWindow,
    provider: base.provider ?? supplement.provider,
  }
}

export class PricingTable {
  readonly snapshotVersion: string
  private readonly entries: Map<string, ModelPrice>

  constructor(snapshotVersion: string, entries: Map<string, ModelPrice>) {
    this.snapshotVersion = snapshotVersion
    this.entries = entries
  }

  get modelCount(): number {
    return this.entries.size
  }

  static fromBuffer(buf: Buffer): PricingTable {
    const text = buf.toString('utf8')
    const root: unknown = JSON.parse(text)
    if (root === null || typeof root !== 'object' || Array.isArray(root)) {
      throw new Error('PricingTable: invalid root (expected JSON object)')
    }
    const entries = buildEntries(root as Record<string, unknown>)
    const version = createHash('sha256').update(buf).digest('hex').slice(0, 12)
    return new PricingTable(version, entries)
  }

  static fromFile(path: string): PricingTable {
    return PricingTable.fromBuffer(readFileSync(path))
  }

  // Lookup chain (from docs/architecture.md D5):
  //  1. exact (case-insensitive)
  //  2. provider-prefixed (anthropic/<model>, openai/<model>, …)
  //  3. prefix sweep (entry-prefix-of-model OR model-prefix-of-entry)
  //  4. keyword fallback (opus|sonnet|haiku|gpt|gemini|o1|o3|o4|kimi|qwen|deepseek|glm|grok|mistral|mixtral|llama)
  //  5. null (caller falls back to FALLBACK in `cost()`)
  price(model: string): ModelPrice | null {
    const lowered = model.toLowerCase()

    const direct = this.entries.get(lowered)
    if (direct !== undefined) return this.withSupplementalAliases(lowered, direct)

    for (const prefix of PROVIDER_PREFIXES) {
      const hit = this.entries.get(prefix + lowered)
      if (hit !== undefined) return hit
    }

    for (const [key, p] of this.entries) {
      if (lowered.startsWith(key) || key.startsWith(lowered)) return p
    }

    for (const kw of KEYWORDS) {
      if (!lowered.includes(kw)) continue
      for (const [key, p] of this.entries) {
        if (key.includes(kw) && p.outputPerM > 0) return p
      }
    }

    return null
  }

  private withSupplementalAliases(model: string, base: ModelPrice): ModelPrice {
    let out = base
    for (const prefix of SUPPLEMENTAL_PREFIXES) {
      const supplement = this.entries.get(prefix + model)
      if (supplement !== undefined) out = mergeMissingPrice(out, supplement)
    }
    return out
  }

  contextWindow(model: string): number | null {
    return this.price(model)?.contextWindow ?? null
  }

  // Compute cost (in integer micro-USD) for an event using this snapshot.
  // Falls back to Sonnet-equivalent pricing if the model is unknown — never
  // silently emits $0. Reasoning tokens reuse outputPerM when no dedicated rate.
  cost(event: UsageEvent): bigint {
    if (LOCAL_PROVIDERS.has(event.provider.toLowerCase())) return 0n

    const p = this.price(event.model) ?? FALLBACK

    const cache5m = p.cacheCreation5mPerM ?? p.cacheCreationPerM ?? 0
    const cache1h = p.cacheCreation1hPerM ?? p.cacheCreationPerM ?? 0
    const cacheRead = p.cacheReadPerM ?? 0
    const reasoningRate = p.reasoningPerM ?? p.outputPerM

    let total = 0n
    total += tokensTimesPerMillion(event.inputTokens, p.inputPerM)
    total += tokensTimesPerMillion(event.outputTokens, p.outputPerM)
    total += tokensTimesPerMillion(event.cacheReadTokens, cacheRead)
    total += tokensTimesPerMillion(event.cacheCreation5mTokens, cache5m)
    total += tokensTimesPerMillion(event.cacheCreation1hTokens, cache1h)
    total += tokensTimesPerMillion(event.reasoningTokens ?? 0, reasoningRate)
    return total
  }
}
