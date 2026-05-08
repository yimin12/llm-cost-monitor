import type { AIProvider } from '@shared/provider'
import { emptySnapshot, type UsageSnapshot } from '@shared/snapshot'

import { parseCodex, resolveCodexHome } from '../../parsers/codex'
import type { PricingTable } from '../../pricing/pricing-table'
import type { EventRepository } from '../../storage/event-repository'

export interface OpenAIProviderDeps {
  pricing: PricingTable
  events: EventRepository
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

  private async refreshImpl(): Promise<UsageSnapshot> {
    const events = await parseCodex({ pricing: this.deps.pricing })
    if (events.length > 0) this.deps.events.upsertMany(events)
    const snap = emptySnapshot(this.id)
    this.latest = snap
    return snap
  }
}
