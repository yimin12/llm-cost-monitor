import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'

import { canonical, inferred } from '@shared/provider-identity'
import type { UsageEvent } from '@shared/usage-event'
import type { PricingTable } from '../pricing/pricing-table'
import type { FileCache } from '../storage/file-cache'
import { buildEventId, readJsonlLines } from './jsonl'
import { simplifyProjectName } from './project-name'

// Cursor Agent CLI writes per-session JSONL rollouts under
// `<cursorHome>/agent/sessions/<date>/rollout-*.jsonl`. The shape is a hybrid:
// each line carries a `type` discriminator (session_meta / turn_context /
// token_count) similar to Codex, plus a `usage` block whose token keys mirror
// the upstream provider's API (Anthropic `input_tokens` / `output_tokens` /
// `cache_read_input_tokens` for Claude calls; OpenAI `prompt_tokens` /
// `completion_tokens` / `cached_tokens` for GPT calls; Gemini `input` /
// `output` / `cached` for Gemini calls).
//
// We normalize all three onto our own UsageEvent shape and canonicalize the
// `provider` field to `cursor` (the aggregator). The underlying vendor lives
// in `providerRawTag` so downstream consumers can split spend by model
// family if needed.
export interface CursorParseOptions {
  cursorHome?: string
  pricing: PricingTable
  fileCache?: FileCache
}

interface CursorUsage {
  // Anthropic-shaped fields
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  // OpenAI-shaped fields
  prompt_tokens?: number
  completion_tokens?: number
  cached_tokens?: number
  reasoning_tokens?: number
  // Gemini-shaped fields
  input?: number
  output?: number
  cached?: number
  thoughts?: number
}

interface CursorLine {
  timestamp?: string
  type?: string
  payload?: {
    id?: string
    cwd?: string
    model?: string
    provider?: string
    turn_id?: string
    type?: string
    usage?: CursorUsage
    info?: {
      usage?: CursorUsage
      last_token_usage?: CursorUsage
    }
  }
}

function readNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return 0
}

export function resolveCursorHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['CURSOR_HOME']
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.cursor')
}

// Discover Cursor Agent rollout files: `<cursorHome>/agent/sessions/**/rollout-*.jsonl`.
export async function discoverCursorJsonlFiles(cursorHome: string): Promise<string[]> {
  const sessionsDir = join(cursorHome, 'agent', 'sessions')
  const out: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let s
      try {
        s = await stat(full)
      } catch {
        continue
      }
      if (s.isDirectory()) {
        await walk(full)
      } else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
        out.push(full)
      }
    }
  }

  await walk(sessionsDir)
  return out
}

