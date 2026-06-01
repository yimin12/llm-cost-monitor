// Package auth holds the generic OIDC PKCE client + the SessionManager.
//
// "Generic" means: issuer, client_id, scopes, redirect_port all come from
// config — no hard-coded provider. Works against Keycloak, Auth0, Okta,
// Google. The auth_user_*.go files glue providers' quirks (e.g. extra
// audience claim) on top.
package auth

import "time"

// Session — what we persist after a successful login. AccessToken and
// RefreshToken stay in the OS keyring; the rest is metadata copied for
// quick lookup without a keyring round-trip.
type Session struct {
	Sub          string    `json:"sub"`
	Email        string    `json:"email"`
	Name         string    `json:"name,omitempty"`
	AccessToken  string    `json:"-"`             // never JSON-encoded to disk
	RefreshToken string    `json:"-"`             // ditto
	IDToken      string    `json:"-"`             // ditto
	ExpiresAt    time.Time `json:"expires_at"`
	IssuedAt     time.Time `json:"issued_at"`
	Issuer       string    `json:"issuer"`
}

func (s Session) IsExpired() bool {
	return time.Now().After(s.ExpiresAt.Add(-30 * time.Second))
}

// AuthSnapshot — the scrubbed shape we hand out to plugins. The full
// session NEVER leaves the daemon process.
type AuthSnapshot struct {
	Authenticated bool      `json:"authenticated"`
	Email         string    `json:"email,omitempty"`
	ExpiresAt     time.Time `json:"expires_at,omitempty"`
}
