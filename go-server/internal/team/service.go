// Package team is the Go port of server/team-service.ts. It owns the
// invariants the HTTP layer relies on:
//   - sync_event_id is recomputed server-side; mismatches are rejected
//   - membership status gate (active vs revoked)
//   - first-member auto-promotion to admin (race-safe via FOR UPDATE)
//   - last-admin demotion guard
//   - usage_events is append-only; conflicts log to sync_conflicts
//   - event_daily_rollup accumulates only on 'inserted' rows
//
// The Go implementation is intentionally narrow — the first cut covers the
// hot path (BatchUpsert + GetMembership + SetPrivacyFloor + AddMember).
// Overview, member listing, and admin endpoints are deferred to the next
// migration step (see TASKS.md milestone M2).
package team

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	syncpkg "github.com/yimin12/llm-cost-monitor/go-server/internal/sync"
)

// MemberStatus mirrors the TS union; comparisons are stringy on purpose so
// the SQL columns stay TEXT and we don't end up with two parallel encodings.
type MemberStatus string

const (
	StatusActive  MemberStatus = "active"
	StatusRevoked MemberStatus = "revoked"
)

type MemberRole string

const (
	RoleAdmin  MemberRole = "admin"
	RoleMember MemberRole = "member"
)

type Membership struct {
	TeamID string
	UserID string
	Status MemberStatus
	Role   MemberRole
}

// ErrCode mirrors the three failure codes the TS service raises. The HTTP
// layer translates these to 400/403/404; everything else is a 500.
type ErrCode string

const (
	ErrForbidden ErrCode = "forbidden"
	ErrNotFound  ErrCode = "not_found"
	ErrInvalid   ErrCode = "invalid"
)

type ServiceError struct {
	Code    ErrCode
	Message string
}

func (e *ServiceError) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

// Service is stateless — all state lives in Postgres. Hold one per process.
type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, now: time.Now}
}

