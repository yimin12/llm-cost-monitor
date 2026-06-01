// Package ipc holds the JSON wire format shared between daemon and CLI.
//
// One request per connection: client writes a single JSON object, server
// writes a single JSON response, both close. Plain TCP-style framing on a
// Unix socket is enough — the IPC traffic is local-only and low-volume.
package ipc

// Request shape: {"command": "...", "args": {...}}.
type Request struct {
	Command string         `json:"command"`
	Args    map[string]any `json:"args,omitempty"`
}

// Response — one of (ok=true, data) or (ok=false, error).
type Response struct {
	OK    bool   `json:"ok"`
	Data  any    `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}
