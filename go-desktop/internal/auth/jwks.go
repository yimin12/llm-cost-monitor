package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jws"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/config"
)

// JWKSCache — JWKS fetch + 1h in-memory TTL + on-disk fallback at
// ~/.lcmbar/jwks-cache.json. Mirrors AIBar's docs/AUTHENTICATION.md format:
// the file holds the raw JWK set plus a fetched_at stamp keyed by JWKS URI.
//
// On `kid` miss we eagerly re-fetch (rotated key); the disk copy is what
// keeps offline starts working when the IdP is briefly unreachable.
type JWKSCache struct {
	mu       sync.RWMutex
	ttl      time.Duration
	entries  map[string]*jwksEntry // jwks_uri -> entry
	diskPath string
}

type jwksEntry struct {
	URI       string          `json:"uri"`
	Set       jwk.Set         `json:"-"`
	Raw       json.RawMessage `json:"raw"`
	FetchedAt time.Time       `json:"fetched_at"`
}

func NewJWKSCache() *JWKSCache {
	c := &JWKSCache{
		ttl:      time.Hour,
		entries:  map[string]*jwksEntry{},
		diskPath: filepath.Join(config.ConfigDir(), "jwks-cache.json"),
	}
	c.loadFromDisk()
	return c
}

// Verify parses + validates rawJWT against the keys at jwksURI. On `kid` miss
// the cache is force-refreshed once before reporting an error.
func (c *JWKSCache) Verify(ctx context.Context, jwksURI, rawJWT string) error {
	set, err := c.get(ctx, jwksURI, false)
	if err != nil {
		return err
	}
	if _, err := jws.Verify([]byte(rawJWT), jws.WithKeySet(set)); err != nil {
		// Key rotation: re-fetch once.
		set2, err2 := c.get(ctx, jwksURI, true)
		if err2 != nil {
			return fmt.Errorf("jwks verify (after refresh): %w", err2)
		}
		if _, err3 := jws.Verify([]byte(rawJWT), jws.WithKeySet(set2)); err3 != nil {
			return fmt.Errorf("jwks verify: %w", err3)
		}
	}
	return nil
}

func (c *JWKSCache) get(ctx context.Context, uri string, force bool) (jwk.Set, error) {
	c.mu.RLock()
	e, ok := c.entries[uri]
	c.mu.RUnlock()
	if ok && !force && time.Since(e.FetchedAt) < c.ttl {
		return e.Set, nil
	}
	set, raw, err := fetchJWKS(ctx, uri)
	if err != nil {
		// Fall back to whatever we had. Better stale than no-auth.
		if ok {
			return e.Set, nil
		}
		return nil, err
	}
	c.mu.Lock()
	c.entries[uri] = &jwksEntry{URI: uri, Set: set, Raw: raw, FetchedAt: time.Now()}
	c.persistToDisk()
	c.mu.Unlock()
	return set, nil
}

func fetchJWKS(ctx context.Context, uri string) (jwk.Set, json.RawMessage, error) {
	set, err := jwk.Fetch(ctx, uri)
	if err != nil {
		return nil, nil, err
	}
	raw, err := json.Marshal(set)
	if err != nil {
		return nil, nil, err
	}
	return set, raw, nil
}

// persistToDisk — caller holds write lock.
func (c *JWKSCache) persistToDisk() {
	tmp := struct {
		Entries map[string]*jwksEntry `json:"entries"`
	}{Entries: c.entries}
	b, err := json.MarshalIndent(tmp, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(c.diskPath), 0o700)
	_ = os.WriteFile(c.diskPath, b, 0o600)
}

func (c *JWKSCache) loadFromDisk() {
	b, err := os.ReadFile(c.diskPath)
	if err != nil {
		return
	}
	var on struct {
		Entries map[string]*jwksEntry `json:"entries"`
	}
	if err := json.Unmarshal(b, &on); err != nil {
		return
	}
	for uri, e := range on.Entries {
		set, err := jwk.Parse(e.Raw)
		if err != nil {
			continue
		}
		e.Set = set
		c.entries[uri] = e
	}
}

// errEmptyKid is what callers can match if they want to distinguish a
// rotated/missing-kid failure from a corrupted JWS.
var errEmptyKid = errors.New("jws: kid not present in cached JWKS")
