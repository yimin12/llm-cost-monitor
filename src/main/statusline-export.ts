import { writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Aggregator } from './aggregation/aggregator'

// Writes today's total cost to a small JSON file under the app's
// userData directory. Read by `bin/devbar-statusline.js` (the Claude
// Code statusline command).
//
// The file is rewritten atomically (tmp + rename) so a partially-flushed
// write can never be observed by a concurrent reader. Tiny payload, so
// even on every refresh tick this is essentially free.

export interface StatuslineExport {
  todayUsd: number
  generatedAt: number
  // Schema version — bump if the consumer's parser ever needs to
  // distinguish formats.
  v: 1
}

export class StatuslineExporter {
  constructor(
    private readonly userDataDir: string,
    private readonly aggregator: Aggregator,
  ) {}

  private get filePath(): string {
    return join(this.userDataDir, 'statusline.json')
  }

  async write(): Promise<void> {
    const snap = await this.aggregator.snapshot()
    const payload: StatuslineExport = {
      todayUsd: Number(snap.today.costMicroUsd) / 1_000_000,
      generatedAt: snap.generatedAt,
      v: 1,
    }
    const tmp = `${this.filePath}.tmp`
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(tmp, JSON.stringify(payload), 'utf8')
    await rename(tmp, this.filePath)
  }
}
