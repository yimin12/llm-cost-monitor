// Package sync owns the wire types the desktop posts to /events:batchUpsert.
// Field tags MUST match src/shared/sync.ts byte-for-byte — anything else
// is a wire-incompatible drift bug.
package sync

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// Kind discriminates between event-level and daily-aggregate payloads.
type Kind string

const (
	KindEvent Kind = "event"
	KindDaily Kind = "daily"
)

// Privacy mirrors the three privacy levels the desktop enforces before
// upload. The server clamps to the team's privacy_floor independently.
type Privacy string

const (
	PrivacyFull          Privacy = "full"
	PrivacyRedacted      Privacy = "redacted"
	PrivacyAggregateOnly Privacy = "aggregateOnly"
)

// Event is one usage event, post-redaction. Nullable JS fields map to *T64
// pointer fields here so the wire encoding round-trips losslessly. Bigints
// land as int64 — a positive value past 2^63 would mean a single event of
// nearly a billion dollars in cost, which is well outside the threat model.
type Event struct {
	Kind         Kind   `json:"kind"`
	SyncEventID  string `json:"sync_event_id"`
	TeamID       string `json:"team_id"`
	UserID       string `json:"user_id"`
	NodeID       string `json:"node_id"`
	LocalEventID string `json:"local_event_id"`
	PayloadHash  string `json:"payload_hash"`
	PrivacyLevel Privacy `json:"privacy_level"`

	Provider       string `json:"provider"`
	ProviderRawTag string `json:"provider_raw_tag"`
	Model          string `json:"model"`
	Timestamp      int64  `json:"timestamp"`

	Project     string `json:"project"`
	ProjectHash string `json:"project_hash"`
	SessionID   string `json:"session_id"`
	MessageID   string `json:"message_id"`

	InputTokens           int64 `json:"input_tokens"`
	OutputTokens          int64 `json:"output_tokens"`
	CacheReadTokens       int64 `json:"cache_read_tokens"`
	CacheCreation5mTokens int64 `json:"cache_creation_5m_tokens"`
	CacheCreation1hTokens int64 `json:"cache_creation_1h_tokens"`
	ReasoningTokens       *int64 `json:"reasoning_tokens"`
	ToolCallCount         *int64 `json:"tool_call_count"`
	LatencyMs             *int64 `json:"latency_ms"`

	CostMicroUSD          int64  `json:"cost_micro_usd"`
	PricingSnapshotVersion string `json:"pricing_snapshot_version"`
}

// Daily is the aggregateOnly path: one row per (date, provider, model) for
// a (team, user, node) tuple. Same UPSERT semantics as TS daily_aggregates.
type Daily struct {
	Kind   Kind   `json:"kind"`
	TeamID string `json:"team_id"`
	UserID string `json:"user_id"`
	NodeID string `json:"node_id"`
	Date   string `json:"date"` // YYYY-MM-DD UTC
	Provider string `json:"provider"`
	Model    string `json:"model"`

	EventCount             int64  `json:"event_count"`
	InputTokens            int64  `json:"input_tokens"`
	OutputTokens           int64  `json:"output_tokens"`
	CacheReadTokens        int64  `json:"cache_read_tokens"`
	CacheCreation5mTokens  int64  `json:"cache_creation_5m_tokens"`
	CacheCreation1hTokens  int64  `json:"cache_creation_1h_tokens"`
	ReasoningTokens        int64  `json:"reasoning_tokens"`
	CostMicroUSD           int64  `json:"cost_micro_usd"`
	PricingSnapshotVersion string `json:"pricing_snapshot_version"`
}

// EventIDInput is the canonical input to sha256() for sync_event_id. Must
// stay byte-identical with src/shared/sync.ts:syncEventIdInput. The server
// recomputes this and rejects payloads where the client-supplied id does
// not match — that's the forgery guard documented in docs/team-sync.md.
func EventIDInput(teamID, userID, nodeID, localEventID string) string {
	return strings.Join([]string{teamID, userID, nodeID, localEventID}, "|")
}

// ComputeEventID is the server-side recomputation. Returned hex matches
// `crypto.createHash('sha256').update(...).digest('hex')` from Node.
func ComputeEventID(teamID, userID, nodeID, localEventID string) string {
	sum := sha256.Sum256([]byte(EventIDInput(teamID, userID, nodeID, localEventID)))
	return hex.EncodeToString(sum[:])
}

// BatchUpsertResponse mirrors the TS shape one-for-one. `cursor` is the
// max event timestamp the server saw in this batch; the client uses it to
// advance its outbox watermark.
type BatchUpsertResponse struct {
	Accepted   []string         `json:"accepted"`
	Duplicates []string         `json:"duplicates"`
	Rejected   []RejectedReason `json:"rejected"`
	Cursor     int64            `json:"cursor"`
}

type RejectedReason struct {
	SyncEventID string `json:"sync_event_id"`
	Reason      string `json:"reason"`
}
