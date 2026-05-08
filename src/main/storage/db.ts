import Database from 'better-sqlite3'

export type DatabaseHandle = Database.Database

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_raw_tag TEXT,
  model TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  project TEXT,
  project_raw_slug TEXT,
  session_id TEXT,
  message_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER,
  tool_call_count INTEGER,
  latency_ms INTEGER,
  computed_cost_micro_usd INTEGER NOT NULL,
  pricing_snapshot_version TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_line_offset INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp DESC);
CREATE INDEX IF NOT EXISTS events_provider_model_idx ON events(provider, model);
CREATE INDEX IF NOT EXISTS events_project_idx ON events(project);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  last_parsed_at INTEGER NOT NULL,
  last_offset INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pricing_overrides (
  model TEXT PRIMARY KEY,
  input_per_m INTEGER NOT NULL,
  output_per_m INTEGER NOT NULL,
  cache_write_per_m INTEGER,
  cache_read_per_m INTEGER,
  source TEXT NOT NULL
);
`

function currentSchemaVersion(db: DatabaseHandle): number {
  const row = db.prepare<[], { version: number }>('SELECT version FROM schema_version').get()
  return row?.version ?? 0
}

function applyMigrations(db: DatabaseHandle): void {
  // Idempotent: each migration runs only once. New migrations land here as additional blocks.
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);')
  const v = currentSchemaVersion(db)
  if (v >= 1) return
  db.exec('BEGIN')
  try {
    db.exec(SCHEMA_V1)
    db.prepare('INSERT INTO schema_version(version) VALUES (1)').run()
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function openDatabase(path: string): DatabaseHandle {
  const db = new Database(path)
  // BigInt round-trip — `computed_cost_micro_usd` exceeds 2^53 in degenerate edge
  // cases and we do all aggregation in micro-USD anyway.
  db.defaultSafeIntegers(true)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  return db
}
