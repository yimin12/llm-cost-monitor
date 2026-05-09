import { randomUUID } from 'node:crypto'

import { namedQuery } from '../storage/db-utils'
import type { Pool } from '../storage/connect'

// Local node identity is a single SQL row in `local_node`. We read it on
// startup and create one if missing. NodeId is *opaque* — we never derive
// it from MAC addresses or hostnames so reinstalls on the same hardware
// don't accidentally collide on the server.

export interface NodeIdentity {
  nodeId: string
  displayName: string | null
  platform: string
  appVersion: string | null
  createdAt: number
  lastActiveAt: number
}

interface LocalNodeRow {
  node_id: string
  display_name: string | null
  platform: string
  app_version: string | null
  created_at: bigint
  last_active_at: bigint
}

function rowToIdentity(r: LocalNodeRow): NodeIdentity {
  return {
    nodeId: r.node_id,
    displayName: r.display_name,
    platform: r.platform,
    appVersion: r.app_version,
    createdAt: Number(r.created_at),
    lastActiveAt: Number(r.last_active_at),
  }
}

export interface NodeIdentityDeps {
  // Override for tests. Production passes process.platform.
  platform?: string
  // Override for tests. Production passes app.getVersion() or null.
  appVersion?: string | null
  // Override for tests so we get deterministic ids.
  newId?: () => string
  // Override for tests so we control "now".
  now?: () => number
}

export class NodeIdentityRepository {
  private readonly platform: string
  private readonly appVersion: string | null
  private readonly newId: () => string
  private readonly now: () => number

  constructor(
    private readonly pool: Pool,
    deps: NodeIdentityDeps = {},
  ) {
    this.platform = deps.platform ?? process.platform
    this.appVersion = deps.appVersion ?? null
    this.newId = deps.newId ?? randomUUID
    this.now = deps.now ?? (() => Date.now())
  }

  // Read-or-create. Idempotent: invoking twice returns the same identity.
  async ensure(): Promise<NodeIdentity> {
    const existing = await this.pool.query<LocalNodeRow>(
      `SELECT node_id, display_name, platform, app_version, created_at, last_active_at
       FROM local_node WHERE singleton_pk = 'self'`,
    )
    if (existing.rows.length > 0) {
      const row = existing.rows[0]!
      // Touch lastActive so the team dashboard's stale-node detection works
      // even when no sync uploads happen for a while.
      await this.touch()
      return rowToIdentity(row)
    }

    const created = this.now()
    const q = namedQuery(
      `INSERT INTO local_node
         (singleton_pk, node_id, display_name, platform, app_version,
          created_at, last_active_at)
       VALUES ('self', @node_id, NULL, @platform, @app_version,
               @created_at, @last_active_at)
       RETURNING node_id, display_name, platform, app_version,
                 created_at, last_active_at`,
      {
        node_id: this.newId(),
        platform: this.platform,
        app_version: this.appVersion,
        created_at: BigInt(created),
        last_active_at: BigInt(created),
      },
    )
    const r = await this.pool.query<LocalNodeRow>(q.text, q.values)
    return rowToIdentity(r.rows[0]!)
  }

  // Cheap update of last_active_at. Used by the sync loop and on app focus.
  async touch(): Promise<void> {
    const q = namedQuery(
      `UPDATE local_node SET last_active_at = @t WHERE singleton_pk = 'self'`,
      { t: BigInt(this.now()) },
    )
    await this.pool.query(q.text, q.values)
  }

  // Lets the user pick a friendly label ("MacBook Pro work", "linux-laptop")
  // that the team dashboard surfaces alongside the opaque nodeId.
  async setDisplayName(name: string | null): Promise<void> {
    const q = namedQuery(
      `UPDATE local_node SET display_name = @name WHERE singleton_pk = 'self'`,
      { name },
    )
    await this.pool.query(q.text, q.values)
  }
}
