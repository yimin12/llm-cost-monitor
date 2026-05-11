-- 0002_perf_indexes.sql
-- Indexes required by docs/multi-node-usage-merge-design.md §"Required Tables"
-- and §"Efficiency Guarantees". The 0001 init covers (team_id, timestamp) and
-- (team_id, user_id); add the three multi-column patterns the dashboard,
-- node drilldown, and provider/model rollup queries actually hit.

-- One user's merged view across nodes (and the audit drilldown's hot path).
CREATE INDEX IF NOT EXISTS usage_events_team_user_time_idx
  ON usage_events (team_id, user_id, timestamp DESC);

-- Per-(provider, model) totals scoped to a user — feeds the dashboard's
-- per-model card without a full team-id scan.
CREATE INDEX IF NOT EXISTS usage_events_team_user_provider_model_idx
  ON usage_events (team_id, user_id, provider, model);

-- Node drilldown: same user, multiple machines, time-ordered.
CREATE INDEX IF NOT EXISTS usage_events_team_user_node_time_idx
  ON usage_events (team_id, user_id, node_id, timestamp DESC);

-- Daily rollup read path: pull a user's recent days without scanning the
-- whole team's aggregate table.
CREATE INDEX IF NOT EXISTS daily_aggregates_team_user_date_idx
  ON daily_aggregates (team_id, user_id, date DESC);

INSERT INTO schema_version (version) VALUES (2);
