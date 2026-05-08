import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { parseClaude, parseClaudeFile } from '../../parsers/claude-code'
import { PricingTable } from '../../pricing/pricing-table'
import { openDatabase, type DatabaseHandle } from '../db'
import { FileCache } from '../file-cache'

const PRICING = PricingTable.fromBuffer(
  Buffer.from(
    JSON.stringify({
      'claude-3-5-sonnet-20240620': {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        litellm_provider: 'anthropic',
      },
    }),
  ),
)

function row(id: string, ts: string, input: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId: 'sess',
    message: {
      id,
      model: 'claude-3-5-sonnet-20240620',
      usage: { input_tokens: input, output_tokens: 100 },
    },
  })
}

describe('FileCache + parser', () => {
  let db: DatabaseHandle
  let cache: FileCache

  beforeEach(() => {
    db = openDatabase(':memory:')
    cache = new FileCache(db)
  })

  it('skips unchanged file on second parse (mtime + size match)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcm-fc-'))
    const file = join(dir, 'sess.jsonl')
    await writeFile(file, [row('m1', '2026-05-05T12:00:00Z', 100), row('m2', '2026-05-05T12:01:00Z', 200)].join('\n'))

    const first = await parseClaudeFile(file, PRICING, cache)
    expect(first).toHaveLength(2)

    // Second call with no file change — must short-circuit.
    const second = await parseClaudeFile(file, PRICING, cache)
    expect(second).toHaveLength(0)
  })

  it('on append, only re-parses new lines via offset resume', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcm-fc-'))
    const file = join(dir, 'sess.jsonl')
    await writeFile(file, row('m1', '2026-05-05T12:00:00Z', 100) + '\n')

    const first = await parseClaudeFile(file, PRICING, cache)
    expect(first).toHaveLength(1)

    // Touch mtime by appending two new rows.
    await appendFile(file, [row('m2', '2026-05-05T12:01:00Z', 200), row('m3', '2026-05-05T12:02:00Z', 300)].join('\n') + '\n')

    const second = await parseClaudeFile(file, PRICING, cache)
    // Only the new rows should be parsed.
    expect(second.map((e) => e.messageId).sort()).toEqual(['m2', 'm3'])
  })

  it('parseClaude across many files cuts re-parse cost on second pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lcm-fc-'))
    const projDir = join(root, 'projects', '-tmp-fast')
    await mkdir(projDir, { recursive: true })
    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(projDir, `sess-${i}.jsonl`),
        row(`m-${i}`, '2026-05-05T12:00:00Z', 1000) + '\n',
      )
    }

    const first = await parseClaude({ pricing: PRICING, claudeHome: root, fileCache: cache })
    expect(first).toHaveLength(5)
    const second = await parseClaude({ pricing: PRICING, claudeHome: root, fileCache: cache })
    // No file changed — every file should be skipped.
    expect(second).toHaveLength(0)
  })
})
