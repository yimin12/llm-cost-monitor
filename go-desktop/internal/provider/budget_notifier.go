package provider

import (
	"log/slog"
	"sync"
)

// BudgetNotifier — fires once per (provider × threshold-crossing) when a
// snapshot's UsagePercent crosses the configured warning percent. Dedup
// state lives in a map; we don't re-fire while still over threshold.
type BudgetNotifier struct {
	mu        sync.Mutex
	threshold int
	notified  map[string]bool
	emit      func(snap UsageSnapshot)
	log       *slog.Logger
}

func NewBudgetNotifier(threshold int, emit func(UsageSnapshot), log *slog.Logger) *BudgetNotifier {
	if log == nil {
		log = slog.Default()
	}
	return &BudgetNotifier{
		threshold: threshold,
		notified:  map[string]bool{},
		emit:      emit,
		log:       log,
	}
}

// OnSnapshot — wire as a Store.OnUpdate listener.
func (b *BudgetNotifier) OnSnapshot(snap UsageSnapshot) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if snap.BudgetUSD <= 0 || b.threshold <= 0 {
		return
	}
	above := snap.UsagePercent >= float64(b.threshold)
	already := b.notified[snap.ProviderID]
	if above && !already {
		b.notified[snap.ProviderID] = true
		if b.emit != nil {
			b.emit(snap)
		}
		b.log.Info("budget threshold crossed",
			"provider", snap.ProviderID,
			"percent", snap.UsagePercent,
			"limit_usd", snap.BudgetUSD)
	} else if !above && already {
		delete(b.notified, snap.ProviderID)
	}
}
