package provider

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"time"
)

// BudgetLookup — Manager calls this for every successful fetch to overlay
// budget/usagePercent. The shape matches config.Config.GetBudget.
type BudgetLookup interface {
	BudgetUSDFor(providerID string) (limitUSD float64, ok bool)
}

// Manager owns the lifecycle: registration, refresh-all (parallel),
// refresh-one, retry-with-backoff, budget overlay, and the daily heartbeat.
type Manager struct {
	mu        sync.RWMutex
	providers map[string]Provider
	store     *Store
	budgets   BudgetLookup
	retry     RetryPolicy
	log       *slog.Logger

	// daily heartbeat
	heartbeatStop chan struct{}
}

func NewManager(store *Store, budgets BudgetLookup, log *slog.Logger) *Manager {
	if log == nil {
		log = slog.Default()
	}
	return &Manager{
		providers: make(map[string]Provider),
		store:     store,
		budgets:   budgets,
		retry:     DefaultRetryPolicy(),
		log:       log,
	}
}

func (m *Manager) Register(p Provider) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := p.Info().ID
	m.providers[id] = p
}

func (m *Manager) Unregister(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.providers, id)
}

func (m *Manager) Providers() []Provider {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Provider, 0, len(m.providers))
	for _, p := range m.providers {
		out = append(out, p)
	}
	return out
}

func (m *Manager) SetRetryPolicy(p RetryPolicy) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.retry = p
}

// RefreshAll fans out one goroutine per provider. Partial failure is the
// expected mode (one upstream is flaky) — this returns nil unless EVERY
// provider failed, on which it returns the last error so the daemon-status
// CLI can colour-code the whole thing.
func (m *Manager) RefreshAll(ctx context.Context) error {
	m.mu.RLock()
	provs := make([]Provider, 0, len(m.providers))
	for _, p := range m.providers {
		provs = append(provs, p)
	}
	m.mu.RUnlock()

	if len(provs) == 0 {
		return nil
	}

	var wg sync.WaitGroup
	errs := make([]error, len(provs))
	for i, p := range provs {
		wg.Add(1)
		go func(i int, p Provider) {
			defer wg.Done()
			errs[i] = m.refreshOne(ctx, p)
		}(i, p)
	}
	wg.Wait()

	failures := 0
	var lastErr error
	for _, e := range errs {
		if e != nil && !errors.Is(e, ErrNotConfigured) {
			failures++
			lastErr = e
		}
	}
	if failures == len(provs) {
		return fmt.Errorf("all providers failed: last=%w", lastErr)
	}
	return nil
}

// RefreshOne fetches the named provider once.
func (m *Manager) RefreshOne(ctx context.Context, id string) error {
	m.mu.RLock()
	p, ok := m.providers[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("provider %q not registered", id)
	}
	return m.refreshOne(ctx, p)
}

func (m *Manager) refreshOne(ctx context.Context, p Provider) error {
	id := p.Info().ID
	if !p.IsConfigured() {
		// Silent skip — UI shouldn't badge this as an error.
		return ErrNotConfigured
	}
	snap, err := m.fetchWithRetry(ctx, p)
	if err != nil {
		errSnap := m.buildErrorSnapshot(p, err)
		m.store.Set(errSnap)
		m.log.Warn("provider fetch failed", "provider", id, "err", err)
		return err
	}
	snap = m.applyBudget(snap)
	m.store.Set(snap)
	return nil
}

func (m *Manager) fetchWithRetry(ctx context.Context, p Provider) (UsageSnapshot, error) {
	m.mu.RLock()
	policy := m.retry
	m.mu.RUnlock()

	var lastErr error
	attempts := policy.Attempts
	if attempts < 1 {
		attempts = 1
	}
	for i := 0; i < attempts; i++ {
		if i > 0 {
			delay := backoff(policy.Base, policy.Max, i)
			select {
			case <-ctx.Done():
				return UsageSnapshot{}, ctx.Err()
			case <-time.After(delay):
			}
		}
		snap, err := p.FetchUsage(ctx)
		if err == nil {
			snap.ProviderID = p.Info().ID
			snap.Unit = p.Info().Unit
			return snap, nil
		}
		// ErrNotConfigured can be raised mid-flight if e.g. token expired.
		if errors.Is(err, ErrNotConfigured) {
			return UsageSnapshot{}, err
		}
		lastErr = err
	}
	return UsageSnapshot{}, lastErr
}

func backoff(base, max time.Duration, attempt int) time.Duration {
	d := time.Duration(math.Pow(2, float64(attempt-1))) * base
	if d > max {
		return max
	}
	return d
}

// buildErrorSnapshot returns a snapshot the Store can hold instead of
// dropping the row. It retains the prior good Spend/FetchedAt so the UI
// can show "$42.50 — refresh failed (5m ago)".
func (m *Manager) buildErrorSnapshot(p Provider, err error) UsageSnapshot {
	id := p.Info().ID
	prior, _ := m.store.Get(id)
	return UsageSnapshot{
		ProviderID:   id,
		Unit:         p.Info().Unit,
		SpendUSD:     prior.SpendUSD,
		BudgetUSD:    prior.BudgetUSD,
		UsagePercent: prior.UsagePercent,
		FetchedAt:    prior.FetchedAt,
		CacheHit:     prior.CacheHit,
		Tokens:       prior.Tokens,
		TokensLimit:  prior.TokensLimit,
		ErrorMessage: err.Error(),
		StaleOnError: !prior.FetchedAt.IsZero(),
	}
}

// applyBudget overlays config-side BudgetUSD + computed UsagePercent.
// Called only on success; errors keep the prior overlay.
func (m *Manager) applyBudget(snap UsageSnapshot) UsageSnapshot {
	if m.budgets == nil {
		return snap
	}
	limit, ok := m.budgets.BudgetUSDFor(snap.ProviderID)
	if !ok || limit <= 0 {
		return snap
	}
	snap.BudgetUSD = limit
	snap.UsagePercent = 100 * snap.SpendUSD / limit
	return snap
}

// StartAutoRefresh kicks off the periodic refresh ticker plus a daily
// heartbeat goroutine. Returns a cancel func.
func (m *Manager) StartAutoRefresh(ctx context.Context, interval time.Duration) func() {
	ctx, cancel := context.WithCancel(ctx)
	go m.refreshLoop(ctx, interval)
	go m.heartbeatLoop(ctx)
	return cancel
}

func (m *Manager) refreshLoop(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	// First refresh on startup, no wait.
	if err := m.RefreshAll(ctx); err != nil {
		m.log.Debug("startup refresh", "err", err)
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := m.RefreshAll(ctx); err != nil {
				m.log.Debug("periodic refresh", "err", err)
			}
		}
	}
}

func (m *Manager) heartbeatLoop(ctx context.Context) {
	// 24h cadence, drift-resistant: aligned to first tick + 24h.
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.log.Info("heartbeat", "providers", len(m.providers))
		}
	}
}
