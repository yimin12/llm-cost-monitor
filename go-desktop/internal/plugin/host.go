// Package plugin is the daemon-side host for out-of-process plugins.
//
// T9 status: types and lifecycle hooks are stable; the gRPC dispatch and
// HashiCorp go-plugin wiring land in the T9 follow-up. We define the host
// interface NOW so the daemon, CLI, and GUI can talk to a real type rather
// than dummy maps.
package plugin

import (
	"context"
	"errors"
	"sync"
)

// Descriptor — what the daemon knows about an installed plugin.
type Descriptor struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Version    string `json:"version"`
	Path       string `json:"path"`
	Status     string `json:"status"` // "running" | "stopped" | "errored"
	StatusInfo string `json:"statusInfo,omitempty"`
}

// Host manages plugin lifecycle. Real impl will spawn each plugin under
// HashiCorp go-plugin, monitor health, and sweep orphans. The interface
// here is what the rest of the daemon needs — kept minimal so it's testable.
type Host interface {
	List() []Descriptor
	Start(ctx context.Context, id string) error
	Stop(ctx context.Context, id string) error
	Reload(ctx context.Context) error
}

// NoopHost — placeholder used until the real host lands. Returns an empty
// list and "not implemented" for any mutation. Keeps the daemon boot path
// from branching on `if pluginsEnabled`.
type NoopHost struct {
	mu sync.RWMutex
}

func NewNoopHost() *NoopHost { return &NoopHost{} }

func (h *NoopHost) List() []Descriptor                          { return nil }
func (h *NoopHost) Start(context.Context, string) error         { return errNotImplemented }
func (h *NoopHost) Stop(context.Context, string) error          { return errNotImplemented }
func (h *NoopHost) Reload(context.Context) error                { return nil }
func (h *NoopHost) SweepOrphans(context.Context) (int, error)   { return 0, nil }

var errNotImplemented = errors.New("plugin: host not implemented yet (T9)")
