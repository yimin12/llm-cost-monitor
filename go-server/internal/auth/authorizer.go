// Package auth mirrors server/auth.ts: a Bearer-token authorizer with two
// modes — JWKS-verified (production) and insecure-noverify (local dev only).
//
// Parity with the TS implementation is deliberate. If you change the threat
// model (e.g. add audience whitelisting or accept multiple issuers) update
// both implementations or the desktop will silently break against one.
package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

const (
	// Defaults match src/shared/auth-config.ts. Centralized so the test
	// suite can override and so the config-from-env path doesn't depend on
	// any process-wide globals.
	defaultJWKSURL = "https://www.googleapis.com/oauth2/v3/certs"
)

var defaultIssuers = []string{
	"https://accounts.google.com",
	"accounts.google.com",
}

// Mode mirrors AuthorizerConfig.mode in TS.
type Mode string

const (
	ModeJWKS             Mode = "jwks"
	ModeInsecureNoVerify Mode = "insecure-noverify"
)

// Config is the static configuration the authorizer needs at startup. It is
// populated from env in production via FromEnv but tests inject directly.
type Config struct {
	Mode     Mode
	Audience string
	JWKSURL  string
	Issuers  []string
}

// FromEnv reads LCM_SERVER_AUTH and LCM_SERVER_AUDIENCE the same way
// server/auth.ts:configFromEnv does. The default mode is JWKS — caller must
// explicitly opt into insecure-noverify (the TS implementation enforces
// this; we mirror the exact semantics).
func FromEnv() Config {
	mode := ModeJWKS
	if os.Getenv("LCM_SERVER_AUTH") == string(ModeInsecureNoVerify) {
		mode = ModeInsecureNoVerify
	}
	return Config{
		Mode:     mode,
		Audience: os.Getenv("LCM_SERVER_AUDIENCE"),
	}
}

// Result is what handlers receive when they call Authorizer.Authorize. A
// nil-userId result means the request was unauthenticated (HTTP layer
// translates to 401).
type Result struct {
	UserID string // empty when unauthenticated
}

// Authorizer is the runtime contract used by the HTTP handlers.
type Authorizer interface {
	Authorize(ctx context.Context, r *http.Request) (Result, error)
}

// New constructs the authorizer for the given config. Returns an error
// when JWKS mode is requested without an audience — failing fast at boot
// is much safer than silently dropping requests at runtime.
func New(cfg Config) (Authorizer, error) {
	switch cfg.Mode {
	case ModeInsecureNoVerify:
		return &insecure{}, nil
	case ModeJWKS, "":
		if cfg.Audience == "" {
			return nil, errors.New(
				"LCM_SERVER_AUDIENCE must be set when LCM_SERVER_AUTH=jwks (the Desktop OAuth client_id)",
			)
		}
		jwksURL := cfg.JWKSURL
		if jwksURL == "" {
			jwksURL = defaultJWKSURL
		}
		issuers := cfg.Issuers
		if len(issuers) == 0 {
			issuers = defaultIssuers
		}
		// Cache JWKS for an hour. jwx's auto-refresh handles `kid` rotations.
		cache := jwk.NewCache(context.Background())
		if err := cache.Register(jwksURL, jwk.WithMinRefreshInterval(15*time.Minute)); err != nil {
			return nil, fmt.Errorf("register jwks cache: %w", err)
		}
		// Warm the cache so the first request doesn't pay JWKS fetch latency.
		// A failure here is non-fatal — runtime fetches retry — but is logged.
		_, _ = cache.Refresh(context.Background(), jwksURL)
		return &jwks{
			cache:    cache,
			jwksURL:  jwksURL,
			audience: cfg.Audience,
			issuers:  issuers,
		}, nil
	default:
		return nil, fmt.Errorf("unknown auth mode: %q", cfg.Mode)
	}
}

type jwks struct {
	cache    *jwk.Cache
	jwksURL  string
	audience string
	issuers  []string
}

func (a *jwks) Authorize(ctx context.Context, r *http.Request) (Result, error) {
	tok := bearerOf(r)
	if tok == "" {
		return Result{}, nil
	}
	set, err := a.cache.Get(ctx, a.jwksURL)
	if err != nil {
		return Result{}, fmt.Errorf("jwks: %w", err)
	}
	parsed, err := jwt.Parse([]byte(tok),
		jwt.WithKeySet(set),
		jwt.WithAudience(a.audience),
		jwt.WithValidate(true),
	)
	if err != nil {
		return Result{}, nil
	}
	// Issuer check — jwx supports a single value via WithIssuer; we accept
	// the small set Google publishes (with and without scheme), which is
	// what GOOGLE_TOKEN_ISSUERS in the TS shared config encodes.
	got := parsed.Issuer()
	ok := false
	for _, want := range a.issuers {
		if got == want {
			ok = true
			break
		}
	}
	if !ok {
		return Result{}, nil
	}
	return Result{UserID: parsed.Subject()}, nil
}

type insecure struct{}

// Authorize decodes the JWT body without verifying anything. This is the
// equivalent of server/auth.ts:insecureAuthorizer; the boot-time warning
// belongs at the call site so operators see it on every restart.
func (a *insecure) Authorize(_ context.Context, r *http.Request) (Result, error) {
	tok := bearerOf(r)
	if tok == "" {
		return Result{}, nil
	}
	parts := strings.Split(tok, ".")
	if len(parts) == 3 {
		raw, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err == nil {
			var claims struct {
				Sub   string `json:"sub"`
				Email string `json:"email"`
			}
			if json.Unmarshal(raw, &claims) == nil {
				if claims.Sub != "" {
					return Result{UserID: claims.Sub}, nil
				}
				if claims.Email != "" {
					return Result{UserID: claims.Email}, nil
				}
			}
		}
	}
	return Result{UserID: tok}, nil
}

func bearerOf(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
}
