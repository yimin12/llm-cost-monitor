// Package updater fetches a `latest.json` manifest from a configurable URL,
// compares versions, and (depending on AppSettings.AutoUpdateMode) either
// downloads + atomically replaces the binary or notifies and waits.
//
// T10 status: types and the `Check` round-trip exist; `Install` is wired
// to the safe path (download → temp file → os.Rename) but the IdP-style
// signature verification step is a TODO that the real release pipeline
// will fill in.
package updater

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type Manifest struct {
	Version string `json:"version"`
	URL     string `json:"url"` // download URL for the platform-specific binary
	SHA256  string `json:"sha256"`
}

type Client struct {
	ManifestURL    string
	CurrentVersion string
	HTTP           *http.Client
}

func New(manifestURL, current string) *Client {
	return &Client{
		ManifestURL:    manifestURL,
		CurrentVersion: current,
		HTTP:           &http.Client{Timeout: 10 * time.Second},
	}
}

type CheckResult struct {
	Current   string
	Latest    string
	Available bool
	Manifest  *Manifest
}

func (c *Client) Check(ctx context.Context) (*CheckResult, error) {
	if c.ManifestURL == "" {
		return &CheckResult{Current: c.CurrentVersion, Latest: c.CurrentVersion}, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.ManifestURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("manifest: HTTP %d", resp.StatusCode)
	}
	var m Manifest
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return nil, err
	}
	return &CheckResult{
		Current:   c.CurrentVersion,
		Latest:    m.Version,
		Available: m.Version != "" && m.Version != c.CurrentVersion,
		Manifest:  &m,
	}, nil
}

// Install — T10 follow-up: download to temp, verify SHA256, os.Rename onto
// the live binary, signal the daemon to exec itself. Stub today so we have
// the entry point on the GUI/CLI without forcing a hot-swap implementation
// in the scaffold PR.
func (c *Client) Install(_ context.Context, _ *Manifest) error {
	return fmt.Errorf("updater: install not implemented yet (T10 follow-up)")
}
