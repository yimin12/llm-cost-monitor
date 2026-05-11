# Multi-node Usage Merge Design

## Goal

Support one person running several nodes at the same time, especially
several machines using Claude Code. The system must merge usage, cost,
and the supporting dimensions behind that cost into one coherent view.

The merge target is not just:

```text
total_cost = node_a_cost + node_b_cost
```

The merge target is the full usage fact set:

- user, team, node
- provider, model, provider raw tag
- project and redacted project hash
- session and message identity when privacy allows it
- input, output, cache read, cache creation, reasoning tokens
- tool calls and latency when privacy allows it
- computed cost in integer micro-USD
- pricing snapshot version
- local source metadata for auditability
- node last-seen and upload health

## Identity Model

Every row must carry three separate identities.

```text
teamId:  workspace boundary
userId:  same human/login across machines
nodeId:  one desktop install or one collector process
```

Example:

```text
teamId = team_acme
userId = user_alice
nodeId = alice_macbook
nodeId = alice_linux_box
nodeId = alice_home_imac
```

All three nodes can upload Claude usage. The server groups by `userId`
for Alice's total usage, but keeps `nodeId` so we can debug stale nodes,
duplicates, and machine-specific behavior.

## Event Key

Local parsers already produce a `UsageEvent.id`. That id is only unique
inside one local database. It must not be used directly as the server
primary key.

The server event id is:

```text
syncEventId = sha256(teamId | userId | nodeId | localEventId)
```

This gives the needed behavior:

- Same node retrying the same Claude event maps to the same id.
- Two nodes with different Claude events both survive and are summed.
- Two nodes that accidentally produce the same local id do not collide.
- Moving a node to a different team creates a different server namespace.

Server-side code must recompute this id and reject a payload when the
submitted `sync_event_id` does not match.

## Merge Semantics

### Event-level Mode

For `full` and `redacted` privacy, the server stores one row per local
usage event in `usage_events`.

Primary key:

```sql
sync_event_id TEXT PRIMARY KEY
```

Merge rule:

```sql
INSERT usage_events (...)
ON CONFLICT (sync_event_id) DO NOTHING
```

If the same `sync_event_id` arrives with a different `payload_hash`, the
server must keep the original event and write a `sync_conflicts` row. The
server should not mutate historical cost or token data silently.

### Aggregate-only Mode

For `aggregateOnly`, the node sends daily buckets instead of event rows.

Bucket key:

```text
teamId | userId | nodeId | date | provider | model
```

Merge rule:

```sql
INSERT daily_aggregates (...)
ON CONFLICT (team_id, user_id, node_id, date, provider, model)
DO UPDATE SET latest_bucket_values
```

This is an overwrite, not an increment. The node sends the complete
current bucket for that day, so retries cannot double count.

## Claude Multi-node Example

Node A observes:

```text
userId=user_alice
nodeId=macbook
provider=anthropic
model=claude-3-5-sonnet
project=llm-cost-monitor
input=12000
output=900
cache_read=8000
cost=$0.18
```

Node B observes:

```text
userId=user_alice
nodeId=linux_box
provider=anthropic
model=claude-3-5-sonnet
project=llm-cost-monitor
input=30000
output=2100
cache_read=16000
cost=$0.47
```

Team/user rollup becomes:

```text
user_alice / anthropic / claude-3-5-sonnet / llm-cost-monitor
input=42000
output=3000
cache_read=24000
cost=$0.65
nodes=2
events=2
```

Node-level drilldown still shows:

```text
macbook   $0.18  last_seen=...
linux_box $0.47  last_seen=...
```

## Required Tables

The current server tables are the right base:

- `team_members`
- `nodes`
- `usage_events`
- `daily_aggregates`
- `sync_conflicts`

Add or confirm these indexes:

```sql
CREATE INDEX usage_events_team_user_time_idx
  ON usage_events (team_id, user_id, timestamp DESC);

CREATE INDEX usage_events_team_user_provider_model_idx
  ON usage_events (team_id, user_id, provider, model);

CREATE INDEX usage_events_team_user_node_time_idx
  ON usage_events (team_id, user_id, node_id, timestamp DESC);

CREATE INDEX daily_aggregates_team_user_date_idx
  ON daily_aggregates (team_id, user_id, date DESC);
```

For larger teams, add a materialized rollup table:

