package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// FlowConfig — minimal generic OIDC PKCE configuration. No client_secret
// — desktop apps are public clients (RFC 8252).
type FlowConfig struct {
	Issuer       string
	ClientID     string
	Scopes       []string // ["openid","email","profile",...]
	RedirectPort int      // 0 = pick a free port
}

// LoginResult — what the flow hands back. Caller wraps this into a Session.
type LoginResult struct {
	AccessToken  string
	RefreshToken string
	IDToken      string
	Sub          string
	Email        string
	ExpiresAt    time.Time
	Issuer       string
}

// RunLoginFlow — opens the system browser, spins a localhost listener,
// completes Authorization Code + PKCE, and returns the token bundle.
//
// Blocks until the user returns from the IdP (or ctx is done).
func RunLoginFlow(ctx context.Context, cfg FlowConfig) (*LoginResult, error) {
	if cfg.Issuer == "" || cfg.ClientID == "" {
		return nil, errors.New("issuer and client_id are required")
	}

	provider, err := oidc.NewProvider(ctx, cfg.Issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc discover: %w", err)
	}
	verifier := provider.Verifier(&oidc.Config{ClientID: cfg.ClientID})

	listener, err := openLoopbackListener(cfg.RedirectPort)
	if err != nil {
		return nil, err
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	redirectURL := fmt.Sprintf("http://127.0.0.1:%d/callback", port)

	state, err := randomURLSafe(24)
	if err != nil {
		return nil, err
	}
	codeVerifier, err := randomURLSafe(48)
	if err != nil {
		return nil, err
	}
	challenge := s256(codeVerifier)

	scopes := cfg.Scopes
	if len(scopes) == 0 {
		scopes = []string{oidc.ScopeOpenID, "email", "profile"}
	}
	oa := &oauth2.Config{
		ClientID:    cfg.ClientID,
		Endpoint:    provider.Endpoint(),
		RedirectURL: redirectURL,
		Scopes:      scopes,
	}
	authURL := oa.AuthCodeURL(state,
		oauth2.SetAuthURLParam("code_challenge", challenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
	)

	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if got := q.Get("state"); got != state {
			http.Error(w, "state mismatch", http.StatusBadRequest)
			errCh <- errors.New("state mismatch")
			return
		}
		if errParam := q.Get("error"); errParam != "" {
			http.Error(w, errParam, http.StatusBadRequest)
			errCh <- fmt.Errorf("idp error: %s", errParam)
			return
		}
		code := q.Get("code")
		if code == "" {
			http.Error(w, "missing code", http.StatusBadRequest)
			errCh <- errors.New("missing code")
			return
		}
		_, _ = w.Write([]byte("<html><body><h2>Sign-in complete.</h2><p>You can close this window.</p></body></html>"))
		codeCh <- code
	})
	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() { _ = srv.Serve(listener) }()
	defer func() {
		shCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shCtx)
	}()

	if err := openBrowser(authURL); err != nil {
		fmt.Printf("Open this URL in your browser to sign in:\n%s\n", authURL)
	}

	var code string
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case e := <-errCh:
		return nil, e
	case code = <-codeCh:
	}

	tok, err := oa.Exchange(ctx, code, oauth2.SetAuthURLParam("code_verifier", codeVerifier))
	if err != nil {
		return nil, fmt.Errorf("token exchange: %w", err)
	}
	rawID, _ := tok.Extra("id_token").(string)
	idTok, err := verifier.Verify(ctx, rawID)
	if err != nil {
		return nil, fmt.Errorf("verify id_token: %w", err)
	}
	var claims struct {
		Sub   string `json:"sub"`
		Email string `json:"email"`
	}
	if err := idTok.Claims(&claims); err != nil {
		return nil, err
	}

	res := &LoginResult{
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		IDToken:      rawID,
		Sub:          claims.Sub,
		Email:        claims.Email,
		ExpiresAt:    tok.Expiry,
		Issuer:       cfg.Issuer,
	}
	return res, nil
}

func openLoopbackListener(port int) (net.Listener, error) {
	addr := "127.0.0.1:" + strconv.Itoa(port)
	return net.Listen("tcp", addr)
}

func randomURLSafe(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func s256(verifier string) string {
	h := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

func openBrowser(target string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", target).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", target).Start()
	default:
		return exec.Command("xdg-open", target).Start()
	}
}

// Compile-time assertions: keep imports honest.
var (
	_ = json.Marshal
	_ = url.Parse
	_ = strings.TrimSpace
)
