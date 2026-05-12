-- 0003_event_daily_rollup.sql
-- Daily rollup of event-level usage_events. Maintained in the same
-- transaction as event inserts (TeamService.batchUpsert writes both the
-- raw row and an accumulating UPSERT here for the (team,user,node,date,
-- provider,model,project_hash) group). Per
-- docs/multi-node-usage-merge-design.md §"Rollup Path" — dashboard reads
-- must not GROUP BY raw event rows on every request.
--
-- Shape mirrors daily_aggregates so getOverview can `UNION ALL` across
-- both sources, with one extra dimension: `project_hash`. The two
-- tables differ in *write semantics*: daily_aggregates is overwrite-
-- per-bucket (privacy=aggregateOnly clients send the full current
-- bucket), event_daily_rollup is accumulate-per-row (server adds the
-- delta of every newly-inserted event in the same transaction).

CREATE TABLE IF NOT EXISTS event_daily_rollup (
  team_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  date         TEXT NOT NULL,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  -- Empty string when the event had no project_hash (rare). Using ''
  -- instead of NULL keeps the composite PK definite without an extra
  -- COALESCE on every read; matches usage_events.project_hash being
  -- TEXT (nullable there because some old rows predate the column).
  project_hash TEXT NOT NULL DEFAULT '',

  event_count               BIGINT NOT NULL DEFAULT 0,
  input_tokens              BIGINT NOT NULL DEFAULT 0,
  output_tokens             BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens         BIGINT NOT NULL DEFAULT 0,
  cache_creation_5m_tokens  BIGINT NOT NULL DEFAULT 0,
  cache_creation_1h_tokens  BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens          BIGINT NOT NULL DEFAULT 0,
  cost_micro_usd            BIGINT NOT NULL DEFAULT 0,

  -- Most-recent pricing snapshot wins on conflict — only relevant for
  -- audit; rollup math itself uses the persisted integer cost.
  pricing_snapshot_version  TEXT NOT NULL,

  -- Last write into this bucket. Useful for the "active in last 24h"
  -- card without scanning raw events.
  uploaded_at  BIGINT NOT NULL,

  PRIMARY KEY (team_id, user_id, node_id, date, provider, model, project_hash)
);

-- Same supporting indexes as daily_aggregates.
CREATE INDEX IF NOT EXISTS event_daily_rollup_team_date_idx
  ON event_daily_rollup (team_id, date DESC);
CREATE INDEX IF NOT EXISTS event_daily_rollup_team_user_date_idx
  ON event_daily_rollup (team_id, user_id, date DESC);

-- Backfill from existing usage_events. One INSERT … SELECT … GROUP BY
-- runs in this migration's transaction; subsequent event_daily_rollup
-- writes are maintained by the app on every accepted INSERT.
INSERT INTO event_daily_rollup (
  team_id, user_id, node_id, date, provider, model, project_hash,
  event_count, input_tokens, output_tokens,
  cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens,
  reasoning_tokens, cost_micro_usd, pricing_snapshot_version, uploaded_at
)
SELECT
  team_id, user_id, node_id,
  TO_CHAR(TO_TIMESTAMP(timestamp / 1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
  provider, model,
  COALESCE(project_hash, '') AS project_hash,
  COUNT(*)::bigint,
  SUM(input_tokens),
  SUM(output_tokens),
  SUM(cache_read_tokens),
  SUM(cache_creation_5m_tokens),
  SUM(cache_creation_1h_tokens),
  COALESCE(SUM(reasoning_tokens), 0),
  SUM(cost_micro_usd),
  MAX(pricing_snapshot_version),
  MAX(uploaded_at)
FROM usage_events
GROUP BY team_id, user_id, node_id, date, provider, model, project_hash
ON CONFLICT (team_id, user_id, node_id, date, provider, model, project_hash) DO NOTHING;

-- Merged read view. dashboard reads target this; daily_aggregates rows
-- (privacy=aggregateOnly clients) join in with project_hash=NULL since
-- they didn't ship a project dimension. The v_ prefix marks read-side
-- artifacts so engineers don't accidentally INSERT into a view.
CREATE OR REPLACE VIEW v_merged_daily AS
  SELECT team_id, user_id, node_id, date, provider, model,
         NULL::text AS project_hash,
         event_count, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens,
         reasoning_tokens, cost_micro_usd, uploaded_at
  FROM daily_aggregates
  UNION ALL
  SELECT team_id, user_id, node_id, date, provider, model,
         NULLIF(project_hash, '') AS project_hash,
         event_count, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens,
         reasoning_tokens, cost_micro_usd, uploaded_at
  FROM event_daily_rollup;

INSERT INTO schema_version (version) VALUES (3);
