// Package httpapi is the Go port of server/http.ts. The router is a hand
// rolled regex matcher to keep the dependency surface tiny — same as TS.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"

	"github.com/yimin12/llm-cost-monitor/go-server/internal/auth"
	syncpkg "github.com/yimin12/llm-cost-monitor/go-server/internal/sync"
	"github.com/yimin12/llm-cost-monitor/go-server/internal/team"
)

// Logger is the slog facade the server logs through. Pass slog.Default() in
// main(); tests can swap to discard.
type Logger interface {
	Info(msg string, args ...any)
	Warn(msg string, args ...any)
	Error(msg string, args ...any)
}

type App struct {
	Service    *team.Service
	Authorizer auth.Authorizer
	Log        Logger
}

func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) {
		a.routeV1(w, r)
	})
	return mux
}

var (
	reBatchUpsert = regexp.MustCompile(`^/v1/teams/([^/]+)/events:batchUpsert$`)
	reUsage       = regexp.MustCompile(`^/v1/teams/([^/]+)/usage$`)
	reMembers     = regexp.MustCompile(`^/v1/teams/([^/]+)/members$`)
	reMember      = regexp.MustCompile(`^/v1/teams/([^/]+)/members/([^/]+)$`)
	rePrivacy     = regexp.MustCompile(`^/v1/teams/([^/]+)/privacy-floor$`)
)

func (a *App) routeV1(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	if m := reBatchUpsert.FindStringSubmatch(path); m != nil && r.Method == http.MethodPost {
		a.handleBatchUpsert(w, r, m[1])
		return
	}
	if m := reUsage.FindStringSubmatch(path); m != nil && r.Method == http.MethodGet {
		a.handleUsage(w, r, m[1])
		return
	}
	if m := reMembers.FindStringSubmatch(path); m != nil && r.Method == http.MethodPost {
		a.handleAddMember(w, r, m[1])
		return
	}
	if m := reMember.FindStringSubmatch(path); m != nil {
		switch r.Method {
		case http.MethodDelete:
			a.handleRevokeMember(w, r, m[1], m[2])
			return
		case http.MethodPatch:
			a.handleSetRole(w, r, m[1], m[2])
			return
		}
	}
	if m := rePrivacy.FindStringSubmatch(path); m != nil && r.Method == http.MethodPatch {
		a.handleSetPrivacy(w, r, m[1])
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
}

func (a *App) handleBatchUpsert(w http.ResponseWriter, r *http.Request, teamID string) {
	auth, ok := a.authorize(w, r)
	if !ok {
		return
	}
	_ = auth // user identity not consumed here (server enforces team_id match per payload)

	var body struct {
		Events []syncpkg.Event `json:"events"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	resp, err := a.Service.BatchUpsert(r.Context(), teamID, body.Events)
	if err != nil {
		var se *team.ServiceError
		if errors.As(err, &se) {
			writeServiceError(w, se)
			return
		}
		a.Log.Error("batchUpsert", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (a *App) handleUsage(w http.ResponseWriter, r *http.Request, teamID string) {
	// Overview is part of milestone M2 in TASKS.md; stub to keep wire
	// shape consistent so the desktop client renders an empty dashboard
	// instead of crashing during the rollout window.
	_, ok := a.authorize(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusNotImplemented, map[string]string{
		"error":   "not_implemented",
		"message": "GET /usage is part of the Go-server M2 milestone — fall back to the TS server",
	})
	_ = teamID
}

func (a *App) handleAddMember(w http.ResponseWriter, r *http.Request, teamID string) {
	if !a.requireAdmin(w, r, teamID) {
		return
	}
	var body struct {
		UserID      string           `json:"userId"`
		DisplayName string           `json:"displayName"`
		Role        team.MemberRole  `json:"role"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	if body.UserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid", "message": "userId required"})
		return
	}
	if body.Role != "" && body.Role != team.RoleAdmin && body.Role != team.RoleMember {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid", "message": "role must be admin or member"})
		return
	}
	role, err := a.Service.AddMember(r.Context(), teamID, body.UserID, body.Role, body.DisplayName)
	if err != nil {
		var se *team.ServiceError
		if errors.As(err, &se) {
			writeServiceError(w, se)
			return
		}
		a.Log.Error("addMember", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"userId": body.UserID, "role": role})
}

func (a *App) handleRevokeMember(_ http.ResponseWriter, _ *http.Request, _, _ string) {
	// TODO(M2): implement revokeMember in Service then wire here.
}

func (a *App) handleSetRole(_ http.ResponseWriter, _ *http.Request, _, _ string) {
	// TODO(M2): implement setMemberRole in Service then wire here.
}

func (a *App) handleSetPrivacy(w http.ResponseWriter, r *http.Request, teamID string) {
	if !a.requireAdmin(w, r, teamID) {
		return
	}
	var body struct {
		Level string `json:"level"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	if err := a.Service.SetPrivacyFloor(r.Context(), teamID, body.Level); err != nil {
		var se *team.ServiceError
		if errors.As(err, &se) {
			writeServiceError(w, se)
			return
		}
		a.Log.Error("setPrivacyFloor", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"level": body.Level})
}

func (a *App) authorize(w http.ResponseWriter, r *http.Request) (string, bool) {
	res, err := a.Authorizer.Authorize(r.Context(), r)
	if err != nil {
		a.Log.Error("authorize", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return "", false
	}
	if res.UserID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return "", false
	}
	return res.UserID, true
}

func (a *App) requireAdmin(w http.ResponseWriter, r *http.Request, teamID string) bool {
	userID, ok := a.authorize(w, r)
	if !ok {
		return false
	}
	m, err := a.Service.GetMembership(r.Context(), teamID, userID)
	if err != nil {
		a.Log.Error("getMembership", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return false
	}
	if m == nil || m.Status != team.StatusActive || m.Role != team.RoleAdmin {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return false
	}
	return true
}

func writeServiceError(w http.ResponseWriter, e *team.ServiceError) {
	status := http.StatusBadRequest
	switch e.Code {
	case team.ErrForbidden:
		status = http.StatusForbidden
	case team.ErrNotFound:
		status = http.StatusNotFound
	}
	writeJSON(w, status, map[string]any{"error": e.Code, "message": e.Message})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func readJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, dst)
}

// Compile-time check that slog.Logger satisfies our interface — keeps the
// main.go wiring honest without taking a hard dep on slog from the package.
var _ Logger = (*slog.Logger)(nil)

// Background returns a background-context handler for in-process tests that
// don't have a real *http.Request lifecycle (used by go-server/internal/team
// integration tests that bypass HTTP).
func Background() context.Context { return context.Background() }
