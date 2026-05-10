-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "schema_version" (
    "version" INTEGER NOT NULL,

    CONSTRAINT "schema_version_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "privacy_floor" TEXT NOT NULL DEFAULT 'redacted',
    "created_at" BIGINT NOT NULL,
    "removed_at" BIGINT,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'active',
    "display_name" TEXT,
    "joined_at" BIGINT NOT NULL,
    "removed_at" BIGINT,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id","user_id")
);

-- CreateTable
CREATE TABLE "nodes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "display_name" TEXT,
    "platform" TEXT,
    "app_version" TEXT,
    "enrolled_at" BIGINT NOT NULL,
    "last_seen_at" BIGINT,

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "sync_event_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "local_event_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "privacy_level" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_raw_tag" TEXT,
    "model" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "project" TEXT,
    "project_hash" TEXT,
    "session_id" TEXT,
    "message_id" TEXT,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_creation_5m_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_creation_1h_tokens" BIGINT NOT NULL DEFAULT 0,
    "reasoning_tokens" BIGINT,
    "tool_call_count" BIGINT,
    "latency_ms" BIGINT,
    "cost_micro_usd" BIGINT NOT NULL,
    "pricing_snapshot_version" TEXT NOT NULL,
    "uploaded_at" BIGINT NOT NULL,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("sync_event_id")
);

-- CreateTable
CREATE TABLE "daily_aggregates" (
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "event_count" BIGINT NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_creation_5m_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_creation_1h_tokens" BIGINT NOT NULL DEFAULT 0,
    "reasoning_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_micro_usd" BIGINT NOT NULL DEFAULT 0,
    "pricing_snapshot_version" TEXT NOT NULL,
    "uploaded_at" BIGINT NOT NULL,

    CONSTRAINT "daily_aggregates_pkey" PRIMARY KEY ("team_id","user_id","node_id","date","provider","model")
);

-- CreateTable
CREATE TABLE "sync_conflicts" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" BIGINT NOT NULL,
    "sync_event_id" TEXT NOT NULL,
    "prior_hash" TEXT NOT NULL,
    "new_hash" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "sync_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "nodes_team_idx" ON "nodes"("team_id");

-- CreateIndex
CREATE INDEX "usage_events_team_ts_idx" ON "usage_events"("team_id", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "usage_events_team_user_idx" ON "usage_events"("team_id", "user_id");

-- CreateIndex
CREATE INDEX "usage_events_team_project_idx" ON "usage_events"("team_id", "project_hash");

-- CreateIndex
CREATE INDEX "daily_aggregates_team_date_idx" ON "daily_aggregates"("team_id", "date" DESC);

