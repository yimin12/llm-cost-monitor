package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"sync"
	"time"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/config"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/ipc"
)

// HandlerFunc — server-side command implementation. Returns the data
// payload (encoded into Response.Data) or an error.
type HandlerFunc func(ctx context.Context, args map[string]any) (any, error)

// IPCServer routes incoming JSON requests to handlers. Goroutine-safe.
type IPCServer struct {
	mu       sync.RWMutex
	handlers map[string]HandlerFunc
	log      *slog.Logger
}

func NewIPCServer(log *slog.Logger) *IPCServer {
	if log == nil {
		log = slog.Default()
	}
	return &IPCServer{
		handlers: map[string]HandlerFunc{},
		log:      log,
	}
}

// Register adds (or replaces) a command handler. Safe to call after Listen
// — that's how feature areas (auth, plugin, tools) wire themselves.
func (s *IPCServer) Register(cmd string, h HandlerFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handlers[cmd] = h
}

// Listen blocks until ctx is cancelled. Caller is responsible for
// AcquireLock + cleanup; this just runs the accept loop.
func (s *IPCServer) Listen(ctx context.Context) error {
	if err := config.EnsureDirs(); err != nil {
		return err
	}
	socket := config.SocketPath()
	// Stale socket cleanup. Safe because AcquireLock already proved no
	// other daemon is alive.
	_ = os.Remove(socket)

	l, err := net.Listen("unix", socket)
	if err != nil {
		return fmt.Errorf("listen unix: %w", err)
	}
	if err := os.Chmod(socket, 0o600); err != nil {
		_ = l.Close()
		return fmt.Errorf("chmod socket: %w", err)
	}

	go func() {
		<-ctx.Done()
		_ = l.Close()
	}()

	s.log.Info("ipc listening", "socket", socket)
	for {
		conn, err := l.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			s.log.Warn("accept", "err", err)
			continue
		}
		go s.handle(ctx, conn)
	}
}

func (s *IPCServer) handle(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))

	var req ipc.Request
	if err := json.NewDecoder(conn).Decode(&req); err != nil {
		s.writeErr(conn, fmt.Errorf("decode: %w", err))
		return
	}
	s.mu.RLock()
	h, ok := s.handlers[req.Command]
	s.mu.RUnlock()
	if !ok {
		s.writeErr(conn, fmt.Errorf("unknown command %q", req.Command))
		return
	}
	data, err := h(ctx, req.Args)
	if err != nil {
		s.writeErr(conn, err)
		return
	}
	_ = json.NewEncoder(conn).Encode(ipc.Response{OK: true, Data: data})
}

func (s *IPCServer) writeErr(conn net.Conn, err error) {
	_ = json.NewEncoder(conn).Encode(ipc.Response{OK: false, Error: err.Error()})
}
