-- Bootstraps the `lcm_team_sync` database alongside the default
-- `llm_cost_monitor` one. Postgres only runs the contents of
-- /docker-entrypoint-initdb.d on a fresh data volume — for established
-- volumes, run this manually with:
--   docker exec llm-cost-monitor-postgres psql -U lcm -d postgres -c "CREATE DATABASE lcm_team_sync;"
SELECT 'CREATE DATABASE lcm_team_sync'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'lcm_team_sync')\gexec
