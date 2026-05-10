-- Memory pressure is no longer treated as critical (modern OSes routinely
-- run >95% memory used due to file-cache reuse). Downgrade any existing
-- open/acked critical memory alerts so the tray icon reflects the new
-- severity model — see docs/alerts.md and src/main/alerts/sampler.ts.

UPDATE alerts
SET severity = 'warning'
WHERE type = 'system.memory'
  AND severity = 'critical'
  AND status IN ('open', 'acked');

INSERT INTO schema_version (version) VALUES (5)
ON CONFLICT (version) DO NOTHING;
