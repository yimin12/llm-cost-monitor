import type { PlanInfo } from '@shared/plan-info'
import type { AIProvider } from '@shared/provider'

import type { PricingTable } from '../pricing/pricing-table'
import type { EventRepository } from '../storage/event-repository'
import type { FileCache } from '../storage/file-cache'
import { AnthropicProvider } from './anthropic/index'
import { CursorProvider } from './cursor/index'
import { GoogleProvider } from './google/index'
import { OpenAIProvider } from './openai/index'

export interface ProviderRegistryDeps {
  pricing: PricingTable
  events: EventRepository
  fileCache: FileCache
  // Provider-specific runtime state. `googlePlanCachePath` points at a
  // small JSON file (typically `<userData>/google-plan-cache.json`) where
  // detectGooglePlan persists the last-known-good tier — keeps the chip
  // stable across the Gemini CLI's ~1-hour token expiry windows.
  googlePlanCachePath?: string | null
}

export interface ProviderInfo {
  id: string
  name: string
  isEnabled: boolean
  isAvailable: boolean
  cliCommand: string | null
  dashboardUrl: string | null
  plan: PlanInfo
}

export class ProviderRegistry {
  readonly providers: AIProvider[]

  constructor(deps: ProviderRegistryDeps) {
    this.providers = [
      new AnthropicProvider(deps),
      new OpenAIProvider(deps),
      new GoogleProvider({ ...deps, planCachePath: deps.googlePlanCachePath ?? null }),
      new CursorProvider(deps),
    ]
  }

  async describe(): Promise<ProviderInfo[]> {
    return Promise.all(
      this.providers.map(async (p) => ({
        id: p.id,
        name: p.name,
        isEnabled: p.isEnabled,
        isAvailable: await p.isAvailable(),
        cliCommand: p.cliCommand,
        dashboardUrl: p.dashboardUrl,
        plan: await p.getPlanInfo(),
      })),
    )
  }

  async refreshAll(): Promise<{ provider: string; eventsCount: number; error: string | null }[]> {
    const results: { provider: string; eventsCount: number; error: string | null }[] = []
    for (const p of this.providers) {
      if (!p.isEnabled) {
        results.push({ provider: p.id, eventsCount: 0, error: null })
        continue
      }
      try {
        await p.refresh()
        results.push({ provider: p.id, eventsCount: 0, error: null })
      } catch (err) {
        results.push({
          provider: p.id,
          eventsCount: 0,
          error: (err as Error).message,
        })
      }
    }
    return results
  }
}
