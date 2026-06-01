package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jws"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

func TestFromEnv_DefaultsToJWKS(t *testing.T) {
	t.Setenv("LCM_SERVER_AUTH", "")
	t.Setenv("LCM_SERVER_AUDIENCE", "aud-123")
	cfg := FromEnv()
	if cfg.Mode != ModeJWKS {
		t.Fatalf("default mode = %q, want jwks", cfg.Mode)
	}
	if cfg.Audience != "aud-123" {
		t.Fatalf("audience = %q", cfg.Audience)
	}
}

func TestFromEnv_OptInInsecure(t *testing.T) {
	t.Setenv("LCM_SERVER_AUTH", "insecure-noverify")
	cfg := FromEnv()
	if cfg.Mode != ModeInsecureNoVerify {
		t.Fatalf("mode = %q, want insecure-noverify", cfg.Mode)
	}
}

func TestNew_JWKSRequiresAudience(t *testing.T) {
	if _, err := New(Config{Mode: ModeJWKS, Audience: ""}); err == nil {
		t.Fatal("expected error when audience is empty")
	}
}

func TestInsecureAuthorizer_DecodesSubject(t *testing.T) {
	a, err := New(Config{Mode: ModeInsecureNoVerify})
	if err != nil {
		t.Fatal(err)
	}
	// JWT with sub=alice, no signature verification.
	tok := unsignedJWT(t, map[string]any{"sub": "alice"})
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+tok)
	res, err := a.Authorize(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if res.UserID != "alice" {
		t.Fatalf("userID = %q, want alice", res.UserID)
	}
}

func TestInsecureAuthorizer_FallsBackToEmail(t *testing.T) {
	a, _ := New(Config{Mode: ModeInsecureNoVerify})
	tok := unsignedJWT(t, map[string]any{"email": "bob@example.com"})
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+tok)
	res, _ := a.Authorize(context.Background(), r)
	if res.UserID != "bob@example.com" {
		t.Fatalf("userID = %q, want email fallback", res.UserID)
	}
}

func TestInsecureAuthorizer_NoHeader(t *testing.T) {
	a, _ := New(Config{Mode: ModeInsecureNoVerify})
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	res, err := a.Authorize(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if res.UserID != "" {
		t.Fatalf("userID = %q, want empty (unauthenticated)", res.UserID)
	}
}

// JWKS path: stand up a local JWKS server, mint a real RS256 token signed
// by the corresponding key, and confirm the authorizer accepts it. This
// exercises the cache + verifier together — the same path production hits.
func TestJWKSAuthorizer_ValidToken(t *testing.T) {
	priv, jwks := rsaKeyPairAndJWKS(t)
	jwksSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(jwks)
	}))
	defer jwksSrv.Close()

	a, err := New(Config{
		Mode:     ModeJWKS,
		Audience: "test-audience",
		JWKSURL:  jwksSrv.URL,
		Issuers:  []string{"https://issuer.example"},
	})
	if err != nil {
		t.Fatal(err)
	}

	tok, err := jwt.NewBuilder().
		Issuer("https://issuer.example").
		Audience([]string{"test-audience"}).
		Subject("user-123").
		IssuedAt(time.Now()).
		Expiration(time.Now().Add(5 * time.Minute)).
		Build()
	if err != nil {
		t.Fatal(err)
	}
	signed, err := signWithKID(tok, priv, "k1")
	if err != nil {
		t.Fatal(err)
	}

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+string(signed))

	res, err := a.Authorize(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if res.UserID != "user-123" {
		t.Fatalf("userID = %q, want user-123", res.UserID)
	}
}

