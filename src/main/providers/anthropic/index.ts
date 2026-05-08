import type { AIProvider } from '@shared/provider'
import { emptySnapshot, type UsageSnapshot } from '@shared/snapshot'

import { parseClaude, resolveClaudeHome } from '../../parsers/claude-code'
import type { PricingTable } from '../../pricing/pricing-table'
import type { EventRepository } from '../../storage/event-repository'

export interface AnthropicProviderDeps {
  pricing: PricingTable
  events: EventRepository
}

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic'
  readonly name = 'Claude Code'
  readonly cliCommand = 'claude'
  readonly dashboardUrl = 'https://console.anthropic.com/settings/usage'
  isEnabled = true

  private latest: UsageSnapshot | null = null
  private inflight: Promise<UsageSnapshot> | null = null

  constructor(private readonly deps: AnthropicProviderDeps) {}

  snapshot(): UsageSnapshot | null {
    return this.latest
  }

  async isAvailable(): Promise<boolean> {
    // We're "available" iff `<claudeHome>/projects/` exists. The parser's
    // discovery returns [] silently if not — so just delegate.
    const home = resolveClaudeHome()
    try {
      const fs = await import('node:fs/promises')
      const s = await fs.stat(`${home}/projects`)
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
    const events = await parseClaude({ pricing: this.deps.pricing })
    if (events.length > 0) this.deps.events.upsertMany(events)
    const snap = emptySnapshot(this.id)
    this.latest = snap
    return snap
  }
}
