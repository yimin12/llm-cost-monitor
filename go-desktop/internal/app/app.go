// Package app is the singleton composition root.
//
// Init order (mirrors AIBar's docs/ARCHITECTURE.md:131):
//
//  1. EnsureDirs (~/.lcmbar/...)
//  2. Config (Viper)
//  3. Logger
//  4. Provider Store
//  5. Provider Manager
//  6. Auth (T7) — SessionManager + JWKS cache; wires the Bearer/email
//     getters into builtin so the access token never crosses package lines
//     in plaintext form.
//  7. Builtin providers registered into Manager
//
// Shutdown is LIFO via RegisterShutdownHook.
package app

import (
	"context"
	"log/slog"
	"os"
	"sync"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/auth"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/config"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/provider"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/provider/builtin"
)

type App struct {
	Cfg     *config.Config
	Log     *slog.Logger
	Store   *provider.Store
	Manager *provider.Manager
	Auth    *auth.SessionManager

	mu    sync.Mutex
	hooks []func(context.Context) error
}

var (
	once sync.Once
	cur  *App
	err  error
)

// Get returns the singleton App, initialising on first call.
func Get() (*App, error) {
	once.Do(func() {
		cur, err = build()
	})
	return cur, err
}

func build() (*App, error) {
	cfg, cerr := config.New()
	if cerr != nil {
		return nil, cerr
	}
	log := newLogger()
	store := provider.NewStore()

	mgr := provider.NewManager(store, budgetView{cfg: cfg}, log)

	sm := buildSessionManager(cfg, log)
	wireBuiltinAuth(sm)

	app := &App{Cfg: cfg, Log: log, Store: store, Manager: mgr, Auth: sm}

	threshold := cfg.AppSettings().BudgetWarningPercent
	bn := provider.NewBudgetNotifier(threshold, func(s provider.UsageSnapshot) {
		log.Warn("budget threshold crossed", "provider", s.ProviderID, "percent", s.UsagePercent)
		// TODO(T8): emit a desktop notification through the GUI service.
	}, log)
	store.OnUpdate(bn.OnSnapshot)

	return app, nil
}

func buildSessionManager(cfg *config.Config, log *slog.Logger) *auth.SessionManager {
	v := cfg.Underlying()
	flow := auth.FlowConfig{
		Issuer:       v.GetString("auth.issuer"),
		ClientID:     v.GetString("auth.client_id"),
		Scopes:       v.GetStringSlice("auth.scopes"),
		RedirectPort: v.GetInt("auth.redirect_port"),
	}
	store := pickTokenStore(log)
	jwks := auth.NewJWKSCache()
	sm := auth.NewSessionManager(flow, store, jwks)
	if err := sm.LoadFromStore(); err != nil {
		log.Warn("session load", "err", err)
	}
	return sm
}

// pickTokenStore — keyring on desktop, memory fallback when LCMBAR_HEADLESS
// is set. Memory is also what tests should use.
func pickTokenStore(log *slog.Logger) auth.TokenStore {
	if isHeadless() {
		log.Info("auth: using in-memory token store (headless)")
		return &auth.MemoryStore{}
	}
	return &auth.KeyringStore{}
}

// wireBuiltinAuth — hand the SessionManager's getters to the builtin HTTP
// helpers. These three calls are the entire seam between the auth subsystem
// and the providers; nothing else in the codebase reaches into Session.
//
// The token + email getters fall back to LCMBAR_USER_TOKEN / LCMBAR_USER_EMAIL
// when no real session is loaded. That keeps headless dev and the mock-cache
// E2E demo runnable without standing up a full IdP.
func wireBuiltinAuth(sm *auth.SessionManager) {
	builtin.SetTokenGetter(func() (string, bool) {
		if t, ok := sm.AccessToken(); ok {
			return t, true
		}
		if t := os.Getenv("LCMBAR_USER_TOKEN"); t != "" {
			return t, true
		}
		return "", false
	})
	builtin.SetUserEmailGetter(func() (string, bool) {
		if e, ok := sm.Email(); ok {
			return e, true
		}
		if e := os.Getenv("LCMBAR_USER_EMAIL"); e != "" {
			return e, true
		}
		return "", false
	})
	builtin.SetTokenRefresher(func(ctx context.Context) error { return sm.ForceRefresh(ctx) })
}

// RegisterShutdownHook stacks a cleanup func. Hooks run LIFO on Shutdown.
func (a *App) RegisterShutdownHook(fn func(context.Context) error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.hooks = append(a.hooks, fn)
}

// Shutdown drains hooks LIFO, surfacing the FIRST error after running ALL
// hooks (single hook failure should not skip cleanup of later layers).
func (a *App) Shutdown(ctx context.Context) error {
	a.mu.Lock()
	hooks := append([]func(context.Context) error(nil), a.hooks...)
	a.hooks = nil
	a.mu.Unlock()

	var first error
	for i := len(hooks) - 1; i >= 0; i-- {
		if e := hooks[i](ctx); e != nil && first == nil {
			first = e
		}
	}
	return first
}

// budgetView adapts *config.Config into provider.BudgetLookup without
// exposing the whole config surface to the provider package.
type budgetView struct{ cfg *config.Config }

func (b budgetView) BudgetUSDFor(id string) (float64, bool) {
	bud, ok := b.cfg.GetBudget(id)
	if !ok || bud.LimitUSD <= 0 {
		return 0, false
	}
	return bud.LimitUSD, true
}

// Reset is for tests that want a clean singleton between cases.
func Reset() {
	once = sync.Once{}
	cur = nil
	err = nil
}