func TestJWKSAuthorizer_WrongAudienceRejected(t *testing.T) {
	priv, jwks := rsaKeyPairAndJWKS(t)
	jwksSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jwks)
	}))
	defer jwksSrv.Close()

	a, _ := New(Config{
		Mode: ModeJWKS, Audience: "expected", JWKSURL: jwksSrv.URL,
		Issuers: []string{"https://issuer.example"},
	})
	tok, _ := jwt.NewBuilder().
		Issuer("https://issuer.example").
		Audience([]string{"different-audience"}).
		Subject("user-x").
		Expiration(time.Now().Add(time.Minute)).
		Build()
	signed, _ := signWithKID(tok, priv, "k1")

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+string(signed))

	res, _ := a.Authorize(context.Background(), r)
	if res.UserID != "" {
		t.Fatalf("expected reject, got userID = %q", res.UserID)
	}
}

func TestJWKSAuthorizer_WrongIssuerRejected(t *testing.T) {
	priv, jwks := rsaKeyPairAndJWKS(t)
	jwksSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jwks)
	}))
	defer jwksSrv.Close()

	a, _ := New(Config{
		Mode: ModeJWKS, Audience: "test-audience", JWKSURL: jwksSrv.URL,
		Issuers: []string{"https://expected.example"},
	})
	tok, _ := jwt.NewBuilder().
		Issuer("https://attacker.example").
		Audience([]string{"test-audience"}).
		Subject("malicious").
		Expiration(time.Now().Add(time.Minute)).
		Build()
	signed, _ := signWithKID(tok, priv, "k1")

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+string(signed))

	res, _ := a.Authorize(context.Background(), r)
	if res.UserID != "" {
		t.Fatalf("expected reject, got userID = %q", res.UserID)
	}
}

// Helpers ─────────────────────────────────────────────────────────────────

// signWithKID signs the token with the kid header set so the JWKS lookup
// matches. Without an explicit kid, jwx falls back to "first key" which is
// fine for one-key sets but doesn't exercise rotation paths.
func signWithKID(tok jwt.Token, priv *rsa.PrivateKey, kid string) ([]byte, error) {
	hdrs := jws.NewHeaders()
	if err := hdrs.Set(jws.KeyIDKey, kid); err != nil {
		return nil, err
	}
	return jwt.Sign(tok, jwt.WithKey(jwa.RS256, priv, jws.WithProtectedHeaders(hdrs)))
}

func unsignedJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	header := `{"alg":"none","typ":"JWT"}`
	body, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	enc := func(b []byte) string {
		return base64URL(b)
	}
	return enc([]byte(header)) + "." + enc(body) + "."
}

func base64URL(b []byte) string {
	// std encoding/base64 RawURL — same shape jose emits.
	const tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	out := make([]byte, 0, (len(b)*8+5)/6)
	var buf uint32
	bits := 0
	for _, x := range b {
		buf = (buf << 8) | uint32(x)
		bits += 8
		for bits >= 6 {
			bits -= 6
			out = append(out, tbl[(buf>>bits)&0x3f])
		}
	}
	if bits > 0 {
		out = append(out, tbl[(buf<<(6-bits))&0x3f])
	}
	return string(out)
}

func rsaKeyPairAndJWKS(t *testing.T) (*rsa.PrivateKey, jwk.Set) {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := jwk.FromRaw(priv.Public())
	if err != nil {
		t.Fatal(err)
	}
	if err := pub.Set(jwk.KeyIDKey, "k1"); err != nil {
		t.Fatal(err)
	}
	if err := pub.Set(jwk.AlgorithmKey, jwa.RS256); err != nil {
		t.Fatal(err)
	}
	if err := pub.Set(jwk.KeyUsageKey, "sig"); err != nil {
		t.Fatal(err)
	}
	set := jwk.NewSet()
	if err := set.AddKey(pub); err != nil {
		t.Fatal(err)
	}
	// Sign tokens with the private key tagged "k1" so the JWKS lookup matches.
	if err := jwk.AssignKeyID(pub); err == nil {
		// ignore — we forced kid above
	}
	_ = pub
	// Caller signs the JWT below; tag the priv key with kid via the wrapper.
	return priv, set
}
