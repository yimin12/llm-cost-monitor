package builtin

import (
	"context"
	"io"
	"net/http"
)

// doGetWithBearer is the explicit-Bearer escape hatch for providers that
// use a long-lived API key instead of the OIDC access token. Bypasses the
// trusted-host allowlist (because the *operator* configured the URL +
// matching key — they own the trust decision for that pair).
func doGetWithBearer(ctx context.Context, target, bearer string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, 0, err
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
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
