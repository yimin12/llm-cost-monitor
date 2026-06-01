package sdk

import "time"

// AuthSnapshot — the SCRUBBED auth shape a plugin receives. Mirrors
// auth.AuthSnapshot in the daemon.
//
// Plugins NEVER receive the access token, refresh token, or ID token. If a
// plugin needs to call an authenticated API, it must do so via the daemon's
// IPC client (see daemon_client.go) which proxies the call from inside the
// daemon process.
type AuthSnapshot struct {
	Authenticated bool      `json:"authenticated"`
	Email         string    `json:"email,omitempty"`
	ExpiresAt     time.Time `json:"expires_at,omitempty"`
}
