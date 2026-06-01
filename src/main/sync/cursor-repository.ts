import { namedQuery } from '../storage/db-utils'
import type { Pool } from '../storage/connect'

// Per-(team,user) sync cursor stored in `sync_cursor`. Single row per pair.
// The cursor is a high-water mark on event timestamp: events with
// `timestamp > last_acknowledged_timestamp_ms` are unsynced.
//
// We don't track which events were uploaded — we trust monotonic timestamps
// and the server's syncEventId-based dedup. This is correct because:
//   • Local events are append-only by timestamp.
//   • If the server has acknowledged ts=T, every row with timestamp ≤ T
//     either reached it or never will (and the operator is dropping them).
//   • Re-uploads of older rows are safe — server dedupes by sync_event_id.

export interface CursorRow {
  teamId: string
  userId: string
  // Legacy timestamp-based cursor. Kept for observability; the sync
  // queue now drives off `lastSentSeq` (see `0006_sync_outbox.sql`).
  lastAcknowledgedTimestampMs: number
  lastSentSeq: bigint
  lastSyncedAt: number | null
  lastError: string | null
}

interface CursorDbRow {
  team_id: string
  user_id: string
  last_acknowledged_timestamp_ms: bigint
  last_sent_seq: bigint
  last_synced_at: bigint | null
  last_error: string | null
}

function rowToCursor(r: CursorDbRow): CursorRow {
  return {
    teamId: r.team_id,
    userId: r.user_id,
    lastAcknowledgedTimestampMs: Number(r.last_acknowledged_timestamp_ms),
    lastSentSeq: r.last_sent_seq,
    lastSyncedAt: r.last_synced_at === null ? null : Number(r.last_synced_at),
    lastError: r.last_error,
  }
}

export class CursorRepository {
  constructor(private readonly pool: Pool) {}

  async get(teamId: string, userId: string): Promise<CursorRow | null> {
    const q = namedQuery(
      `SELECT team_id, user_id, last_acknowledged_timestamp_ms, last_sent_seq,
              last_synced_at, last_error
       FROM sync_cursor WHERE team_id = @team AND user_id = @user`,
      { team: teamId, user: userId },
    )
    const r = await this.pool.query<CursorDbRow>(q.text, q.values)
    return r.rows.length === 0 ? null : rowToCursor(r.rows[0]!)
  }

  // Upserts the cursor on a successful upload. Always advances forward —
  // both the seq cursor and the legacy timestamp watermark only ever
  // increase. Errors clear on success.
  async advance(
    teamId: string,
    userId: string,
    newSeq: bigint,
    newCursorMs: number,
    syncedAt: number,
  ): Promise<void> {
    const q = namedQuery(
      `INSERT INTO sync_cursor (team_id, user_id,
         last_acknowledged_timestamp_ms, last_sent_seq,
         last_synced_at, last_error)
       VALUES (@team, @user, @cursor, @seq, @synced, NULL)
       ON CONFLICT (team_id, user_id) DO UPDATE SET
         last_acknowledged_timestamp_ms = GREATEST(
           sync_cursor.last_acknowledged_timestamp_ms, EXCLUDED.last_acknowledged_timestamp_ms),
         last_sent_seq = GREATEST(
           sync_cursor.last_sent_seq, EXCLUDED.last_sent_seq),
         last_synced_at = EXCLUDED.last_synced_at,
         last_error = NULL`,
      {
        team: teamId,
        user: userId,
        cursor: BigInt(newCursorMs),
        seq: newSeq,
        synced: BigInt(syncedAt),
      },
    )
    await this.pool.query(q.text, q.values)
  }

  async recordError(teamId: string, userId: string, message: string): Promise<void> {
    const q = namedQuery(
      `INSERT INTO sync_cursor (team_id, user_id,
         last_acknowledged_timestamp_ms, last_sent_seq, last_synced_at, last_error)
       VALUES (@team, @user, 0, 0, NULL, @msg)
       ON CONFLICT (team_id, user_id) DO UPDATE SET
         last_error = EXCLUDED.last_error`,
      { team: teamId, user: userId, msg: message },
    )
    await this.pool.query(q.text, q.values)
  }
}
