package provider

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

type fakeProvider struct {
	id            string
	calls         atomic.Int32
	failTimes     int32
	notConfigured bool
	snap          UsageSnapshot
}

func (f *fakeProvider) Info() ProviderInfo { return ProviderInfo{ID: f.id, DisplayName: f.id, Unit: UnitUSD} }
func (f *fakeProvider) IsConfigured() bool { return !f.notConfigured }
func (f *fakeProvider) FetchUsage(ctx context.Context) (UsageSnapshot, error) {
	n := f.calls.Add(1)
	if n <= f.failTimes {
		return UsageSnapshot{}, errors.New("transient")
	}
	return f.snap, nil
}

type fixedBudget map[string]float64

func (b fixedBudget) BudgetUSDFor(id string) (float64, bool) {
	v, ok := b[id]
	return v, ok
}

func TestRefreshAll_ConcurrentAndPartialFailureTolerant(t *testing.T) {
	store := NewStore()
	mgr := NewManager(store, fixedBudget{"a": 100, "b": 50}, nil)
	mgr.SetRetryPolicy(RetryPolicy{Attempts: 1})

	a := &fakeProvider{id: "a", snap: UsageSnapshot{SpendUSD: 42.5, FetchedAt: time.Unix(1, 0)}}
	b := &fakeProvider{id: "b", failTimes: 99} // will always fail
	mgr.Register(a)
	mgr.Register(b)

	if err := mgr.RefreshAll(context.Background()); err != nil {
		t.Fatalf("RefreshAll partial-failure should be tolerated, got: %v", err)
	}

	got, ok := store.Get("a")
	if !ok || got.SpendUSD != 42.5 {
		t.Fatalf("a snapshot missing or wrong: %+v", got)
	}
	if got.UsagePercent != 42.5 {
		t.Fatalf("budget overlay not applied: percent=%v", got.UsagePercent)
	}
	bSnap, ok := store.Get("b")
	if !ok || bSnap.ErrorMessage == "" {
		t.Fatalf("b should have an error snapshot, got: %+v", bSnap)
	}
}

func TestRetry_BackoffAndEventualSuccess(t *testing.T) {
	store := NewStore()
	mgr := NewManager(store, nil, nil)
	mgr.SetRetryPolicy(RetryPolicy{Attempts: 3, Base: 1 * time.Millisecond, Max: 4 * time.Millisecond})
	p := &fakeProvider{id: "p", failTimes: 2, snap: UsageSnapshot{SpendUSD: 7}}
	mgr.Register(p)
	if err := mgr.RefreshOne(context.Background(), "p"); err != nil {
		t.Fatalf("expected success after retries: %v", err)
	}
	got, _ := store.Get("p")
	if got.SpendUSD != 7 {
		t.Fatalf("want 7, got %v", got.SpendUSD)
	}
}

func TestStaleOnError_RetainsPriorGood(t *testing.T) {
	store := NewStore()
	mgr := NewManager(store, nil, nil)
	mgr.SetRetryPolicy(RetryPolicy{Attempts: 1})

	// First, succeed with $42.
	p := &fakeProvider{id: "p", snap: UsageSnapshot{SpendUSD: 42, FetchedAt: time.Unix(100, 0)}}
	mgr.Register(p)
	if err := mgr.RefreshOne(context.Background(), "p"); err != nil {
		t.Fatal(err)
	}
	// Now make it always fail and refresh again.
	p.failTimes = 999
	_ = mgr.RefreshOne(context.Background(), "p")

	got, _ := store.Get("p")
	if got.SpendUSD != 42 {
		t.Fatalf("stale-on-error retention failed: spend=%v", got.SpendUSD)
	}
	if got.ErrorMessage == "" {
		t.Fatalf("error should be surfaced, got empty")
	}
	if !got.StaleOnError {
		t.Fatalf("StaleOnError flag should be set")
	}
}

func TestNotConfigured_SilentlySkipped(t *testing.T) {
	store := NewStore()
	mgr := NewManager(store, nil, nil)
	mgr.Register(&fakeProvider{id: "p", notConfigured: true})
	if err := mgr.RefreshAll(context.Background()); err != nil {
		t.Fatalf("not-configured providers should not surface as failure: %v", err)
	}
	if _, ok := store.Get("p"); ok {
		t.Fatalf("not-configured provider should not produce a snapshot")
	}
}

func TestBudgetNotifier_FiresOnceAcrossThreshold(t *testing.T) {
	var fired atomic.Int32
	bn := NewBudgetNotifier(80, func(UsageSnapshot) { fired.Add(1) }, nil)
	bn.OnSnapshot(UsageSnapshot{ProviderID: "x", BudgetUSD: 100, UsagePercent: 50})
	if fired.Load() != 0 {
		t.Fatalf("should not fire below threshold")
	}
	bn.OnSnapshot(UsageSnapshot{ProviderID: "x", BudgetUSD: 100, UsagePercent: 90})
	bn.OnSnapshot(UsageSnapshot{ProviderID: "x", BudgetUSD: 100, UsagePercent: 95})
	if fired.Load() != 1 {
		t.Fatalf("should fire exactly once on threshold cross, got %d", fired.Load())
	}
	// Drop below, cross again — should re-fire.
	bn.OnSnapshot(UsageSnapshot{ProviderID: "x", BudgetUSD: 100, UsagePercent: 50})
	bn.OnSnapshot(UsageSnapshot{ProviderID: "x", BudgetUSD: 100, UsagePercent: 90})
	if fired.Load() != 2 {
		t.Fatalf("should re-fire after dipping below threshold, got %d", fired.Load())
	}
}
