import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { canonical, inferred } from '@shared/provider-identity'
import type { UsageEvent } from '@shared/usage-event'
import type { PricingTable } from '../pricing/pricing-table'
import { buildEventId, readJsonlLines } from './jsonl'
import { simplifyProjectName } from './project-name'

export interface ClaudeCodeParseOptions {
  // Override `~/.claude` location. CLAUDE_CONFIG_DIR env wins over this.
  claudeHome?: string
  // Pricing table for cost computation.
  pricing: PricingTable
}

interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

interface ClaudeRow {
  type?: string
  timestamp?: string
  sessionId?: string
  cwd?: string
  message?: {
    id?: string
    role?: string
    model?: string
    usage?: ClaudeUsage
  }
}

function readNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return 0
}

export function resolveClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['CLAUDE_CONFIG_DIR']
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.claude')
}

export async function discoverClaudeJsonlFiles(claudeHome: string): Promise<string[]> {
  const projectsDir = join(claudeHome, 'projects')
  let projectEntries: string[] = []
  try {
    projectEntries = await readdir(projectsDir)
  } catch {
    return []
  }

  const out: string[] = []
  for (const slug of projectEntries) {
    const projectDir = join(projectsDir, slug)
    let s
    try {
      s = await stat(projectDir)
    } catch {
      continue
    }
    if (!s.isDirectory()) continue
    let files: string[] = []
    try {
      files = await readdir(projectDir)
    } catch {
      continue
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) out.push(join(projectDir, f))
    }
  }
  return out
}

// Parse one JSONL file. Returns deduplicated UsageEvents. Rules from
// docs/architecture.md D7 + research/SYNTHESIS.md.
export async function parseClaudeFile(
  path: string,
  pricing: PricingTable,
): Promise<UsageEvent[]> {
  // Slug = parent directory name. Last path segment of file = sessionId.
  const parts = path.split('/')
  const fileBase = parts[parts.length - 1] ?? ''
  const slug = parts[parts.length - 2] ?? ''
  const sessionId = fileBase.replace(/\.jsonl$/, '')

  const project = simplifyProjectName(slug)

  // First pass: collect rows with usage. Within a single file, multiple
  // rows may share message.id (streaming chunks); keep the LAST per id —
  // later chunks have more complete usage counts.
  const byMessageId = new Map<string, { row: ClaudeRow; offset: number }>()
  const noIdRows: { row: ClaudeRow; offset: number }[] = []

  for await (const line of readJsonlLines(path)) {
    const row = line.parsed as ClaudeRow
    if (row?.message?.usage === undefined) continue
    const messageId = row.message.id
    if (messageId !== undefined && messageId.length > 0) {
      byMessageId.set(messageId, { row, offset: line.offset })
    } else {
      noIdRows.push({ row, offset: line.offset })
    }
  }

  const events: UsageEvent[] = []

  const finalize = (row: ClaudeRow, offset: number, messageId: string | null): void => {
    const usage = row.message?.usage ?? {}
    const model = row.message?.model ?? 'unknown'
    const tsRaw = row.timestamp
    const timestamp = tsRaw !== undefined ? Date.parse(tsRaw) : Date.now()
    if (Number.isNaN(timestamp)) return

    // Cache normalization (D7 step 7):
    //  - If old `cache_creation_input_tokens` non-zero → all to 5m bucket.
    //  - Else read split fields under `cache_creation`.
    const oldCacheCreation = readNumber(usage.cache_creation_input_tokens)
    let cacheCreation5m = 0
    let cacheCreation1h = 0
    if (oldCacheCreation > 0) {
      cacheCreation5m = oldCacheCreation
    } else {
      cacheCreation5m = readNumber(usage.cache_creation?.ephemeral_5m_input_tokens)
      cacheCreation1h = readNumber(usage.cache_creation?.ephemeral_1h_input_tokens)
    }

    const inputTokens = readNumber(usage.input_tokens)
    const outputTokens = readNumber(usage.output_tokens)
    const cacheReadTokens = readNumber(usage.cache_read_input_tokens)

    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreation5m === 0 && cacheCreation1h === 0) {
      return
    }

    // Provider canonicalization. The "model" is the source of truth here —
    // Claude Code doesn't tag a separate provider field, so infer from model.
    const providerCanonical = canonical(model) ?? inferred(model) ?? 'anthropic'

    const id = buildEventId([
      'anthropic',
      sessionId,
      messageId ?? `noid:${offset}`,
      timestamp,
    ])

    const partial: UsageEvent = {
      id,
      provider: providerCanonical,
      providerRawTag: null,
      model,
      timestamp,
      project,
      projectRawSlug: slug,
      sessionId,
      messageId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreation5mTokens: cacheCreation5m,
      cacheCreation1hTokens: cacheCreation1h,
      reasoningTokens: null,
      toolCallCount: null,
      latencyMs: null,
      computedCostMicroUsd: 0n,
      pricingSnapshotVersion: pricing.snapshotVersion,
      sourceFile: path,
      sourceLineOffset: offset,
    }
    const cost = pricing.cost(partial)
    events.push({ ...partial, computedCostMicroUsd: cost })
  }

  for (const [id, { row, offset }] of byMessageId) finalize(row, offset, id)
  for (const { row, offset } of noIdRows) finalize(row, offset, null)

  return events
}

export async function parseClaude(opts: ClaudeCodeParseOptions): Promise<UsageEvent[]> {
  const claudeHome = opts.claudeHome ?? resolveClaudeHome()
  const files = await discoverClaudeJsonlFiles(claudeHome)
  const all: UsageEvent[] = []
  for (const f of files) {
    try {
      const events = await parseClaudeFile(f, opts.pricing)
      all.push(...events)
    } catch (err) {
      // Skip unreadable files — log and continue.
      console.warn(`claude parser: skipped ${basename(f)}: ${(err as Error).message}`)
    }
  }
  return all
}
