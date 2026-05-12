import type { PlanInfo } from '@shared/plan-info'
import type { AIProvider } from '@shared/provider'
import { emptySnapshot, type UsageSnapshot } from '@shared/snapshot'

import { parseCursor, resolveCursorHome } from '../../parsers/cursor'
import type { PricingTable } from '../../pricing/pricing-table'
import type { EventRepository } from '../../storage/event-repository'
import type { FileCache } from '../../storage/file-cache'
import { detectCursorPlan, resolveCursorStateDb } from './plan'

export interface CursorProviderDeps {
  pricing: PricingTable
  events: EventRepository
  fileCache: FileCache
}

export class CursorProvider implements AIProvider {
  readonly id = 'cursor'
  readonly name = 'Cursor'
  readonly cliCommand = 'cursor-agent'
  readonly dashboardUrl = 'https://cursor.com/dashboard'
  isEnabled = true

  private latest: UsageSnapshot | null = null
  private inflight: Promise<UsageSnapshot> | null = null

  constructor(private readonly deps: CursorProviderDeps) {}

  snapshot(): UsageSnapshot | null {
    return this.latest
  }

  async isAvailable(): Promise<boolean> {
    // Cursor surfaces on a machine via either:
    //   - the Cursor IDE (state.vscdb in the VS Code-style globalStorage), or
    //   - the cursor-agent CLI (~/.cursor/agent/).
    // Plan detection works off the first; usage-event parsing works off the
    // second. Either alone is "installed enough" to render the card as
    // active rather than dim.
    const fs = await import('node:fs/promises')
    try {
      await fs.stat(resolveCursorStateDb())
      return true
    } catch {
      /* fall through to cursor-agent check */
    }
    try {
      const s = await fs.stat(`${resolveCursorHome()}/agent`)
      return s.isDirectory()
    } catch {
      return false
    }
  }

  refresh(): Promise<UsageSnapshot> {
    if (this.inflight !== null) return this.inflight
    this.inflight = this.refreshImpl().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  getPlanInfo(): Promise<PlanInfo> {
    return detectCursorPlan()
  }

  private async refreshImpl(): Promise<UsageSnapshot> {
    const events = await parseCursor({
      pricing: this.deps.pricing,
      fileCache: this.deps.fileCache,
    })
    if (events.length > 0) await this.deps.events.upsertMany(events)
    const snap = emptySnapshot(this.id)
    this.latest = snap
    return snap
  }
}
