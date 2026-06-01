package provider

import (
	"sort"
	"sync"
	"time"
)

// Store is the in-process snapshot of every provider's last known usage.
// Reads (UI, CLI status, web API) are common; writes are bursty (one per
// refresh cycle). RWMutex is the right shape.
//
// Listeners are notified synchronously while the lock is held to keep the
// "snapshot delivered to listener" total order well-defined. Listeners are
// expected to do trivial work (fan out to a channel) — see ui/services.
type Store struct {
	mu        sync.RWMutex
	snapshots map[string]UsageSnapshot
	listeners []func(UsageSnapshot)
}

func NewStore() *Store {
	return &Store{snapshots: make(map[string]UsageSnapshot)}
}

func (s *Store) Set(snap UsageSnapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	snap.LastUpdatedAt = time.Now()
	s.snapshots[snap.ProviderID] = snap
	for _, l := range s.listeners {
		l(snap)
	}
}

func (s *Store) Get(id string) (UsageSnapshot, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	snap, ok := s.snapshots[id]
	return snap, ok
}

// All returns the snapshots ordered by ProviderID for stable UI rendering.
// Returns a copy so callers can iterate without holding the lock.
func (s *Store) All() []UsageSnapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]UsageSnapshot, 0, len(s.snapshots))
	for _, v := range s.snapshots {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ProviderID < out[j].ProviderID })
	return out
}

// TotalSpendUSD sums every healthy USD-denominated provider's SpendUSD.
// Credit-denominated providers are excluded — adding USD and credits is
// nonsense, and the UI already segments them.
func (s *Store) TotalSpendUSD() float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var total float64
	for _, v := range s.snapshots {
		if v.Unit == UnitUSD && v.Healthy() {
			total += v.SpendUSD
		}
	}
	return total
}

// SpendByUnit returns SpendUSD per Unit. Useful for the tray label since the
// menubar only has space for one number.
func (s *Store) SpendByUnit() map[Unit]float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[Unit]float64{}
	for _, v := range s.snapshots {
		if !v.Healthy() {
			continue
		}
		out[v.Unit] += v.SpendUSD
	}
	return out
}

// LastUpdatedAt — most recent write across any provider.
func (s *Store) LastUpdatedAt() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var newest time.Time
	for _, v := range s.snapshots {
		if v.LastUpdatedAt.After(newest) {
			newest = v.LastUpdatedAt
		}
	}
	return newest
}

// OnUpdate registers a listener invoked on every Set. The returned function
// unregisters. Listeners run under the write lock — keep them O(1).
func (s *Store) OnUpdate(fn func(UsageSnapshot)) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listeners = append(s.listeners, fn)
	idx := len(s.listeners) - 1
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if idx < len(s.listeners) {
			s.listeners[idx] = nil
		}
	}
}
