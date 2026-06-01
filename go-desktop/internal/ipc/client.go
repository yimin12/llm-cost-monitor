package ipc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"time"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/config"
)

// Client dials the daemon's Unix socket. Caller-friendly: small Send method
// and a WaitForReady helper for the "started the daemon, now wait until it
// answers" pattern.
type Client struct {
	socket string
}

func NewClient() *Client { return &Client{socket: config.SocketPath()} }

// Send issues a single command/args round-trip. Returns the decoded data
// blob on success, or an error.
func (c *Client) Send(ctx context.Context, cmd string, args map[string]any) (any, error) {
	d := net.Dialer{Timeout: 5 * time.Second}
	conn, err := d.DialContext(ctx, "unix", c.socket)
	if err != nil {
		return nil, fmt.Errorf("dial daemon: %w", err)
	}
	defer conn.Close()
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(30 * time.Second)
	}
	_ = conn.SetDeadline(deadline)

	if err := json.NewEncoder(conn).Encode(Request{Command: cmd, Args: args}); err != nil {
		return nil, err
	}
	var resp Response
	if err := json.NewDecoder(conn).Decode(&resp); err != nil {
		return nil, err
	}
	if !resp.OK {
		return nil, errors.New(resp.Error)
	}
	return resp.Data, nil
}

// WaitForReady polls /healthz-equivalent ("version" command) until the
// daemon answers or ctx is done. Used by `daemon start` to block until
// the spawned daemon has actually wired up its IPC handlers.
func (c *Client) WaitForReady(ctx context.Context) error {
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	for {
		if _, err := c.Send(ctx, "version", nil); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}
