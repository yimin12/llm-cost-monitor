import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PricingTable } from '../../pricing/pricing-table'
import { parseClaude, parseClaudeFile } from '../claude-code'
import { parseCodex, parseCodexFile } from '../codex'
import { parseCursor, parseCursorFile } from '../cursor'
import { parseGemini, parseGeminiFile } from '../gemini'
import { simplifyProjectName } from '../project-name'

const SYNTHETIC = Buffer.from(
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
    'gpt-5.5': {
      input_cost_per_token: 0.00000125,
      output_cost_per_token: 0.00001,
      max_input_tokens: 200000,
      litellm_provider: 'openai',
    },
    'gemini-3-flash-preview': {
      input_cost_per_token: 0.0000001,
      output_cost_per_token: 0.0000004,
      max_input_tokens: 1000000,
      litellm_provider: 'google',
    },
  }),
)

const PRICING = PricingTable.fromBuffer(SYNTHETIC)

describe('simplifyProjectName', () => {
  it('strips leading dash and takes last 3 segments for long slugs', () => {
    expect(simplifyProjectName('-Volumes-Portal-SSD-pojo-llm-cost-monitor')).toBe(
      'llm-cost-monitor',
    )
    expect(simplifyProjectName('-Users-ymh-Documents-knowledge-graph-YiminH')).toBe(
      'knowledge-graph-YiminH',
    )
  })
  it('preserves shorter slugs as-is', () => {
    expect(simplifyProjectName('-pojo')).toBe('pojo')
    expect(simplifyProjectName('-foo-bar')).toBe('foo-bar')
  })
})

