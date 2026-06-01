package sdk

import (
	"context"
	"errors"
)

// DaemonClient — what a plugin uses to make authenticated calls THROUGH the
// daemon. The daemon attaches the Bearer token; the plugin sees only the
// upstream response. This is the safe alternative to handing the token to
// the plugin.
//
// T9 placeholder: real impl dials the daemon's IPC socket and routes via a
// "plugin-proxy-get" command that the daemon registers.
type DaemonClient interface {
	// Get — issues a daemon-side authenticated GET to `target`. The daemon
	// performs the trusted-host check before attaching the Bearer token.
	Get(ctx context.Context, target string) ([]byte, int, error)
}

func NewDaemonClient() DaemonClient { return &noopDaemonClient{} }

type noopDaemonClient struct{}

func (noopDaemonClient) Get(context.Context, string) ([]byte, int, error) {
	return nil, 0, errors.New("sdk: daemon proxy not implemented yet (T9)")
}
