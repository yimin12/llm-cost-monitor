// Extension point for future cloud-sync features (Option B/C in
// docs/auth-plan.md). NOT implemented in any active code path on this
// branch — this file exists so callers don't have to invent the shape later
// when sync ships.
//
// The premise: every provider currently exposes a `LocalUsageProbe` (the
// JSONL-parsing + DB-upsert combo). A future "remote" probe would call into
// a cloud backend (the user's signed-in account) for either:
//   - aggregated rollups uploaded from another device (multi-device sync)
//   - vendor-billing-API calls relayed via a backend (CLI Pulse §12 model)
//
// Same `UsageSnapshot` shape comes back, so the dropdown UI doesn't care
// where the data originated.

import type { UsageSnapshot } from './snapshot'

export interface RemoteUsageProbe {
  // Cheap pre-flight: are we signed in + the backend is reachable?
  isAvailable(): Promise<boolean>

  // Fetch the latest cloud-side snapshot for this provider. Throws on hard
  // failure; UI should treat it as best-effort and degrade to local-only.
  fetchSnapshot(providerId: string): Promise<UsageSnapshot>
}

// Sentinel implementation — always unavailable. The provider registry can
// instantiate this as a placeholder until a real cloud backend exists.
export const noopRemoteProbe: RemoteUsageProbe = {
  async isAvailable() {
    return false
  },
  async fetchSnapshot() {
    throw new Error('RemoteUsageProbe: no cloud backend configured')
  },
}