describe('parseClaudeFile', () => {
  it('parses message.usage rows with new cache_creation shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcm-'))
    const projDir = join(dir, 'projects', '-tmp-fake')
    await mkdir(projDir, { recursive: true })
    const file = join(projDir, 'sess-1.jsonl')
    const lines = [
      // assistant row with new cache_creation shape
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-05T12:00:00.000Z',
        sessionId: 'sess-1',
        message: {
          id: 'msg-a',
          model: 'claude-3-5-sonnet-20240620',
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 200,
            cache_creation: {
              ephemeral_5m_input_tokens: 100,
              ephemeral_1h_input_tokens: 50,
            },
          },
        },
      }),
      // assistant row with OLD cache_creation_input_tokens shape
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-05T12:01:00.000Z',
        sessionId: 'sess-1',
        message: {
          id: 'msg-b',
          model: 'claude-3-5-sonnet-20240620',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 80,
          },
        },
      }),
      // duplicate of msg-a with MORE complete usage (must win)
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-05T12:00:01.000Z',
        sessionId: 'sess-1',
        message: {
          id: 'msg-a',
          model: 'claude-3-5-sonnet-20240620',
          usage: {
            input_tokens: 1100,
            output_tokens: 600,
          },
        },
      }),
      // a malformed line (must be skipped)
      'not-json{',
      // a row without usage (must be skipped)
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    ]
    await writeFile(file, lines.join('\n'))

    const events = await parseClaudeFile(file, PRICING)
    expect(events).toHaveLength(2)

    const a = events.find((e) => e.messageId === 'msg-a')
    const b = events.find((e) => e.messageId === 'msg-b')
    expect(a?.inputTokens).toBe(1100)
    expect(a?.outputTokens).toBe(600)
    expect(b?.cacheCreation5mTokens).toBe(80)
    expect(b?.cacheCreation1hTokens).toBe(0)

    expect(a?.provider).toBe('anthropic')
    expect(a?.computedCostMicroUsd).toBeGreaterThan(0n)
  })

  it('discovers + parses across multiple project dirs via parseClaude', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcm-'))
    const proj1 = join(dir, 'projects', '-tmp-a')
    const proj2 = join(dir, 'projects', '-tmp-b')
    await mkdir(proj1, { recursive: true })
    await mkdir(proj2, { recursive: true })
    const sample = JSON.stringify({
      timestamp: '2026-05-05T12:00:00.000Z',
      sessionId: 's',
      message: {
        id: 'm',
        model: 'claude-3-5-sonnet-20240620',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    })
    await writeFile(join(proj1, 'a.jsonl'), sample)
    await writeFile(
      join(proj2, 'b.jsonl'),
      JSON.stringify({
        timestamp: '2026-05-05T12:00:00.000Z',
        sessionId: 's',
        message: {
          id: 'mm',
          model: 'claude-3-5-sonnet-20240620',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    )

    const events = await parseClaude({ pricing: PRICING, claudeHome: dir })
    expect(events).toHaveLength(2)
  })
})

describe('parseCodexFile', () => {
  it('extracts last_token_usage from event_msg/token_count rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcm-'))
    const file = join(dir, 'rollout-2026-05-05T12-00-00-x.jsonl')
    const lines = [
      JSON.stringify({
        timestamp: '2026-05-05T12:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'sess', cwd: '/Users/me/projects/foo' },
      }),
      JSON.stringify({
        timestamp: '2026-05-05T12:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.5', turn_id: 'turn-1', cwd: '/Users/me/projects/foo' },
      }),
      JSON.stringify({
        timestamp: '2026-05-05T12:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 500,
              cached_input_tokens: 100,
              output_tokens: 200,
              reasoning_output_tokens: 30,
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-05T12:00:03.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete' },
      }),
    ]
    await writeFile(file, lines.join('\n'))

    const events = await parseCodexFile(file, PRICING)
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.provider).toBe('openai')
    expect(e.model).toBe('gpt-5.5')
    expect(e.inputTokens).toBe(500)
    expect(e.outputTokens).toBe(200)
    expect(e.cacheReadTokens).toBe(100)
    expect(e.reasoningTokens).toBe(30)
    expect(e.computedCostMicroUsd).toBeGreaterThan(0n)
  })

  it('discovers rollout files recursively under sessions/<date>/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcm-'))
    const sub = join(dir, 'sessions', '2026', '05', '05')
    await mkdir(sub, { recursive: true })
    const lines = [
      JSON.stringify({ timestamp: '2026-05-05T12:00:00.000Z', type: 'session_meta', payload: { id: 's' } }),
      JSON.stringify({ timestamp: '2026-05-05T12:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5', turn_id: 't' } }),
      JSON.stringify({
        timestamp: '2026-05-05T12:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } },
        },
      }),
    ]
    await writeFile(join(sub, 'rollout-foo.jsonl'), lines.join('\n'))
    const events = await parseCodex({ pricing: PRICING, codexHome: dir })
    expect(events).toHaveLength(1)
  })
})

describe('parseGeminiFile', () => {
  it('extracts tokens from session JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcm-'))
    const file = join(dir, 'session-2026-05-05.jsonl')
    const lines = [
      JSON.stringify({
        id: 'g-1',
        timestamp: '2026-05-05T12:00:00.000Z',
        type: 'gemini',
        model: 'gemini-3-flash-preview',
        tokens: { input: 1000, output: 50, cached: 200, thoughts: 30, tool: 10, total: 1290 },
      }),
      JSON.stringify({ id: 'u-1', timestamp: '2026-05-05T12:00:00.000Z', type: 'user', content: 'hi' }),
    ]
    await writeFile(file, lines.join('\n'))

    const events = await parseGeminiFile(file, PRICING)
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.provider).toBe('google')
    expect(e.inputTokens).toBe(1000)
    // tool tokens fold into output (no dedicated bucket).
    expect(e.outputTokens).toBe(60)
    expect(e.cacheReadTokens).toBe(200)
    expect(e.reasoningTokens).toBe(30)
    expect(e.computedCostMicroUsd).toBeGreaterThan(0n)
  })

  it('discovers chats under tmp/<project>/chats/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcm-'))
    const sub = join(dir, 'tmp', 'foo', 'chats')
    await mkdir(sub, { recursive: true })
    await writeFile(
      join(sub, 'session-1.jsonl'),
      JSON.stringify({
        id: 'g',
        timestamp: '2026-05-05T12:00:00.000Z',
        type: 'gemini',
        model: 'gemini-3-flash-preview',
        tokens: { input: 100, output: 10 },
      }),
    )
    const events = await parseGemini({ pricing: PRICING, geminiHome: dir })
    expect(events).toHaveLength(1)
    expect(events[0]!.project).toBe('foo')
  })
})

