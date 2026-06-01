package sdk

import (
	"context"
	"sync"
	"time"
)

// Cache is the generic stale-on-error cache plugins use for upstream
// responses. It always serves the last-good value when the loader errors,
// so a transient outage doesn't blank the GUI.
//
// Goroutine-safe. T should be a value type (or a pointer the loader copies
// before returning) — Cache does not deep-copy.
type Cache[T any] struct {
	mu          sync.Mutex
	value       T
	hasValue    bool
	lastFetched time.Time
	ttl         time.Duration
}

func NewCache[T any](ttl time.Duration) *Cache[T] {
	return &Cache[T]{ttl: ttl}
}

// GetOrLoad returns the cached value if fresh; otherwise calls loader and
// stores the result. On loader error with a previously-cached value, it
// returns the stale value with err == nil — let the caller surface "stale"
// elsewhere (e.g. on the snapshot's StaleOnError flag).
func (c *Cache[T]) GetOrLoad(ctx context.Context, loader func(context.Context) (T, error)) (T, error) {
	c.mu.Lock()
	if c.hasValue && time.Since(c.lastFetched) < c.ttl {
		v := c.value
		c.mu.Unlock()
		return v, nil
	}
	c.mu.Unlock()

	v, err := loader(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		if c.hasValue {
			return c.value, nil
		}
		var zero T
		return zero, err
	}
	c.value = v
	c.hasValue = true
	c.lastFetched = time.Now()
	return v, nil
}

func (c *Cache[T]) Invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.hasValue = false
}
