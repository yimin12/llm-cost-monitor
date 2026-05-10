-- Server schema for the team-sync backend.
-- Sized for v1: one Postgres database, all teams co-located, row-level
-- scoping by team_id. Authoritative store for synced events; clients
-- never read from it directly — they only POST events and GET aggregates.

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  -- 'redacted' is the safe default; team admins can lift to 'full' or
  -- pin to 'aggregateOnly' for sensitive environments.
  privacy_floor TEXT NOT NULL DEFAULT 'redacted',
  created_at  BIGINT NOT NULL,
  removed_at  BIGINT
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  -- 'admin' grants membership + privacy-floor management.
  role        TEXT NOT NULL DEFAULT 'member',
  -- 'active' allows uploads; 'revoked' rejects new uploads but historical
  -- rows persist according to retention policy.
  status      TEXT NOT NULL DEFAULT 'active',
  display_name TEXT,
  joined_at   BIGINT NOT NULL,
  removed_at  BIGINT,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  team_id     TEXT NOT NULL,
  display_name TEXT,
  platform    TEXT,
  app_version TEXT,
  enrolled_at BIGINT NOT NULL,
  last_seen_at BIGINT
);
CREATE INDEX IF NOT EXISTS nodes_team_idx ON nodes (team_id);

-- Append-only event log. sync_event_id is deterministic (sha256 of
-- team|user|node|local), so retries are idempotent and dedup is free.
-- payload_hash detects content drift (parser upgrades that change token
-- bucketing) — same sync_event_id with different hash writes an audit row.
CREATE TABLE IF NOT EXISTS usage_events (
  sync_event_id  TEXT PRIMARY KEY,
  team_id        TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  node_id        TEXT NOT NULL,
  local_event_id TEXT NOT NULL,
  payload_hash   TEXT NOT NULL,
  privacy_level  TEXT NOT NULL,

  provider             TEXT NOT NULL,
  provider_raw_tag     TEXT,
  model                TEXT NOT NULL,
  timestamp            BIGINT NOT NULL,

  project              TEXT,
  project_hash         TEXT,
  session_id           TEXT,
  message_id           TEXT,

  input_tokens               BIGINT NOT NULL DEFAULT 0,
  output_tokens              BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens          BIGINT NOT NULL DEFAULT 0,
  cache_creation_5m_tokens   BIGINT NOT NULL DEFAULT 0,
  cache_creation_1h_tokens   BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens           BIGINT,
  tool_call_count            BIGINT,
  latency_ms                 BIGINT,

  cost_micro_usd            BIGINT NOT NULL,
  pricing_snapshot_version  TEXT NOT NULL,

  uploaded_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_events_team_ts_idx ON usage_events (team_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS usage_events_team_user_idx ON usage_events (team_id, user_id);
CREATE INDEX IF NOT EXISTS usage_events_team_project_idx ON usage_events (team_id, project_hash);

-- Daily aggregate path (privacy = aggregateOnly). One row per
-- (team, user, node, date, provider, model). Latest upload wins.
CREATE TABLE IF NOT EXISTS daily_aggregates (
  team_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  date         TEXT NOT NULL,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  event_count               BIGINT NOT NULL DEFAULT 0,
  input_tokens              BIGINT NOT NULL DEFAULT 0,
  output_tokens             BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens         BIGINT NOT NULL DEFAULT 0,
  cache_creation_5m_tokens  BIGINT NOT NULL DEFAULT 0,
  cache_creation_1h_tokens  BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens          BIGINT NOT NULL DEFAULT 0,
  cost_micro_usd            BIGINT NOT NULL DEFAULT 0,
  pricing_snapshot_version  TEXT NOT NULL,
  uploaded_at               BIGINT NOT NULL,
  PRIMARY KEY (team_id, user_id, node_id, date, provider, model)
);
CREATE INDEX IF NOT EXISTS daily_aggregates_team_date_idx ON daily_aggregates (team_id, date DESC);

-- Conflict log. Written when payload_hash differs across uploads for the
-- same sync_event_id. Used by audit dashboards.
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id              BIGSERIAL PRIMARY KEY,
  occurred_at     BIGINT NOT NULL,
  sync_event_id   TEXT NOT NULL,
  prior_hash      TEXT NOT NULL,
  new_hash        TEXT NOT NULL,
  detail          TEXT
);

INSERT INTO schema_version (version) VALUES (1)
ON CONFLICT (version) DO NOTHING;
