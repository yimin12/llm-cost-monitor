-- Schema v4 — local node identity + per-team sync cursor + audit log.
--
-- Sync is opt-in. These tables exist on every install but stay empty
-- until the user enables sync in Settings. Nothing here changes the
-- hot read/write path of the events table; the sync queue queries
-- events via timestamp > cursor and never blocks parsing.

-- One row per install. The `node_id` is the stable identifier this
-- machine uses when uploading rows to the team backend. Generated once
-- at first startup; persisted forever (so re-installs from the same
-- userData dir keep their identity, while a fresh install gets a new id).
CREATE TABLE IF NOT EXISTS local_node (
  -- A constant value so we can upsert without a primary-key conflict.
  -- We never have more than one row per install.
  singleton_pk        TEXT PRIMARY KEY DEFAULT 'self' CHECK (singleton_pk = 'self'),
  node_id             TEXT NOT NULL,
  display_name        TEXT,
  platform            TEXT NOT NULL,
  app_version         TEXT,
  created_at          BIGINT NOT NULL,
  last_active_at      BIGINT NOT NULL
);

-- Cursor per (team, user). Allows users who participate in multiple teams
-- to maintain independent cursors. In practice v1 is single-team — but the
-- compound key avoids a schema change later.
CREATE TABLE IF NOT EXISTS sync_cursor (
  team_id                       TEXT NOT NULL,
  user_id                       TEXT NOT NULL,
  -- Highest event timestamp the server has acked. Next batch selects
  --   WHERE timestamp > last_acknowledged_timestamp_ms.
  last_acknowledged_timestamp_ms BIGINT NOT NULL DEFAULT 0,
  -- Wall clock of the most recent successful POST.
  last_synced_at                BIGINT,
  -- Last error string for surfacing in the Settings UI. NULL when healthy.
  last_error                    TEXT,
  PRIMARY KEY (team_id, user_id)
);

-- Append-only audit log of sync events. Captures rejections, payload-hash
-- conflicts (server thinks the event already exists with a different hash),
-- and outright errors. Bounded by retention; the queue trims rows older
-- than 30 days on each tick.
CREATE TABLE IF NOT EXISTS sync_audit (
  id              BIGSERIAL PRIMARY KEY,
  occurred_at     BIGINT NOT NULL,
  kind            TEXT NOT NULL,             -- 'rejected' | 'conflict' | 'error' | 'success'
  team_id         TEXT,
  user_id         TEXT,
  sync_event_id   TEXT,
  detail          TEXT
);
CREATE INDEX IF NOT EXISTS sync_audit_occurred_at_idx ON sync_audit (occurred_at DESC);

INSERT INTO schema_version (version) VALUES (4)
ON CONFLICT (version) DO NOTHING;
