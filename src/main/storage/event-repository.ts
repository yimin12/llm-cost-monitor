import type { UsageEvent } from '@shared/usage-event'
import type { DatabaseHandle } from './db'

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

export class EventRepository {
  private readonly upsertStmt
  private readonly selectByIdStmt
  private readonly selectBetweenStmt
  private readonly costSumBetweenStmt
  private readonly countStmt

  constructor(private readonly db: DatabaseHandle) {
    this.upsertStmt = db.prepare(`
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
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        provider_raw_tag = excluded.provider_raw_tag,
        model = excluded.model,
        timestamp = excluded.timestamp,
        project = excluded.project,
        project_raw_slug = excluded.project_raw_slug,
        session_id = excluded.session_id,
        message_id = excluded.message_id,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_creation_5m_tokens = excluded.cache_creation_5m_tokens,
        cache_creation_1h_tokens = excluded.cache_creation_1h_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        tool_call_count = excluded.tool_call_count,
        latency_ms = excluded.latency_ms,
        computed_cost_micro_usd = excluded.computed_cost_micro_usd,
        pricing_snapshot_version = excluded.pricing_snapshot_version,
        source_file = excluded.source_file,
        source_line_offset = excluded.source_line_offset
    `)
    this.selectByIdStmt = db.prepare<{ id: string }, EventRow>(
      'SELECT * FROM events WHERE id = @id',
    )
    this.selectBetweenStmt = db.prepare<{ start: number; end: number }, EventRow>(
      'SELECT * FROM events WHERE timestamp >= @start AND timestamp < @end ORDER BY timestamp ASC',
    )
    this.costSumBetweenStmt = db.prepare<
      { start: number; end: number },
      { total: bigint | null }
    >(
      'SELECT COALESCE(SUM(computed_cost_micro_usd), 0) AS total FROM events WHERE timestamp >= @start AND timestamp < @end',
    )
    this.countStmt = db.prepare<[], { n: bigint }>('SELECT COUNT(*) AS n FROM events')
  }

  upsert(event: UsageEvent): void {
    this.upsertStmt.run({
      id: event.id,
      provider: event.provider,
      provider_raw_tag: event.providerRawTag,
      model: event.model,
      timestamp: event.timestamp,
      project: event.project,
      project_raw_slug: event.projectRawSlug,
      session_id: event.sessionId,
      message_id: event.messageId,
      input_tokens: event.inputTokens,
      output_tokens: event.outputTokens,
      cache_read_tokens: event.cacheReadTokens,
      cache_creation_5m_tokens: event.cacheCreation5mTokens,
      cache_creation_1h_tokens: event.cacheCreation1hTokens,
      reasoning_tokens: event.reasoningTokens,
      tool_call_count: event.toolCallCount,
      latency_ms: event.latencyMs,
      computed_cost_micro_usd: event.computedCostMicroUsd,
      pricing_snapshot_version: event.pricingSnapshotVersion,
      source_file: event.sourceFile,
      source_line_offset: event.sourceLineOffset,
    })
  }

  upsertMany(events: readonly UsageEvent[]): void {
    const tx = this.db.transaction((batch: readonly UsageEvent[]) => {
      for (const e of batch) this.upsert(e)
    })
    tx(events)
  }

  findById(id: string): UsageEvent | null {
    const row = this.selectByIdStmt.get({ id })
    return row === undefined ? null : rowToEvent(row)
  }

  between(startMs: number, endMs: number): UsageEvent[] {
    return this.selectBetweenStmt.all({ start: startMs, end: endMs }).map(rowToEvent)
  }

  costMicroUsdBetween(startMs: number, endMs: number): bigint {
    const row = this.costSumBetweenStmt.get({ start: startMs, end: endMs })
    return row?.total ?? 0n
  }

  count(): number {
    return Number(this.countStmt.get()?.n ?? 0n)
  }
}