function deriveProject(cwd: string | undefined, fallbackPath: string): { project: string; rawSlug: string } {
  if (cwd !== undefined && cwd.length > 0) {
    const slug = cwd.replace(/^\/+/, '-').replace(/\//g, '-')
    return { project: simplifyProjectName(slug), rawSlug: slug }
  }
  return { project: basename(fallbackPath, '.jsonl'), rawSlug: fallbackPath }
}

// Normalize one of the three usage shapes into our 4 standard counters.
function normalizeUsage(u: CursorUsage): {
  input: number
  output: number
  cacheRead: number
  cacheCreation5m: number
  reasoning: number
} {
  const input = readNumber(u.input_tokens) || readNumber(u.prompt_tokens) || readNumber(u.input)
  const output = readNumber(u.output_tokens) || readNumber(u.completion_tokens) || readNumber(u.output)
  const cacheRead =
    readNumber(u.cache_read_input_tokens) || readNumber(u.cached_tokens) || readNumber(u.cached)
  const cacheCreation5m = readNumber(u.cache_creation_input_tokens)
  const reasoning = readNumber(u.reasoning_tokens) || readNumber(u.thoughts)
  return { input, output, cacheRead, cacheCreation5m, reasoning }
}

export async function parseCursorFile(
  path: string,
  pricing: PricingTable,
  fileCache?: FileCache,
): Promise<UsageEvent[]> {
  let resumeFromOffset = 0
  let fileSize = 0
  let fileMtime = 0
  if (fileCache !== undefined) {
    try {
      const s = await stat(path)
      fileSize = s.size
      fileMtime = Math.floor(s.mtimeMs)
      const cached = await fileCache.get(path)
      if (cached !== null && cached.mtime === fileMtime && cached.lastOffset === fileSize) {
        return []
      }
      if (cached !== null && cached.lastOffset > 0 && cached.lastOffset <= fileSize) {
        resumeFromOffset = cached.lastOffset
      }
    } catch {
      /* fall through to full parse */
    }
  }

  let currentModel = 'unknown'
  let currentProviderTag: string | null = null
  let currentTurnId: string | null = null
  let sessionId: string | null = null
  let cwd: string | undefined

  const events: UsageEvent[] = []

  for await (const line of readJsonlLines(path, { startOffset: resumeFromOffset })) {
    const row = line.parsed as CursorLine
    if (row.type === 'session_meta') {
      sessionId = row.payload?.id ?? null
      cwd = row.payload?.cwd ?? cwd
      continue
    }
    if (row.type === 'turn_context') {
      const m = row.payload?.model
      if (typeof m === 'string' && m.length > 0) currentModel = m
      const p = row.payload?.provider
      if (typeof p === 'string' && p.length > 0) currentProviderTag = p
      const tid = row.payload?.turn_id
      if (typeof tid === 'string') currentTurnId = tid
      continue
    }
    if (row.type !== 'event_msg' || row.payload?.type !== 'token_count') continue

    const u = row.payload.usage ?? row.payload.info?.last_token_usage ?? row.payload.info?.usage
    if (u === undefined) continue

    const norm = normalizeUsage(u)
    if (
      norm.input === 0 &&
      norm.output === 0 &&
      norm.cacheRead === 0 &&
      norm.cacheCreation5m === 0 &&
      norm.reasoning === 0
    ) {
      continue
    }

    const tsRaw = row.timestamp
    const timestamp = tsRaw !== undefined ? Date.parse(tsRaw) : Date.now()
    if (Number.isNaN(timestamp)) continue

    const { project, rawSlug } = deriveProject(cwd, path)

    // We anchor the canonical provider on `cursor` (the aggregator) but
    // record the upstream vendor — from the explicit provider tag if Cursor
    // wrote one, else inferred from model name — as providerRawTag.
    const rawTag =
      currentProviderTag !== null
        ? canonical(currentProviderTag) ?? currentProviderTag
        : inferred(currentModel)

    const id = buildEventId([
      'cursor',
      sessionId ?? path,
      currentTurnId ?? 'noturn',
      timestamp,
      line.offset,
    ])

    const partial: UsageEvent = {
      id,
      provider: 'cursor',
      providerRawTag: rawTag,
      model: currentModel,
      timestamp,
      project,
      projectRawSlug: rawSlug,
      sessionId,
      messageId: currentTurnId,
      inputTokens: norm.input,
      outputTokens: norm.output,
      cacheReadTokens: norm.cacheRead,
      cacheCreation5mTokens: norm.cacheCreation5m,
      cacheCreation1hTokens: 0,
      reasoningTokens: norm.reasoning > 0 ? norm.reasoning : null,
      toolCallCount: null,
      latencyMs: null,
      computedCostMicroUsd: 0n,
      pricingSnapshotVersion: pricing.snapshotVersion,
      sourceFile: path,
      sourceLineOffset: line.offset,
    }
    const cost = pricing.cost(partial)
    events.push({ ...partial, computedCostMicroUsd: cost })
  }

  if (fileCache !== undefined && fileSize > 0) {
    await fileCache.upsert({
      path,
      mtime: fileMtime,
      lastParsedAt: Date.now(),
      lastOffset: fileSize,
    })
  }

  return events
}

export async function parseCursor(opts: CursorParseOptions): Promise<UsageEvent[]> {
  const cursorHome = opts.cursorHome ?? resolveCursorHome()
  const files = await discoverCursorJsonlFiles(cursorHome)
  const all: UsageEvent[] = []
  for (const f of files) {
    try {
      const events = await parseCursorFile(f, opts.pricing, opts.fileCache)
      all.push(...events)
    } catch (err) {
      console.warn(`cursor parser: skipped ${relative(cursorHome, f)}: ${(err as Error).message}`)
    }
  }
  return all
}
