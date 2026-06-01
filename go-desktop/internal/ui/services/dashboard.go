// Package services hosts the Wails-bound services. Each service is a thin
// adapter over the existing daemon internals, surfaced to the JS side via
// `wails3 generate bindings`.
//
// T8 status: shapes and methods are stable; Wails registration wiring lands
// when the GUI binary is generated. Each method is callable today from Go,
// which keeps us honest about what the JS bindings will need.
package services

import (
	"context"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/app"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/provider"
)

// DashboardService — primary read surface for the dashboard window.
type DashboardService struct {
	a *app.App
}

func NewDashboardService(a *app.App) *DashboardService { return &DashboardService{a: a} }

// SnapshotDTO — JSON-friendly mirror of provider.UsageSnapshot. We don't
// expose the internal type directly so the wire shape and the Go shape can
// evolve independently.
type SnapshotDTO struct {
	ProviderID   string  `json:"providerId"`
	Unit         string  `json:"unit"`
	SpendUSD     float64 `json:"spendUsd"`
	BudgetUSD    float64 `json:"budgetUsd"`
	UsagePercent float64 `json:"usagePercent"`
	FetchedAt    string  `json:"fetchedAt"` // RFC3339
	CacheHit     bool    `json:"cacheHit"`
	Tokens       int64   `json:"tokens,omitempty"`
	TokensLimit  int64   `json:"tokensLimit,omitempty"`
	Error        string  `json:"error,omitempty"`
	StaleOnError bool    `json:"staleOnError,omitempty"`
}

func toDTO(s provider.UsageSnapshot) SnapshotDTO {
	return SnapshotDTO{
		ProviderID:   s.ProviderID,
		Unit:         string(s.Unit),
		SpendUSD:     s.SpendUSD,
		BudgetUSD:    s.BudgetUSD,
		UsagePercent: s.UsagePercent,
		FetchedAt:    s.FetchedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
		CacheHit:     s.CacheHit,
		Tokens:       s.Tokens,
		TokensLimit:  s.TokensLimit,
		Error:        s.ErrorMessage,
		StaleOnError: s.StaleOnError,
	}
}

func (d *DashboardService) GetAllUsage() []SnapshotDTO {
	all := d.a.Store.All()
	out := make([]SnapshotDTO, 0, len(all))
	for _, s := range all {
		out = append(out, toDTO(s))
	}
	return out
}

func (d *DashboardService) RefreshAll(ctx context.Context) error {
	return d.a.Manager.RefreshAll(ctx)
}

func (d *DashboardService) RefreshOne(ctx context.Context, id string) error {
	return d.a.Manager.RefreshOne(ctx, id)
}

func (d *DashboardService) GetTotalSpendUSD() float64 {
	return d.a.Store.TotalSpendUSD()
}
