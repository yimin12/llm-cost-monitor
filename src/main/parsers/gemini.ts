import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'

import type { UsageEvent } from '@shared/usage-event'
import type { PricingTable } from '../pricing/pricing-table'
import type { FileCache } from '../storage/file-cache'
import { buildEventId, readJsonlLines } from './jsonl'

export interface GeminiParseOptions {
  geminiHome?: string
  pricing: PricingTable
  fileCache?: FileCache
}

interface GeminiTokens {
  input?: number
  output?: number
  cached?: number
  thoughts?: number
  tool?: number
  total?: number
}

interface GeminiRow {
  id?: string
  timestamp?: string
  type?: string
  model?: string
  tokens?: GeminiTokens
}

function readNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return 0
}

export function resolveGeminiHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['GEMINI_HOME']
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.gemini')
}

// Discover Gemini chat sessions: `~/.gemini/tmp/<project>/chats/session-*.jsonl`.
export async function discoverGeminiJsonlFiles(geminiHome: string): Promise<string[]> {
  const tmpDir = join(geminiHome, 'tmp')
  let projectDirs: string[] = []
  try {
    projectDirs = await readdir(tmpDir)
  } catch {
    return []
  }

  const out: string[] = []
  for (const proj of projectDirs) {
    const chatsDir = join(tmpDir, proj, 'chats')
    let entries: string[] = []
    try {
      const s = await stat(chatsDir)
      if (!s.isDirectory()) continue
      entries = await readdir(chatsDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.startsWith('session-') && entry.endsWith('.jsonl')) {
        out.push(join(chatsDir, entry))
      }
    }
  }
  return out
}

export async function parseGeminiFile(
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
      const cached = fileCache.get(path)
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

  // Project label = the directory name two levels above the file
  // (`<geminiHome>/tmp/<PROJECT>/chats/session-*.jsonl`).
  const parts = path.split('/')
  const project = parts[parts.length - 3] ?? 'gemini'
  const sessionId = basename(path, '.jsonl')

  const events: UsageEvent[] = []

  for await (const line of readJsonlLines(path, { startOffset: resumeFromOffset })) {
    const row = line.parsed as GeminiRow
    if (row.tokens === undefined) continue

    const inputTokens = readNumber(row.tokens.input)
    const outputTokens = readNumber(row.tokens.output) + readNumber(row.tokens.tool)
    const cacheReadTokens = readNumber(row.tokens.cached)
    const reasoningTokens = readNumber(row.tokens.thoughts)

    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && reasoningTokens === 0) {
      continue
    }

    const tsRaw = row.timestamp
    const timestamp = tsRaw !== undefined ? Date.parse(tsRaw) : Date.now()
    if (Number.isNaN(timestamp)) continue

    const model = row.model ?? 'gemini-unknown'
    const messageId = row.id ?? null

    const id = buildEventId([
      'google',
      sessionId,
      messageId ?? `noid:${line.offset}`,
      timestamp,
    ])

    const partial: UsageEvent = {
      id,
      provider: 'google',
      providerRawTag: null,
      model,
      timestamp,
      project,
      projectRawSlug: project,
      sessionId,
      messageId,
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

  if (fileCache !== undefined && fileSize > 0) {
    fileCache.upsert({
      path,
      mtime: fileMtime,
      lastParsedAt: Date.now(),
      lastOffset: fileSize,
    })
  }

  return events
}

export async function parseGemini(opts: GeminiParseOptions): Promise<UsageEvent[]> {
  const geminiHome = opts.geminiHome ?? resolveGeminiHome()
  const files = await discoverGeminiJsonlFiles(geminiHome)
  const all: UsageEvent[] = []
  for (const f of files) {
    try {
      const events = await parseGeminiFile(f, opts.pricing, opts.fileCache)
      all.push(...events)
    } catch (err) {
      console.warn(`gemini parser: skipped ${relative(geminiHome, f)}: ${(err as Error).message}`)
    }
  }
  return all
}
