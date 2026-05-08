import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'

import type { UsageEvent } from '@shared/usage-event'
import type { PricingTable } from '../pricing/pricing-table'
import { buildEventId, readJsonlLines } from './jsonl'
import { simplifyProjectName } from './project-name'

export interface CodexParseOptions {
  codexHome?: string
  pricing: PricingTable
}

interface CodexLine {
  timestamp?: string
  type?: string
  payload?: {
    id?: string
    cwd?: string
    model?: string
    turn_id?: string
    type?: string
    info?: {
      last_token_usage?: {
        input_tokens?: number
        cached_input_tokens?: number
        output_tokens?: number
        reasoning_output_tokens?: number
      }
    }
  }
}

function readNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return 0
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['CODEX_HOME']
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.codex')
}

export async function discoverCodexJsonlFiles(codexHome: string): Promise<string[]> {
  const sessionsDir = join(codexHome, 'sessions')
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

// Project label for a Codex session — derive from the session_meta cwd.
// Falls back to the date-bucketed sessions dir if cwd missing.
function deriveProject(cwd: string | undefined, fallbackPath: string): { project: string; rawSlug: string } {
  if (cwd !== undefined && cwd.length > 0) {
    // Encode the cwd as a slug-ish string and simplify.
    const slug = cwd.replace(/^\/+/, '-').replace(/\//g, '-')
    return { project: simplifyProjectName(slug), rawSlug: slug }
  }
  return { project: basename(fallbackPath, '.jsonl'), rawSlug: fallbackPath }
}

export async function parseCodexFile(
  path: string,
  pricing: PricingTable,
): Promise<UsageEvent[]> {
  let currentModel = 'unknown'
  let currentTurnId: string | null = null
  let sessionId: string | null = null
  let cwd: string | undefined

  const events: UsageEvent[] = []

  for await (const line of readJsonlLines(path)) {
    const row = line.parsed as CodexLine
    if (row.type === 'session_meta') {
      sessionId = row.payload?.id ?? null
      cwd = row.payload?.cwd ?? cwd
      continue
    }
    if (row.type === 'turn_context') {
      const m = row.payload?.model
      if (typeof m === 'string' && m.length > 0) currentModel = m
      const tid = row.payload?.turn_id
      if (typeof tid === 'string') currentTurnId = tid
      continue
    }
    if (row.type !== 'event_msg' || row.payload?.type !== 'token_count') continue

    const last = row.payload.info?.last_token_usage
    if (last === undefined) continue

    const inputTokens = readNumber(last.input_tokens)
    const outputTokens = readNumber(last.output_tokens)
    const cacheReadTokens = readNumber(last.cached_input_tokens)
    const reasoningTokens = readNumber(last.reasoning_output_tokens)

    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && reasoningTokens === 0) {
      continue
    }

    const tsRaw = row.timestamp
    const timestamp = tsRaw !== undefined ? Date.parse(tsRaw) : Date.now()
    if (Number.isNaN(timestamp)) continue

    const { project, rawSlug } = deriveProject(cwd, path)

    const id = buildEventId([
      'openai',
      sessionId ?? path,
      currentTurnId ?? 'noturn',
      timestamp,
      line.offset,
    ])

    const partial: UsageEvent = {
      id,
      provider: 'openai',
      providerRawTag: null,
      model: currentModel,
      timestamp,
      project,
      projectRawSlug: rawSlug,
      sessionId,
      messageId: currentTurnId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      reasoningTokens: reasoningTokens > 0 ? reasoningTokens : null,
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

  return events
}

export async function parseCodex(opts: CodexParseOptions): Promise<UsageEvent[]> {
  const codexHome = opts.codexHome ?? resolveCodexHome()
  const files = await discoverCodexJsonlFiles(codexHome)
  const all: UsageEvent[] = []
  for (const f of files) {
    try {
      const events = await parseCodexFile(f, opts.pricing)
      all.push(...events)
    } catch (err) {
      console.warn(`codex parser: skipped ${relative(codexHome, f)}: ${(err as Error).message}`)
    }
  }
  return all
}