```sql
CREATE TABLE team_usage_rollups (
  team_id TEXT NOT NULL,
  day DATE NOT NULL,
  user_id TEXT NOT NULL,
  node_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  project_hash TEXT,

  event_count BIGINT NOT NULL,
  input_tokens BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  cache_read_tokens BIGINT NOT NULL,
  cache_creation_5m_tokens BIGINT NOT NULL,
  cache_creation_1h_tokens BIGINT NOT NULL,
  reasoning_tokens BIGINT NOT NULL,
  cost_micro_usd BIGINT NOT NULL,

  PRIMARY KEY (
    team_id,
    day,
    user_id,
    node_id,
    provider,
    model,
    project_hash
  )
);
```

Use `node_id = NULL` only for precomputed all-node rollups. Raw events
must always keep the original node id.

## Efficiency Guarantees

The merge path must stay efficient under three common loads:

- one heavy user with several Claude nodes
- one team with many medium-usage members
- repeated retries after offline periods

The system should guarantee these properties:

```text
local parse:       O(changed log lines)
outbox build:      O(new or changed local events)
upload write:      O(batch size)
dedup:             O(1) by sync_event_id primary key
member dashboard:  O(days * rollup dimensions), not O(raw events)
node drilldown:    index-bounded by team_id + user_id + node_id + time
```

### Local Hot Path

The desktop app must never rescan all Claude history on every refresh.
It should continue using file metadata and line offsets to scan only
changed log segments, then upsert normalized `UsageEvent` rows locally.

Local writes should be batched:

```text
BEGIN
  upsert event 1
  upsert event 2
  ...
COMMIT
```

The parser should compute cost once per event using the local pricing
snapshot and persist `computed_cost_micro_usd`. Dashboard queries should
sum persisted integer values, not recalculate cost during reads.

### Upload Path

Upload work must be driven by `sync_outbox`, not by scanning the whole
local `events` table.

Efficient upload loop:

```sql
SELECT *
FROM sync_outbox
WHERE status = 'pending'
  AND next_attempt_at <= $now
ORDER BY created_at ASC
LIMIT $batch_size;
```

Required index:

```sql
CREATE INDEX sync_outbox_pending_idx
  ON sync_outbox (status, next_attempt_at, created_at);
```

Batch size should default to 500 and be configurable up to 2000. The
worker must run one in-flight upload per node, so a slow server cannot
create parallel duplicate writes from the same local queue.

### Server Write Path

The server write path must be one transaction per batch. It should cache
membership and node authorization decisions per batch, so 500 payloads
from the same user do not produce 500 membership queries.

Write rules:

- Validate `team_id` against the URL before any insert.
- Validate active membership once per `(team_id, user_id)`.
- Validate enrolled node once per `(team_id, user_id, node_id)`.
- Recompute `sync_event_id` in memory for event-level rows.
- Insert with the primary key on `sync_event_id`.
- For exact duplicates, return duplicate without changing the row.
- For hash conflicts, write only to `sync_conflicts`.

This keeps retry storms cheap: repeated rows become primary-key lookups,
not extra aggregate work or duplicate cost.

### Rollup Path

Dashboard reads should not group millions of raw event rows on every
request. Raw `usage_events` are the audit log. Rollups are the read path.

For small teams, a bounded raw query is acceptable only when all of these
are true:

- The time window is short.
- The query filters by `team_id`.
- The query uses a supporting time index.
- The result is capped.

For normal dashboard cards, use daily rollups:

```text
team_id | day | user_id | node_id | provider | model | project_hash
```

Rollup update strategy:

- On event insert, enqueue affected `(team_id, day)` keys.
- A worker recomputes only dirty days.
- Recompute is idempotent: delete that day's rollup rows and rebuild from
  source rows inside one transaction, or upsert deterministic groups.
- Recent days can refresh every few seconds; older days can refresh less
  often because historical events rarely change.

### Read API Boundaries

Expose separate query paths so each view has predictable cost:

- Summary: reads daily rollup by `team_id + date range`.
- By user: groups rollup by `user_id`.
- By node: groups rollup by `user_id + node_id`.
- By provider/model: groups rollup by `provider + model`.
- Audit drilldown: reads raw events with explicit `limit` and cursor.

Every list endpoint must take a date range and either a limit or a fixed
top-N. Open-ended raw event reads are not allowed in dashboard APIs.

### Database Scaling

