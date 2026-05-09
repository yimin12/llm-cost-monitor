-- Schema v3 — alerts table.
--
-- Lifecycle: open → (acked | snoozed | resolved). Snoozed auto-returns to
-- open when snoozed_until passes (sampler checks on every tick).
--
-- Dedup: a partial unique index on `signature` (only WHERE status IN
-- ('open','snoozed','acked')) prevents the sampler from spamming duplicate
-- rows for the same condition while one is still active. Once resolved, the
-- same signature can fire again — that's the desired behavior (the issue
-- recurred and the user wants to know).

CREATE TABLE IF NOT EXISTS alerts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL,                 -- 'system.cpu' | 'system.memory' | 'cost.daily' | 'cost.forecast'
  severity        TEXT NOT NULL,                 -- 'info' | 'warning' | 'critical'
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  raised_at       BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'acked' | 'resolved' | 'snoozed'
  acked_at        BIGINT,
  resolved_at     BIGINT,
  snoozed_until   BIGINT,
  signature       TEXT NOT NULL,
  metadata        JSONB
);

-- gen_random_uuid() needs pgcrypto on older Postgres; on 17 it's built-in,
-- but we extend defensively in case the dev container is mis-versioned.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE INDEX IF NOT EXISTS alerts_status_raised_idx
  ON alerts (status, raised_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_signature_idx
  ON alerts (signature)
  WHERE status IN ('open', 'snoozed', 'acked');

INSERT INTO schema_version (version) VALUES (3)
ON CONFLICT (version) DO NOTHING;
