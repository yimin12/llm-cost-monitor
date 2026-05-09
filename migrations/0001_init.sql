-- Schema v1 (Postgres). Mirrors the original SQLite schema from
-- docs/architecture.md D9; differences flagged in docs/auth-plan.md §3.4.
-- Idempotent on re-runs via IF NOT EXISTS + ON CONFLICT.

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS events (
  id                          TEXT PRIMARY KEY,
  provider                    TEXT NOT NULL,
  provider_raw_tag            TEXT,
  model                       TEXT NOT NULL,
  timestamp                   BIGINT NOT NULL,
  project                     TEXT,
  project_raw_slug            TEXT,
  session_id                  TEXT,
  message_id                  TEXT,
  input_tokens                BIGINT NOT NULL DEFAULT 0,
  output_tokens               BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens           BIGINT NOT NULL DEFAULT 0,
  cache_creation_5m_tokens    BIGINT NOT NULL DEFAULT 0,
  cache_creation_1h_tokens    BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens            BIGINT,
  tool_call_count             BIGINT,
  latency_ms                  BIGINT,
  computed_cost_micro_usd     BIGINT NOT NULL,
  pricing_snapshot_version    TEXT NOT NULL,
  source_file                 TEXT NOT NULL,
  source_line_offset          BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_timestamp_idx        ON events (timestamp DESC);
CREATE INDEX IF NOT EXISTS events_provider_model_idx   ON events (provider, model);
CREATE INDEX IF NOT EXISTS events_project_idx          ON events (project);

CREATE TABLE IF NOT EXISTS files (
  path           TEXT PRIMARY KEY,
  mtime          BIGINT NOT NULL,
  last_parsed_at BIGINT NOT NULL,
  last_offset    BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pricing_overrides (
  model              TEXT PRIMARY KEY,
  input_per_m        BIGINT NOT NULL,
  output_per_m       BIGINT NOT NULL,
  cache_write_per_m  BIGINT,
  cache_read_per_m   BIGINT,
  source             TEXT NOT NULL
);

INSERT INTO schema_version (version) VALUES (1)
ON CONFLICT (version) DO NOTHING;
