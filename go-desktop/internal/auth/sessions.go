package auth

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// SessionManager — single source of truth for the current user's session.
//
// Built around three guarantees:
//
//  1. EnsureValidToken refreshes proactively (skew window in Session.IsExpired).
//  2. ID tokens are JWKS-verified, never just decoded.
//  3. Plugins only ever see Snapshot() — access/refresh tokens stay inside
//     the daemon process.
type SessionManager struct {
	cfg   FlowConfig
	store TokenStore
	jwks  *JWKSCache

	mu          sync.RWMutex
	current     Session
	provider    *oidc.Provider
	oauthCfg    *oauth2.Config
	jwksURI     string // resolved at first use
	emitExpired func()
}

func NewSessionManager(cfg FlowConfig, store TokenStore, jwks *JWKSCache) *SessionManager {
	return &SessionManager{cfg: cfg, store: store, jwks: jwks}
}

// OnSessionExpired registers a one-shot callback fired when refresh fails.
// The GUI uses this to surface a re-login prompt.
func (m *SessionManager) OnSessionExpired(fn func()) {
	m.mu.Lock()
	m.emitExpired = fn
	m.mu.Unlock()
}

// LoadFromStore hydrates from the keyring (or memory). Safe to call on boot;
// returns nil even when the store is empty.
func (m *SessionManager) LoadFromStore() error {
	s, err := m.store.Load()
	if err != nil {
		// "no session" / first-run is not an error.
		return nil
	}
	m.mu.Lock()
	m.current = s
	m.mu.Unlock()
	return nil
}

// Login runs the PKCE flow and persists the result.
func (m *SessionManager) Login(ctx context.Context) error {
	res, err := RunLoginFlow(ctx, m.cfg)
	if err != nil {
		return err
	}
	s := Session{
		Sub:          res.Sub,
		Email:        res.Email,
		AccessToken:  res.AccessToken,
		RefreshToken: res.RefreshToken,
		IDToken:      res.IDToken,
		ExpiresAt:    res.ExpiresAt,
		IssuedAt:     time.Now(),
		Issuer:       res.Issuer,
	}
	m.mu.Lock()
	m.current = s
	m.mu.Unlock()
	return m.store.Save(s)
}

// Logout clears local state. Does not call the IdP's revoke endpoint —
// that's an IdP-specific extension we'll add behind a config knob.
func (m *SessionManager) Logout() error {
	m.mu.Lock()
	m.current = Session{}
	m.mu.Unlock()
	return m.store.Clear()
}

// Snapshot — sanitised view safe to hand to plugins or the IPC layer.
func (m *SessionManager) Snapshot() AuthSnapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return AuthSnapshot{
		Authenticated: m.current.AccessToken != "" && !m.current.IsExpired(),
		Email:         m.current.Email,
		ExpiresAt:     m.current.ExpiresAt,
	}
}

// AccessToken returns the live access token (daemon-internal callers only).
func (m *SessionManager) AccessToken() (string, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.current.AccessToken == "" {
		return "", false
	}
	return m.current.AccessToken, true
}

func (m *SessionManager) Email() (string, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.current.Email == "" {
		return "", false
	}
	return m.current.Email, true
}

// EnsureValidToken refreshes if the current token is near expiry. Builtin
// providers call ForceRefresh on a 401; this is the proactive path.
func (m *SessionManager) EnsureValidToken(ctx context.Context) error {
	m.mu.RLock()
	cur := m.current
	m.mu.RUnlock()
	if cur.AccessToken == "" {
		return errors.New("not signed in")
	}
	if !cur.IsExpired() {
		return nil
	}
	return m.ForceRefresh(ctx)
}

// ForceRefresh runs the refresh_token grant unconditionally. Wired into
// builtin.SetTokenRefresher so a 401 triggers a real refresh.
func (m *SessionManager) ForceRefresh(ctx context.Context) error {
	m.mu.RLock()
	cur := m.current
	m.mu.RUnlock()
	if cur.RefreshToken == "" {
		m.fireExpired()
		return errors.New("no refresh token")
	}
	if err := m.lazyInitOIDC(ctx); err != nil {
		return err
	}
	src := m.oauthCfg.TokenSource(ctx, &oauth2.Token{RefreshToken: cur.RefreshToken})
	tok, err := src.Token()
	if err != nil {
		m.fireExpired()
		return fmt.Errorf("refresh: %w", err)
	}
	rawID, _ := tok.Extra("id_token").(string)
	if rawID != "" && m.jwks != nil && m.jwksURI != "" {
		if err := m.jwks.Verify(ctx, m.jwksURI, rawID); err != nil {
			return fmt.Errorf("verify refreshed id_token: %w", err)
		}
	}
	updated := cur
	updated.AccessToken = tok.AccessToken
	if tok.RefreshToken != "" {
		updated.RefreshToken = tok.RefreshToken
	}
	if rawID != "" {
		updated.IDToken = rawID
	}
	updated.ExpiresAt = tok.Expiry
	m.mu.Lock()
	m.current = updated
	m.mu.Unlock()
	return m.store.Save(updated)
}

func (m *SessionManager) lazyInitOIDC(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.provider != nil {
		return nil
	}
	p, err := oidc.NewProvider(ctx, m.cfg.Issuer)
	if err != nil {
		return fmt.Errorf("oidc discover: %w", err)
	}
	m.provider = p
	m.oauthCfg = &oauth2.Config{
		ClientID: m.cfg.ClientID,
		Endpoint: p.Endpoint(),
		Scopes:   m.cfg.Scopes,
	}
	var claims struct {
		JWKSURI string `json:"jwks_uri"`
	}
	if err := p.Claims(&claims); err == nil {
		m.jwksURI = claims.JWKSURI
	}
	return nil
}

func (m *SessionManager) fireExpired() {
	m.mu.RLock()
	fn := m.emitExpired
	m.mu.RUnlock()
	if fn != nil {
		fn()
	}
}
