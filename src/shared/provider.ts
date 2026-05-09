import type { PlanInfo } from './plan-info'
import type { UsageSnapshot } from './snapshot'

// User-facing provider — what the menubar UI binds to via IPC.
// Shape ported from tddworks/ClaudeBar's AIProvider; see docs/architecture.md D3.
export interface AIProvider {
  // Canonical id ("anthropic", "openai", "google", "moonshotai", ...).
  // Source the canonical form from `canonical(...)` in `provider-identity.ts`.
  readonly id: string
  readonly name: string

  // CLI command users would invoke to use this provider directly
  // (powers "Open in Terminal" affordances).
  readonly cliCommand: string | null

  // Vendor's billing/usage dashboard URL (deep link from the menubar).
  readonly dashboardUrl: string | null

  isEnabled: boolean

  // Latest snapshot, null before first refresh.
  snapshot(): UsageSnapshot | null
  isAvailable(): Promise<boolean>
  refresh(): Promise<UsageSnapshot>

  // Whether the user is on a subscription (Pro/Max/Plus/Team/...) or paying
  // via API key, and which plan if known. Reads local auth files; no network.
  getPlanInfo(): Promise<PlanInfo>
}

// Internal data fetcher. Providers may compose multiple probes —
// e.g. a LocalSessionProbe (JSONL) + an APIProbe (vendor billing) + a CLIQuotaProbe.
export interface UsageProbe {
  probe(): Promise<UsageSnapshot>
  isAvailable(): Promise<boolean>
}

export type ProbeErrorKind =
  | 'cliNotFound'
  | 'credentialMissing'
  | 'parseFailed'
  | 'executionFailed'
  | 'timeout'
  | 'unsupportedFormat'

// Errors that probes raise. UI should treat unknown kinds as the generic
// `executionFailed` case; the kind discriminator is for telemetry + UI hints.
export class ProbeError extends Error {
  readonly kind: ProbeErrorKind
  readonly detail: string | null

  constructor(kind: ProbeErrorKind, detail: string | null = null) {
    super(detail !== null ? `${kind}: ${detail}` : kind)
    this.name = 'ProbeError'
    this.kind = kind
    this.detail = detail
  }

  static cliNotFound(cli: string): ProbeError {
    return new ProbeError('cliNotFound', cli)
  }
  static credentialMissing(field: string): ProbeError {
    return new ProbeError('credentialMissing', field)
  }
  static parseFailed(reason: string): ProbeError {
    return new ProbeError('parseFailed', reason)
  }
  static executionFailed(reason: string): ProbeError {
    return new ProbeError('executionFailed', reason)
  }
  static timeout(): ProbeError {
    return new ProbeError('timeout')
  }
  static unsupportedFormat(format: string): ProbeError {
    return new ProbeError('unsupportedFormat', format)
  }
}
