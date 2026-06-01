import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { UsageEvent } from '@shared/usage-event'
import { Aggregator, startOfDayMs } from '../aggregation/aggregator'
import { parseClaudeFile } from '../parsers/claude-code'
import { parseCodexFile } from '../parsers/codex'
import { parseGeminiFile } from '../parsers/gemini'
import { PricingTable } from '../pricing/pricing-table'
import type { Pool } from '../storage/connect'
import { EventRepository } from '../storage/event-repository'
import { createTestDatabase, dropTestDatabase } from '../storage/__tests__/test-helpers'

const PRICING = PricingTable.fromBuffer(
  Buffer.from(
    JSON.stringify({
      'claude-3-5-sonnet-20240620': {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_read_input_token_cost: 0.0000003,
        cache_creation_input_token_cost: 0.00000375,
        litellm_provider: 'anthropic',
      },
      'gpt-5.5': {
        input_cost_per_token: 0.00000125,
        output_cost_per_token: 0.00001,
        litellm_provider: 'openai',
      },
      'gemini-3-flash-preview': {
        input_cost_per_token: 0.0000001,
        output_cost_per_token: 0.0000004,
        litellm_provider: 'google',
      },
    }),
  ),
)

function localEvent(timestamp: number): UsageEvent {
  const partial: UsageEvent = {
    id: 'local-ollama-1',
    provider: 'local',
    providerRawTag: 'ollama',
    model: 'ollama/llama3.1:8b',
    timestamp,
    project: 'local-lab',
    projectRawSlug: 'local-lab',
    sessionId: 'local-session',
    messageId: 'local-message',
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheReadTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    reasoningTokens: null,
    toolCallCount: null,
    latencyMs: null,
    computedCostMicroUsd: 0n,
    pricingSnapshotVersion: PRICING.snapshotVersion,
    sourceFile: 'ollama://local',
    sourceLineOffset: 0,
  }
  return { ...partial, computedCostMicroUsd: PRICING.cost(partial) }
}

describe('usage monitoring workflow (Postgres)', () => {
  let pool: Pool
  let dbName: string

  beforeAll(async () => {
    const ctx = await createTestDatabase()
    pool = ctx.pool
    dbName = ctx.dbName
  }, 30_000)

  afterAll(async () => {
    await dropTestDatabase(pool, dbName)
  })

  beforeEach(async () => {
    // CASCADE because sync_outbox has a FK on events.id (slice 6).
    await pool.query('TRUNCATE TABLE events CASCADE')
  })

  it('parses Claude, Codex, Gemini, and local token usage into product aggregates', async () => {
    const now = new Date('2026-05-05T12:00:00.000Z')
    const timestamp = now.getTime()
    const root = await mkdtemp(join(tmpdir(), 'lcm-workflow-'))

    const claudeDir = join(root, 'claude', 'projects', '-tmp-product')
    await mkdir(claudeDir, { recursive: true })
    const claudeFile = join(claudeDir, 'claude-session.jsonl')
    await writeFile(
      claudeFile,
      JSON.stringify({
        type: 'assistant',
        timestamp: now.toISOString(),
        sessionId: 'claude-session',
        message: {
          id: 'claude-message',
          model: 'claude-3-5-sonnet-20240620',
          usage: {
            input_tokens: 1000,
            output_tokens: 100,
            cache_read_input_tokens: 200,
            cache_creation: { ephemeral_5m_input_tokens: 50 },
          },
        },
      }),
    )

    const codexFile = join(root, 'rollout-2026-05-05T12-00-00.jsonl')
    await writeFile(
      codexFile,
      [
        JSON.stringify({
          timestamp: now.toISOString(),
          type: 'session_meta',
          payload: { id: 'codex-session', cwd: '/Users/me/product' },
        }),
        JSON.stringify({
          timestamp: now.toISOString(),
          type: 'turn_context',
          payload: { model: 'gpt-5.5', turn_id: 'codex-turn' },
        }),
        JSON.stringify({
          timestamp: now.toISOString(),
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 500,
                output_tokens: 200,
                reasoning_output_tokens: 30,
              },
            },
          },
        }),
      ].join('\n'),
    )

    const geminiDir = join(root, 'gemini', 'tmp', 'gem-product', 'chats')
    await mkdir(geminiDir, { recursive: true })
    const geminiFile = join(geminiDir, 'session-1.jsonl')
    await writeFile(
      geminiFile,
      JSON.stringify({
        id: 'gemini-message',
        timestamp: now.toISOString(),
        type: 'gemini',
        model: 'gemini-3-flash-preview',
        tokens: { input: 1000, output: 50, tool: 10, thoughts: 30 },
      }),
    )

    const events = [
      ...(await parseClaudeFile(claudeFile, PRICING)),
      ...(await parseCodexFile(codexFile, PRICING)),
      ...(await parseGeminiFile(geminiFile, PRICING)),
      localEvent(timestamp),
    ]

    const repo = new EventRepository(pool)
    await repo.upsertMany(events)

    const agg = new Aggregator(pool)
    const snap = await agg.snapshot(now)
    const expectedCost = events.reduce((sum, e) => sum + e.computedCostMicroUsd, 0n)

    expect(events.map((e) => e.provider).sort()).toEqual(['anthropic', 'google', 'local', 'openai'])
    expect(events.find((e) => e.provider === 'local')?.computedCostMicroUsd).toBe(0n)
    expect(snap.today.costMicroUsd).toBe(expectedCost)
    expect(snap.today.inputTokens).toBe(12_500)
    expect(snap.today.outputTokens).toBe(2_360)
    expect(snap.today.reasoningTokens).toBe(60)
    expect(snap.today.eventCount).toBe(4)

    const localRow = snap.byProviderToday.find((p) => p.provider === 'local')
    expect(localRow?.costMicroUsd).toBe(0n)
    expect(localRow?.eventCount).toBe(1)
    expect(snap.dailyCostMicroUsd.at(-1)).toBe(expectedCost)
    const window = await repo.between(startOfDayMs(now), startOfDayMs(now) + 86_400_000)
    expect(window).toHaveLength(4)
  })
})