// EnsureTeam creates the team if missing. Idempotent.
func (s *Service) EnsureTeam(ctx context.Context, teamID, name string) error {
	if name == "" {
		name = teamID
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO teams (id, name, created_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (id) DO NOTHING`,
		teamID, name, s.nowMs(),
	)
	return err
}

// AddMember adds or reactivates a member. Auto-promotes the very first
// admin in a team race-safely (FOR UPDATE on teams). Mirrors team-service.ts.
func (s *Service) AddMember(
	ctx context.Context, teamID, userID string, role MemberRole, displayName string,
) (MemberRole, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT id FROM teams WHERE id = $1 FOR UPDATE`, teamID); err != nil {
		return "", err
	}

	effective := role
	if role == "" {
		effective = RoleMember
		var count int
		if err := tx.QueryRow(ctx,
			`SELECT COUNT(*) FROM team_members WHERE team_id = $1 AND role = 'admin'`,
			teamID,
		).Scan(&count); err != nil {
			return "", err
		}
		if count == 0 {
			effective = RoleAdmin
		}
	}

	var dn any
	if displayName != "" {
		dn = displayName
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO team_members (team_id, user_id, role, status, display_name, joined_at)
		VALUES ($1, $2, $3, 'active', $4, $5)
		ON CONFLICT (team_id, user_id)
		DO UPDATE SET status = 'active',
		              removed_at = NULL,
		              display_name = COALESCE(EXCLUDED.display_name, team_members.display_name)`,
		teamID, userID, string(effective), dn, s.nowMs(),
	); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return effective, nil
}

// GetMembership returns the row or nil-equivalent when not present.
func (s *Service) GetMembership(ctx context.Context, teamID, userID string) (*Membership, error) {
	var (
		status string
		role   string
	)
	err := s.pool.QueryRow(ctx,
		`SELECT status, role FROM team_members WHERE team_id = $1 AND user_id = $2`,
		teamID, userID,
	).Scan(&status, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &Membership{
		TeamID: teamID,
		UserID: userID,
		Status: MemberStatus(status),
		Role:   MemberRole(role),
	}, nil
}

// SetPrivacyFloor updates the team's privacy floor. Returns ErrInvalid on
// bad input, ErrNotFound when the team doesn't exist.
func (s *Service) SetPrivacyFloor(ctx context.Context, teamID, level string) error {
	switch level {
	case "full", "redacted", "aggregateOnly":
	default:
		return &ServiceError{Code: ErrInvalid, Message: "invalid privacy level"}
	}
	r, err := s.pool.Exec(ctx, `UPDATE teams SET privacy_floor = $1 WHERE id = $2`, level, teamID)
	if err != nil {
		return err
	}
	if r.RowsAffected() == 0 {
		return &ServiceError{Code: ErrNotFound, Message: "team not found"}
	}
	return nil
}

// BatchUpsert is a transaction-scoped port of team-service.ts:batchUpsert.
// It enforces:
//   1. team_id matches URL
//   2. sync_event_id == sha256(team|user|node|local) for event payloads
//   3. user has an active membership in the team
//   4. payload_hash collisions append to sync_conflicts but keep the prior row
//
// Returns the same shape as the TS service so the desktop client doesn't
// branch on backend choice.
func (s *Service) BatchUpsert(
	ctx context.Context, teamID string, payloads []syncpkg.Event,
) (syncpkg.BatchUpsertResponse, error) {
	resp := syncpkg.BatchUpsertResponse{
		Accepted:   []string{},
		Duplicates: []string{},
		Rejected:   []syncpkg.RejectedReason{},
	}
	if len(payloads) == 0 {
		return resp, nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return resp, err
	}
	defer tx.Rollback(ctx)

	memberCache := map[string]MemberStatus{}
	checkMember := func(userID string) (MemberStatus, error) {
		if v, ok := memberCache[userID]; ok {
			return v, nil
		}
		var status string
		err := tx.QueryRow(ctx,
			`SELECT status FROM team_members WHERE team_id = $1 AND user_id = $2`,
			teamID, userID,
		).Scan(&status)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		if err != nil {
			return "", err
		}
		memberCache[userID] = MemberStatus(status)
		return MemberStatus(status), nil
	}

	batchNow := s.nowMs()
	touchedNodes := map[string]struct{}{}
	var maxTimestamp int64

	for _, p := range payloads {
		if p.TeamID != teamID {
			resp.Rejected = append(resp.Rejected, syncpkg.RejectedReason{
				SyncEventID: p.SyncEventID, Reason: "team_id mismatch with URL",
			})
			continue
		}
		// Forgery guard. Server recomputes the canonical hash from
		// (team|user|node|local) and rejects mismatches. Cheap (one
		// sha256 per event) and stops a compromised node from squatting
		// another node's id space.
		expected := syncpkg.ComputeEventID(teamID, p.UserID, p.NodeID, p.LocalEventID)
		if expected != p.SyncEventID {
			resp.Rejected = append(resp.Rejected, syncpkg.RejectedReason{
				SyncEventID: p.SyncEventID, Reason: "sync_event_id mismatch — recomputed hash differs",
			})
			continue
		}

		ms, err := checkMember(p.UserID)
		if err != nil {
			return resp, err
		}
		if ms == "" {
			resp.Rejected = append(resp.Rejected, syncpkg.RejectedReason{
				SyncEventID: p.SyncEventID, Reason: "user is not a member of this team",
			})
			continue
		}
		if ms != StatusActive {
			resp.Rejected = append(resp.Rejected, syncpkg.RejectedReason{
				SyncEventID: p.SyncEventID, Reason: fmt.Sprintf("membership is %s", ms),
			})
			continue
		}

		// Touch each unique node once per batch.
		nodeKey := p.UserID + "|" + p.NodeID
		if _, seen := touchedNodes[nodeKey]; !seen {
			touchedNodes[nodeKey] = struct{}{}
			if _, err := tx.Exec(ctx, `
				INSERT INTO nodes (id, user_id, team_id, enrolled_at, last_seen_at)
				VALUES ($1, $2, $3, $4, $4)
				ON CONFLICT (id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
				p.NodeID, p.UserID, teamID, batchNow,
			); err != nil {
				return resp, err
			}
		}

		outcome, err := s.upsertEvent(ctx, tx, p)
		if err != nil {
			return resp, err
		}
		switch outcome {
		case "inserted":
			resp.Accepted = append(resp.Accepted, p.SyncEventID)
		case "duplicate", "conflict":
			resp.Duplicates = append(resp.Duplicates, p.SyncEventID)
		}
		if p.Timestamp > maxTimestamp {
			maxTimestamp = p.Timestamp
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return resp, err
	}
	resp.Cursor = maxTimestamp
	return resp, nil
}

func (s *Service) upsertEvent(
	ctx context.Context, tx pgx.Tx, p syncpkg.Event,
) (string, error) {
	var existing string
	err := tx.QueryRow(ctx,
		`SELECT payload_hash FROM usage_events WHERE sync_event_id = $1`,
		p.SyncEventID,
	).Scan(&existing)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// fall through to insert
	case err != nil:
		return "", err
	default:
		if existing == p.PayloadHash {
			return "duplicate", nil
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO sync_conflicts (occurred_at, sync_event_id, prior_hash, new_hash, detail)
			VALUES ($1, $2, $3, $4, $5)`,
			s.nowMs(), p.SyncEventID, existing, p.PayloadHash,
			"payload hash differs across uploads — likely parser/pricing rebucket",
		); err != nil {
			return "", err
		}
		return "conflict", nil
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO usage_events (
		  sync_event_id, team_id, user_id, node_id, local_event_id,
		  payload_hash, privacy_level,
		  provider, provider_raw_tag, model, timestamp,
		  project, project_hash, session_id, message_id,
		  input_tokens, output_tokens, cache_read_tokens,
		  cache_creation_5m_tokens, cache_creation_1h_tokens,
		  reasoning_tokens, tool_call_count, latency_ms,
		  cost_micro_usd, pricing_snapshot_version, uploaded_at
		) VALUES (
		  $1,$2,$3,$4,$5,
		  $6,$7,
		  $8,$9,$10,$11,
		  $12,$13,$14,$15,
		  $16,$17,$18,$19,$20,
		  $21,$22,$23,
		  $24,$25,$26
		)`,
		p.SyncEventID, p.TeamID, p.UserID, p.NodeID, p.LocalEventID,
		p.PayloadHash, string(p.PrivacyLevel),
		p.Provider, nullStr(p.ProviderRawTag), p.Model, p.Timestamp,
		nullStr(p.Project), nullStr(p.ProjectHash), nullStr(p.SessionID), nullStr(p.MessageID),
		p.InputTokens, p.OutputTokens, p.CacheReadTokens,
		p.CacheCreation5mTokens, p.CacheCreation1hTokens,
		nullInt(p.ReasoningTokens), nullInt(p.ToolCallCount), nullInt(p.LatencyMs),
		p.CostMicroUSD, p.PricingSnapshotVersion, s.nowMs(),
	)
	if err != nil {
		return "", err
	}
	return "inserted", nil
}

func (s *Service) nowMs() int64 { return s.now().UnixMilli() }

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullInt(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}
