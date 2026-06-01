// Package builtin holds the first-party providers shipped in-binary:
// the generic mock-cache provider (used to demo central-cache consistency)
// and the LiteLLM provider.
//
// Helpers in this file are the common HTTP plumbing every provider reuses:
//
//   - Bearer attach + retry-on-401 via TokenRefresher
//   - Trusted-host allowlist (so we never leak the access token to a
//     compromised endpoint configured by accident)
//   - Singleton TokenGetter / UserEmailGetter / TokenRefresher registries
//     that the auth package wires up at boot.
package builtin

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// TokenGetter — the auth package registers a function that returns the
// current access_token. We deliberately don't take *Session as a dependency
// to keep this package lean and circular-free.
type TokenGetter func() (token string, ok bool)
type TokenRefresher func(ctx context.Context) error
type UserEmailGetter func() (email string, ok bool)

var (
	tokenMu       sync.RWMutex
	tokenGetter   TokenGetter
	tokenRefresh  TokenRefresher
	emailGetter   UserEmailGetter
	defaultClient = &http.Client{Timeout: 30 * time.Second}
)

func SetTokenGetter(g TokenGetter)         { tokenMu.Lock(); tokenGetter = g; tokenMu.Unlock() }
func SetTokenRefresher(r TokenRefresher)   { tokenMu.Lock(); tokenRefresh = r; tokenMu.Unlock() }
func SetUserEmailGetter(g UserEmailGetter) { tokenMu.Lock(); emailGetter = g; tokenMu.Unlock() }

func currentToken() (string, bool) {
	tokenMu.RLock()
	defer tokenMu.RUnlock()
	if tokenGetter == nil {
		return "", false
	}
	return tokenGetter()
}

func forceRefreshToken(ctx context.Context) error {
	tokenMu.RLock()
	r := tokenRefresh
	tokenMu.RUnlock()
	if r == nil {
		return errors.New("no token refresher configured")
	}
	return r(ctx)
}

// CurrentEmail is exposed for the mock-cache provider, which keys data by
// authenticated user email.
func CurrentEmail() (string, bool) {
	tokenMu.RLock()
	defer tokenMu.RUnlock()
	if emailGetter == nil {
		return "", false
	}
	return emailGetter()
}

// EnvTokenGetter returns a TokenGetter that reads from the named env var.
// Useful for tests, headless servers, and the mock-cache demo.
func EnvTokenGetter(envvar string) TokenGetter {
	return func() (string, bool) {
		t := os.Getenv(envvar)
		return t, t != ""
	}
}

// IsTrustedEndpoint enforces the Bearer-attach allowlist. Defaults to the
// AIBar pattern: only attach when the host matches LCMBAR_TRUSTED_HOSTS
// (comma-separated, "*" matches anything). Localhost is always trusted.
//
// This is the firewall against a compromised endpoint stealing tokens.
func IsTrustedEndpoint(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "127.0.0.1" || host == "::1" || host == "localhost" {
		return true
	}
	allowed := os.Getenv("LCMBAR_TRUSTED_HOSTS")
	if allowed == "" {
		return false
	}
	for _, h := range strings.Split(allowed, ",") {
		h = strings.TrimSpace(h)
		if h == "*" || strings.EqualFold(h, host) {
			return true
		}
	}
	return false
}

// DoGet — GET with Bearer attach + automatic token refresh on 401.
// Returns the body and HTTP status. Caller decodes JSON.
func DoGet(ctx context.Context, target string) ([]byte, int, error) {
	body, status, err := doGetOnce(ctx, target)
	if err != nil {
		return nil, status, err
	}
	if status == http.StatusUnauthorized {
		if err := forceRefreshToken(ctx); err != nil {
			return body, status, fmt.Errorf("401 + token refresh failed: %w", err)
		}
		body, status, err = doGetOnce(ctx, target)
	}
	return body, status, err
}

func doGetOnce(ctx context.Context, target string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, 0, err
	}
	if IsTrustedEndpoint(target) {
		if tok, ok := currentToken(); ok {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
	}
	req.Header.Set("Accept", "application/json")
	resp, err := defaultClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	return body, resp.StatusCode, err
}
