import type { AIProvider } from '@shared/provider'
import { emptySnapshot, type UsageSnapshot } from '@shared/snapshot'

import { parseGemini, resolveGeminiHome } from '../../parsers/gemini'
import type { PricingTable } from '../../pricing/pricing-table'
import type { EventRepository } from '../../storage/event-repository'

export interface GoogleProviderDeps {
  pricing: PricingTable
  events: EventRepository
}

export class GoogleProvider implements AIProvider {
  readonly id = 'google'
  readonly name = 'Gemini'
  readonly cliCommand = 'gemini'
  readonly dashboardUrl = 'https://aistudio.google.com/app/usage'
  isEnabled = true

  private latest: UsageSnapshot | null = null
  private inflight: Promise<UsageSnapshot> | null = null

  constructor(private readonly deps: GoogleProviderDeps) {}

  snapshot(): UsageSnapshot | null {
    return this.latest
  }

  async isAvailable(): Promise<boolean> {
    const home = resolveGeminiHome()
    try {
      const fs = await import('node:fs/promises')
      const s = await fs.stat(`${home}/tmp`)
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
    const events = await parseGemini({ pricing: this.deps.pricing })
    if (events.length > 0) this.deps.events.upsertMany(events)
    const snap = emptySnapshot(this.id)
    this.latest = snap
    return snap
  }
}
