package plugin

import "sync"

// Registry — in-memory directory of known plugins. The real version reads
// embedded YAML manifests + ~/.lcmbar/plugins/state.yaml at boot, and
// resolves min-version / deprecated / successor relationships. This stub
// keeps the API stable for the rest of the codebase.
type Registry struct {
	mu      sync.RWMutex
	entries map[string]Descriptor
}

func NewRegistry() *Registry {
	return &Registry{entries: map[string]Descriptor{}}
}

func (r *Registry) Add(d Descriptor) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries[d.ID] = d
}

func (r *Registry) Get(id string) (Descriptor, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	d, ok := r.entries[id]
	return d, ok
}

func (r *Registry) All() []Descriptor {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Descriptor, 0, len(r.entries))
	for _, d := range r.entries {
		out = append(out, d)
	}
	return out
}
