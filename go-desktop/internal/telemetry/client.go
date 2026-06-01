// Package telemetry is the fire-and-forget event emitter for daemon-side
// metrics. Events go to a configurable HTTPS endpoint; if no endpoint is
// configured, Track is a no-op (so unconfigured hosts emit nothing).
//
// Privacy contract:
//   - No PII beyond a UUID in `telemetry_user_id` (kept in config).
//   - No access tokens, refresh tokens, or email addresses.
//   - Best-effort: Track must NEVER block the caller.
package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// Event — what gets sent. Properties are arbitrary JSON-encodable values.
type Event struct {
	Name       string         `json:"event"`
	Properties map[string]any `json:"properties,omitempty"`
	UserID     string         `json:"user_id,omitempty"`
	Timestamp  time.Time      `json:"ts"`
}

type Client struct {
	Endpoint string
	UserID   string
	HTTP     *http.Client
}

func New(endpoint, userID string) *Client {
	return &Client{
		Endpoint: endpoint,
		UserID:   userID,
		HTTP:     &http.Client{Timeout: 5 * time.Second},
	}
}

// Track fires the event in a background goroutine. Errors are swallowed —
// telemetry must never break the caller.
func (c *Client) Track(name string, props map[string]any) {
	if c == nil || c.Endpoint == "" {
		return
	}
	ev := Event{
		Name:       name,
		Properties: props,
		UserID:     c.UserID,
		Timestamp:  time.Now().UTC(),
	}
	go c.send(ev)
}

func (c *Client) send(ev Event) {
	body, err := json.Marshal(ev)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Endpoint, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
}
