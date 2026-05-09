import type { PlanInfo } from '@shared/plan-info'
import type { AIProvider } from '@shared/provider'
import { emptySnapshot, type UsageSnapshot } from '@shared/snapshot'

import { parseCodex, resolveCodexHome } from '../../parsers/codex'
import type { PricingTable } from '../../pricing/pricing-table'
import type { EventRepository } from '../../storage/event-repository'
import type { FileCache } from '../../storage/file-cache'
import { detectOpenAIPlan } from './plan'

export interface OpenAIProviderDeps {
  pricing: PricingTable
  events: EventRepository
  fileCache: FileCache
}

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai'
  readonly name = 'Codex'
  readonly cliCommand = 'codex'
  readonly dashboardUrl = 'https://platform.openai.com/usage'
  isEnabled = true

  private latest: UsageSnapshot | null = null
  private inflight: Promise<UsageSnapshot> | null = null

  constructor(private readonly deps: OpenAIProviderDeps) {}

  snapshot(): UsageSnapshot | null {
    return this.latest
  }

  async isAvailable(): Promise<boolean> {
    const home = resolveCodexHome()
    try {
      const fs = await import('node:fs/promises')
      const s = await fs.stat(`${home}/sessions`)
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
    return detectOpenAIPlan()
  }

  private async refreshImpl(): Promise<UsageSnapshot> {
    const events = await parseCodex({
      pricing: this.deps.pricing,
      fileCache: this.deps.fileCache,
    })
    if (events.length > 0) await this.deps.events.upsertMany(events)
    const snap = emptySnapshot(this.id)
    this.latest = snap
    return snap
  }
}
