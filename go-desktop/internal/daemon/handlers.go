package daemon

import (
	"context"
	"errors"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/app"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/version"
)

// registerCoreHandlers wires the small handler set every build needs.
// Feature areas (auth, plugin, tools) register their own via their packages
// during init — that pattern keeps this file from sprawling.
func registerCoreHandlers(srv *IPCServer, a *app.App, shutdown context.CancelFunc) {
	srv.Register("version", func(context.Context, map[string]any) (any, error) {
		return map[string]any{
			"version": version.Version,
			"commit":  version.Commit,
		}, nil
	})

	srv.Register("status", func(context.Context, map[string]any) (any, error) {
		snaps := a.Store.All()
		out := make([]map[string]any, 0, len(snaps))
		for _, s := range snaps {
			out = append(out, map[string]any{
				"providerId":   s.ProviderID,
				"unit":         string(s.Unit),
				"spendUsd":     s.SpendUSD,
				"budgetUsd":    s.BudgetUSD,
				"usagePercent": s.UsagePercent,
				"fetchedAt":    s.FetchedAt,
				"cacheHit":     s.CacheHit,
				"tokens":       s.Tokens,
				"tokensLimit":  s.TokensLimit,
				"error":        s.ErrorMessage,
				"staleOnError": s.StaleOnError,
			})
		}
		return out, nil
	})

	srv.Register("refresh", func(ctx context.Context, args map[string]any) (any, error) {
		if id, ok := args["provider"].(string); ok && id != "" {
			return nil, a.Manager.RefreshOne(ctx, id)
		}
		return nil, a.Manager.RefreshAll(ctx)
	})

	srv.Register("quit", func(context.Context, map[string]any) (any, error) {
		shutdown()
		return map[string]any{"goodbye": true}, nil
	})

	srv.Register("plugin-list", func(context.Context, map[string]any) (any, error) {
		// T9 stub — returns empty until the plugin host lands.
		return []any{}, nil
	})

	// Auth handlers are registered by the auth package itself once a
	// SessionManager is constructed — see internal/auth/handlers.go.
	_ = errors.New // placeholder to keep imports honest if we trim later
}
