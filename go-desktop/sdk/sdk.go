// Package sdk is the third-party-facing surface for plugin authors.
//
// Plugin authors depend on this module path to avoid pulling the whole
// daemon into their plugin process. The interfaces here are intentionally
// the same shape as the daemon's internal/provider/types — that way a
// plugin written against the SDK can be promoted to a builtin (or vice
// versa) without changing semantics.
//
// T9 status: interface shapes are stable; Serve() / ServeExtension() will
// wrap HashiCorp go-plugin once the gRPC layer is wired up. Until then the
// SDK is "import-clean" — code that depends on it compiles, just doesn't
// hand control to a plugin runtime.
package sdk

import (
	"context"
	"errors"
	"time"
)

// UsageSnapshot — what a provider plugin returns. Mirrors the daemon's
// provider.UsageSnapshot but lives here so plugins don't import the daemon.
type UsageSnapshot struct {
	ProviderID   string
	SpendUSD     float64
	BudgetUSD    float64
	Unit         string // "USD" | "credits" | "tokens"
	Tokens       int64
	TokensLimit  int64
	UsagePercent float64
	FetchedAt    time.Time
	ErrorMessage string
	ResetAt      time.Time
}

type ProviderInfo struct {
	ID                   string
	DisplayName          string
	IconPath             string
	DashboardURL         string
	SupportsSpend        bool
	SupportsTokens       bool
	SupportsUsagePercent bool
}

// ProviderPlugin — what a third-party provider implements. Note: no auth
// token in the signature. The host hands tokens via the inbound HTTP
// configuration the plugin owns; the daemon only pushes a sanitised
// AuthSnapshot via plugin extension params.
type ProviderPlugin interface {
	Info(ctx context.Context) (ProviderInfo, error)
	FetchUsage(ctx context.Context) (UsageSnapshot, error)
	IsConfigured(ctx context.Context) (bool, error)
}

type ExtensionPlugin interface {
	GetManifest(ctx context.Context) (string, error)
	FetchData(ctx context.Context, sourceID, paramsJSON string) (string, error)
	ExecuteAction(ctx context.Context, actionID, paramsJSON string) (success bool, message string, err error)
	ExecuteCLICommand(ctx context.Context, name string, args []string, flagsJSON string) (exit int, stdout, stderr string)
	GetSettings(ctx context.Context) (string, error)
	SetSetting(ctx context.Context, key, value string) error
}

// Serve / ServeExtension — runtime entry points a plugin's main() calls.
// Real impl wraps HashiCorp go-plugin; for now they return an error so the
// plugin process exits with a clear message until the real handshake lands.
func Serve(_ ProviderPlugin) error {
	return errNotImplemented
}

func ServeExtension(_ ExtensionPlugin) error {
	return errNotImplemented
}

var errNotImplemented = errors.New("sdk: plugin runtime not implemented yet (T9)")
