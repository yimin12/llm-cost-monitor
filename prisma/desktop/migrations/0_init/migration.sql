-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "schema_version" (
    "version" INTEGER NOT NULL,

    CONSTRAINT "schema_version_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_raw_tag" TEXT,
    "model" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "project" TEXT,
    "project_raw_slug" TEXT,
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
    "computed_cost_micro_usd" BIGINT NOT NULL,
    "pricing_snapshot_version" TEXT NOT NULL,
    "source_file" TEXT NOT NULL,
    "source_line_offset" BIGINT NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "path" TEXT NOT NULL,
    "mtime" BIGINT NOT NULL,
    "last_parsed_at" BIGINT NOT NULL,
    "last_offset" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "files_pkey" PRIMARY KEY ("path")
);

-- CreateTable
CREATE TABLE "pricing_overrides" (
    "model" TEXT NOT NULL,
    "input_per_m" BIGINT NOT NULL,
    "output_per_m" BIGINT NOT NULL,
    "cache_write_per_m" BIGINT,
    "cache_read_per_m" BIGINT,
    "source" TEXT NOT NULL,

    CONSTRAINT "pricing_overrides_pkey" PRIMARY KEY ("model")
);

-- CreateTable
CREATE TABLE "auth_user" (
    "sub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "picture_url" TEXT,
    "last_signed_in_at" BIGINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "auth_user_pkey" PRIMARY KEY ("sub")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "raised_at" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "acked_at" BIGINT,
    "resolved_at" BIGINT,
    "snoozed_until" BIGINT,
    "signature" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "events_timestamp_idx" ON "events"("timestamp" DESC);

-- CreateIndex
CREATE INDEX "events_provider_model_idx" ON "events"("provider", "model");

-- CreateIndex
CREATE INDEX "events_project_idx" ON "events"("project");

-- CreateIndex
CREATE INDEX "alerts_status_raised_idx" ON "alerts"("status", "raised_at" DESC);