Start with Postgres. Do not introduce ClickHouse until Postgres rollups
become the measured bottleneck.

Postgres scaling steps:

1. Add the indexes listed in this design.
2. Use daily rollups for dashboard reads.
3. Partition `usage_events` by month when raw event volume grows.
4. Archive old raw events after retention while keeping rollups.
5. Move analytical history to ClickHouse only when product queries need
   long-range raw event scans.

### Performance Acceptance Targets

Use these targets for implementation tests and manual profiling:

- Syncing 10,000 offline Claude events should complete through batches
  without duplicate cost after retries.
- A 500-row upload batch should write in one transaction and avoid per-row
  membership lookups.
- A 30-day team dashboard should not scan raw events once rollups exist.
- One user's multi-node Claude summary should use an index or rollup and
  return without full-table scan.
- Replaying the same 500-row batch should be cheap and should only report
  duplicates.

## Sync Reliability

The current timestamp cursor is not strong enough as the only sync state.
If a node has many events with the same timestamp and the batch is capped,
advancing only by timestamp can skip events.

Use a local outbox:

```sql
CREATE TABLE sync_outbox (
  sync_event_id TEXT PRIMARY KEY,
  local_event_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
```

Flow:

1. Parser writes local `events`.
2. Sync builder creates deterministic outbox rows.
3. Upload worker sends pending outbox rows in batches.
4. Server accepts, duplicates, rejects, or reports conflicts.
5. Client marks accepted and duplicate rows as done.
6. Rejected/conflict rows stay auditable and visible in settings.

This guarantees retries do not double count and batch limits do not skip
same-timestamp events.

## Query Shapes

One user's merged Claude usage across all nodes:

```sql
SELECT
  user_id,
  provider,
  model,
  COALESCE(project, project_hash, '(unknown)') AS project_key,
  COUNT(*) AS event_count,
  COUNT(DISTINCT node_id) AS node_count,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_creation_5m_tokens) AS cache_creation_5m_tokens,
  SUM(cache_creation_1h_tokens) AS cache_creation_1h_tokens,
  SUM(COALESCE(reasoning_tokens, 0)) AS reasoning_tokens,
  SUM(cost_micro_usd) AS cost_micro_usd
FROM usage_events
WHERE team_id = $1
  AND user_id = $2
  AND provider = 'anthropic'
  AND timestamp >= $3
GROUP BY user_id, provider, model, project_key;
```

Node drilldown for the same user:

```sql
SELECT
  node_id,
  provider,
  model,
  COUNT(*) AS event_count,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cost_micro_usd) AS cost_micro_usd,
  MAX(uploaded_at) AS last_upload_at
FROM usage_events
WHERE team_id = $1
  AND user_id = $2
  AND timestamp >= $3
GROUP BY node_id, provider, model;
```

Dashboard reads should eventually union event-level and aggregate-only
sources:

```text
merged_usage = rollup(usage_events) UNION ALL daily_aggregates
```

The API should return one common shape so the UI does not care which
privacy mode produced the data.

## Invariants

These must be tested:

- One node retrying the same event does not increase cost.
- Two nodes for the same user using Claude both contribute to the same
  user total.
- Two different users on the same team remain separate in member views.
- Team total equals the sum of all active and historical member rows in
  the selected time window.
- Redacted project hashes merge across nodes in the same team.
- Redacted project hashes do not match across different teams.
- `pricing_snapshot_version` is preserved per event.
- Local provider events merge token counts but carry `cost_micro_usd = 0`.
- Revoked users and revoked nodes cannot upload new rows.
- Aggregate-only uploads do not create event-level rows and do not double
  count on retry.

## Implementation Delta

The current codebase already has most of the database shape. To make this
design production-grade:

1. Add a real `sync_outbox` table and move upload progress from timestamp
   cursor to outbox row status.
2. Recompute `sync_event_id` on the server and reject mismatches.
3. Add node authorization, not only user membership authorization.
4. Make team overview queries include `daily_aggregates`.
5. Add rollup indexes and, when needed, `team_usage_rollups`.
6. Move dashboard reads to rollups for default views; keep raw events for
   audit drilldown only.
7. Add acceptance tests for three Claude nodes under one user and for one
   Claude node plus one local LLM node where local cost remains zero.
8. Add performance tests for offline sync replay, duplicate batch replay,
   and 30-day dashboard reads.
