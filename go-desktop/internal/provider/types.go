// Package provider holds the in-process aggregation engine: provider
// metadata, the thread-safe Store, and the Manager that drives refresh.
//
// Design invariants (preserved from AIBar's internal/provider/types.go):
//
//   - FetchedAt is the *upstream* refresh time, NOT the local fetch attempt
//     time. UI shows "data from N minutes ago" — we want the cache server's
//     clock, not ours, so two clients hitting the same upstream cache always
//     show the same value.
//
//   - On error, the Manager calls buildErrorSnapshot which retains the prior
//     good SpendUSD/FetchedAt so the UI shows "stale data + refresh failed"
//     instead of blanking out.
//
//   - Budget overlay (UsagePercent, BudgetUSD) is applied AFTER provider
//     fetch in the manager. Providers don't know their own budget.
package provider

import (
	"context"
	"errors"
	"time"
)

// Unit — what the provider's spend value is denominated in. Most are USD;
// some (e.g., Windsurf) bill in opaque "credits" so the UI shows them as
// "C 42.5" instead of "$42.50".
type Unit string

const (
	UnitUSD     Unit = "usd"
	UnitCredits Unit = "credits"
)

// UsageSnapshot is the cross-cutting per-provider state. The Store is a
// map[ProviderID]UsageSnapshot under an RWMutex.
type UsageSnapshot struct {
	ProviderID    string    // stable id, e.g. "anthropic", "litellm"
	SpendUSD      float64   // raw value from the upstream
	BudgetUSD     float64   // overlaid by Manager from config
	UsagePercent  float64   // 100 * Spend / Budget when both > 0
	Unit          Unit      // see comments above
	FetchedAt     time.Time // upstream refresh time, see invariants
	CacheHit      bool      // diagnostic: did the upstream serve from cache?
	Tokens        int64     // pass-through; only LiteLLM populates today
	TokensLimit   int64     // 0 if unknown
	ErrorMessage  string    // empty on success
	StaleOnError  bool      // true when the snapshot is the previous good
	LastUpdatedAt time.Time // local clock when this struct was last written
}

func (s UsageSnapshot) Healthy() bool { return s.ErrorMessage == "" }

// ProviderInfo is the stable surface a Provider exposes for the UI/CLI.
type ProviderInfo struct {
	ID          string
	DisplayName string
	Unit        Unit
	Help        string
}

// ErrNotConfigured is the canonical sentinel a Provider returns when its
// config (token, endpoint, etc.) is missing. The Manager treats it as
// "skip silently" instead of surfacing as a fetch error.
var ErrNotConfigured = errors.New("provider not configured")

// Provider — the contract every builtin and gRPC plugin satisfies.
type Provider interface {
	Info() ProviderInfo
	IsConfigured() bool
	FetchUsage(ctx context.Context) (UsageSnapshot, error)
}

// HistoryProvider is an optional add-on for providers that can serve a
// daily-spend backfill. Builtins don't implement this; the Manager only
// uses it if asserted.
type HistoryProvider interface {
	FetchDaily(ctx context.Context, days int) ([]DailySpend, error)
}

type DailySpend struct {
	Date     time.Time
	SpendUSD float64
	Tokens   int64
}

// RetryPolicy — controls Manager.fetchWithRetry. Zero value disables retry.
type RetryPolicy struct {
	Attempts int           // number of attempts including the first
	Base     time.Duration // exponential base
	Max      time.Duration // cap
}

func DefaultRetryPolicy() RetryPolicy {
	return RetryPolicy{Attempts: 3, Base: 500 * time.Millisecond, Max: 4 * time.Second}
}
