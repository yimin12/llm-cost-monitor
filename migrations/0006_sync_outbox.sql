-- Schema v6 — sync_outbox for batch-boundary-safe upload cursor.
--
-- The original sync queue advanced its cursor via event timestamp:
--
--    SELECT * FROM events WHERE timestamp > cursor AND timestamp <= now
--    -> upload -> cursor := max(timestamps in batch)
--
-- That has a real bug: when the batch is capped at MAX_BATCH_SIZE (500)
-- and the boundary lands on N events with the same `timestamp`, only
-- the K events that fit in the batch are uploaded, but the cursor is
-- advanced to that timestamp — leaving N-K events behind, never to be
-- retried. Local-log scrapers easily produce same-millisecond bursts
-- (Claude Code streaming chunks all share the message timestamp).
--
-- The fix is the outbox pattern: every persisted event also gets a row
-- in `sync_outbox` with a monotonically increasing `seq` (BIGSERIAL).
-- The queue reads from outbox WHERE seq > last_sent_seq, uploads, and
-- only on server ack moves last_sent_seq forward. Same-timestamp bursts
-- still advance correctly because seq is unique and gap-free per writer.
--
-- We also add `last_sent_seq` to sync_cursor; the legacy
-- `last_acknowledged_timestamp_ms` column is kept for backward compat
-- and observability, but the queue no longer drives off it.

CREATE TABLE IF NOT EXISTS sync_outbox (
  seq           BIGSERIAL PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  enqueued_at   BIGINT NOT NULL,
  sent_at       BIGINT
);
CREATE INDEX IF NOT EXISTS sync_outbox_pending_idx
  ON sync_outbox (seq) WHERE sent_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sync_outbox_event_id_uq
  ON sync_outbox (event_id);

ALTER TABLE sync_cursor
  ADD COLUMN IF NOT EXISTS last_sent_seq BIGINT NOT NULL DEFAULT 0;

INSERT INTO schema_version (version) VALUES (6)
ON CONFLICT (version) DO NOTHING;
