import type { UsageEvent } from '@shared/usage-event'
import type { Pool } from './connect'
import { namedQuery } from './db-utils'

interface EventRow {
  id: string
  provider: string
  provider_raw_tag: string | null
  model: string
  timestamp: bigint
  project: string | null
  project_raw_slug: string | null
  session_id: string | null
  message_id: string | null
  input_tokens: bigint
  output_tokens: bigint
  cache_read_tokens: bigint
  cache_creation_5m_tokens: bigint
  cache_creation_1h_tokens: bigint
  reasoning_tokens: bigint | null
  tool_call_count: bigint | null
  latency_ms: bigint | null
  computed_cost_micro_usd: bigint
  pricing_snapshot_version: string
  source_file: string
  source_line_offset: bigint
}

function rowToEvent(r: EventRow): UsageEvent {
  return {
    id: r.id,
    provider: r.provider,
    providerRawTag: r.provider_raw_tag,
    model: r.model,
    timestamp: Number(r.timestamp),
    project: r.project,
    projectRawSlug: r.project_raw_slug,
    sessionId: r.session_id,
    messageId: r.message_id,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    cacheCreation5mTokens: Number(r.cache_creation_5m_tokens),
    cacheCreation1hTokens: Number(r.cache_creation_1h_tokens),
    reasoningTokens: r.reasoning_tokens === null ? null : Number(r.reasoning_tokens),
    toolCallCount: r.tool_call_count === null ? null : Number(r.tool_call_count),
    latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
    computedCostMicroUsd: r.computed_cost_micro_usd,
    pricingSnapshotVersion: r.pricing_snapshot_version,
    sourceFile: r.source_file,
    sourceLineOffset: Number(r.source_line_offset),
  }
}

const UPSERT_SQL = `
  INSERT INTO events (
    id, provider, provider_raw_tag, model, timestamp,
    project, project_raw_slug, session_id, message_id,
    input_tokens, output_tokens, cache_read_tokens,
    cache_creation_5m_tokens, cache_creation_1h_tokens,
    reasoning_tokens, tool_call_count, latency_ms,
    computed_cost_micro_usd, pricing_snapshot_version,
    source_file, source_line_offset
  ) VALUES (
    @id, @provider, @provider_raw_tag, @model, @timestamp,
    @project, @project_raw_slug, @session_id, @message_id,
    @input_tokens, @output_tokens, @cache_read_tokens,
    @cache_creation_5m_tokens, @cache_creation_1h_tokens,
    @reasoning_tokens, @tool_call_count, @latency_ms,
    @computed_cost_micro_usd, @pricing_snapshot_version,
    @source_file, @source_line_offset
  )
  ON CONFLICT (id) DO UPDATE SET
    provider = EXCLUDED.provider,
    provider_raw_tag = EXCLUDED.provider_raw_tag,
    model = EXCLUDED.model,
    timestamp = EXCLUDED.timestamp,
    project = EXCLUDED.project,
    project_raw_slug = EXCLUDED.project_raw_slug,
    session_id = EXCLUDED.session_id,
    message_id = EXCLUDED.message_id,
    input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cache_read_tokens = EXCLUDED.cache_read_tokens,
    cache_creation_5m_tokens = EXCLUDED.cache_creation_5m_tokens,
    cache_creation_1h_tokens = EXCLUDED.cache_creation_1h_tokens,
    reasoning_tokens = EXCLUDED.reasoning_tokens,
    tool_call_count = EXCLUDED.tool_call_count,
    latency_ms = EXCLUDED.latency_ms,
    computed_cost_micro_usd = EXCLUDED.computed_cost_micro_usd,
    pricing_snapshot_version = EXCLUDED.pricing_snapshot_version,
    source_file = EXCLUDED.source_file,
    source_line_offset = EXCLUDED.source_line_offset
`

function eventToParams(e: UsageEvent): Record<string, unknown> {
  return {
    id: e.id,
    provider: e.provider,
    provider_raw_tag: e.providerRawTag,
    model: e.model,
    // Postgres BIGINT columns accept JS number up to 2^53; pg will throw
    // for larger. Our timestamps fit; explicit BigInt for safety.
    timestamp: BigInt(e.timestamp),
    project: e.project,
    project_raw_slug: e.projectRawSlug,
    session_id: e.sessionId,
    message_id: e.messageId,
    input_tokens: BigInt(e.inputTokens),
    output_tokens: BigInt(e.outputTokens),
    cache_read_tokens: BigInt(e.cacheReadTokens),
    cache_creation_5m_tokens: BigInt(e.cacheCreation5mTokens),
    cache_creation_1h_tokens: BigInt(e.cacheCreation1hTokens),
    reasoning_tokens: e.reasoningTokens === null ? null : BigInt(e.reasoningTokens),
    tool_call_count: e.toolCallCount === null ? null : BigInt(e.toolCallCount),
    latency_ms: e.latencyMs === null ? null : BigInt(e.latencyMs),
    computed_cost_micro_usd: e.computedCostMicroUsd,
    pricing_snapshot_version: e.pricingSnapshotVersion,
    source_file: e.sourceFile,
    source_line_offset: BigInt(e.sourceLineOffset),
  }
}

export class EventRepository {
  constructor(private readonly pool: Pool) {}

  async upsert(event: UsageEvent): Promise<void> {
    const q = namedQuery(UPSERT_SQL, eventToParams(event))
    await this.pool.query(q.text, q.values)
  }

  async upsertMany(events: readonly UsageEvent[]): Promise<void> {
    if (events.length === 0) return
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const e of events) {
        const q = namedQuery(UPSERT_SQL, eventToParams(e))
        await client.query(q.text, q.values)
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async findById(id: string): Promise<UsageEvent | null> {
    const q = namedQuery('SELECT * FROM events WHERE id = @id', { id })
    const r = await this.pool.query<EventRow>(q.text, q.values)
    const row = r.rows[0]
    return row === undefined ? null : rowToEvent(row)
  }

  async between(startMs: number, endMs: number): Promise<UsageEvent[]> {
    const q = namedQuery(
      'SELECT * FROM events WHERE timestamp >= @start AND timestamp < @end ORDER BY timestamp ASC',
      { start: BigInt(startMs), end: BigInt(endMs) },
    )
    const r = await this.pool.query<EventRow>(q.text, q.values)
    return r.rows.map(rowToEvent)
  }

  async costMicroUsdBetween(startMs: number, endMs: number): Promise<bigint> {
    const q = namedQuery(
      `SELECT COALESCE(SUM(computed_cost_micro_usd), 0)::bigint AS total
       FROM events WHERE timestamp >= @start AND timestamp < @end`,
      { start: BigInt(startMs), end: BigInt(endMs) },
    )
    const r = await this.pool.query<{ total: bigint | null }>(q.text, q.values)
    return r.rows[0]?.total ?? 0n
  }

  async count(): Promise<number> {
    const r = await this.pool.query<{ n: bigint }>(
      'SELECT COUNT(*)::bigint AS n FROM events',
    )
    return Number(r.rows[0]?.n ?? 0n)
  }
}