describe('parseCursorFile', () => {
  it('normalises Anthropic-shaped usage and tags upstream provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcm-'))
    const file = join(dir, 'rollout-2026-05-05T12-00-00-x.jsonl')
    const lines = [
      JSON.stringify({
        timestamp: '2026-05-05T12:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'sess-1', cwd: '/Users/me/projects/foo' },
      }),
      JSON.stringify({
        timestamp: '2026-05-05T12:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'claude-3-5-sonnet-20240620', provider: 'anthropic', turn_id: 't1' },
      }),
      JSON.stringify({
        timestamp: '2026-05-05T12:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          usage: {
            input_tokens: 800,
            output_tokens: 400,
            cache_read_input_tokens: 100,
          },
        },
      }),
    ]
    await writeFile(file, lines.join('\n'))

    const events = await parseCursorFile(file, PRICING)
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.provider).toBe('cursor')
    expect(e.providerRawTag).toBe('anthropic')
    expect(e.model).toBe('claude-3-5-sonnet-20240620')
    expect(e.inputTokens).toBe(800)
    expect(e.outputTokens).toBe(400)
    expect(e.cacheReadTokens).toBe(100)
    // Cursor uses Anthropic Sonnet pricing under the hood — cost > 0.
    expect(e.computedCostMicroUsd).toBeGreaterThan(0n)
  })

  it('normalises OpenAI-shaped usage with prompt/completion field names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcm-'))
    const file = join(dir, 'rollout-openai.jsonl')
    const lines = [
      JSON.stringify({ timestamp: '2026-05-05T12:00:00.000Z', type: 'session_meta', payload: { id: 's' } }),
      JSON.stringify({
        timestamp: '2026-05-05T12:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.5', turn_id: 't' },
      }),
      JSON.stringify({
        timestamp: '2026-05-05T12:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              prompt_tokens: 200,
              completion_tokens: 100,
              cached_tokens: 50,
              reasoning_tokens: 20,
            },
          },
        },
      }),
    ]
    await writeFile(file, lines.join('\n'))

    const events = await parseCursorFile(file, PRICING)
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.provider).toBe('cursor')
    // No explicit provider tag — inferred from gpt-5.5 model name.
    expect(e.providerRawTag).toBe('openai')
    expect(e.inputTokens).toBe(200)
    expect(e.outputTokens).toBe(100)
    expect(e.cacheReadTokens).toBe(50)
    expect(e.reasoningTokens).toBe(20)
  })

  it('discovers rollout files recursively under agent/sessions/<date>/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcm-'))
    const sub = join(dir, 'agent', 'sessions', '2026', '05', '05')
    await mkdir(sub, { recursive: true })
    const lines = [
      JSON.stringify({ timestamp: '2026-05-05T12:00:00.000Z', type: 'session_meta', payload: { id: 's' } }),
      JSON.stringify({
        timestamp: '2026-05-05T12:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.5', turn_id: 't' },
      }),
      JSON.stringify({
        timestamp: '2026-05-05T12:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      }),
    ]
    await writeFile(join(sub, 'rollout-foo.jsonl'), lines.join('\n'))
    const events = await parseCursor({ pricing: PRICING, cursorHome: dir })
    expect(events).toHaveLength(1)
    expect(events[0]!.provider).toBe('cursor')
  })

  it('returns [] when cursor home does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcm-'))
    const events = await parseCursor({ pricing: PRICING, cursorHome: join(dir, 'nope') })
    expect(events).toEqual([])
  })
})
