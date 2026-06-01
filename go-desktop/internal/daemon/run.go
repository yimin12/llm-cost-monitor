package daemon

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/app"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/auth"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/config"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/ipc"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/provider"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/provider/builtin"
)

// RunForeground takes the lock, opens the IPC socket, registers core
// handlers, starts auto-refresh, and blocks until SIGTERM/SIGINT.
//
// EnsureRunning + IPC `quit` use the same code path (a registered handler
// signals shutdownCh).
func RunForeground(ctx context.Context) error {
	a, err := app.Get()
	if err != nil {
		return fmt.Errorf("init app: %w", err)
	}

	lockFile, err := AcquireLock()
	if err != nil {
		return err
	}
	defer func() {
		_ = lockFile.Close()
		CleanupRuntimeFiles()
	}()

	registerBuiltins(a)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	srv := NewIPCServer(a.Log)
	registerCoreHandlers(srv, a, cancel)
	registerAuthHandlers(srv, a)

	// Auto-refresh ticker. Cancelled when ctx is cancelled.
	stopRefresh := a.Manager.StartAutoRefresh(ctx,
		time.Duration(a.Cfg.AppSettings().RefreshIntervalSec)*time.Second,
	)
	a.RegisterShutdownHook(func(context.Context) error { stopRefresh(); return nil })

	// Signal trap.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		s := <-sigCh
		a.Log.Info("signal received", "sig", s.String())
		cancel()
	}()

	a.Log.Info("daemon foreground", "pid", os.Getpid(), "socket", config.SocketPath())
	if err := srv.Listen(ctx); err != nil && !errors.Is(err, net.ErrClosed) {
		return err
	}
	shutdownCtx, cancelSh := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelSh()
	return a.Shutdown(shutdownCtx)
}

func registerAuthHandlers(srv *IPCServer, a *app.App) {
	if a.Auth == nil {
		return
	}
	srv.Register("auth-login", auth.LoginHandler(a.Auth))
	srv.Register("auth-status", auth.StatusHandler(a.Auth))
	srv.Register("auth-logout", auth.LogoutHandler(a.Auth))
}

func registerBuiltins(a *app.App) {
	cfg := a.Cfg.Underlying()

	if endpoint := cfg.GetString("providers.mockcache.endpoint"); endpoint != "" {
		vendor := cfg.GetString("providers.mockcache.vendor")
		if vendor == "" {
			vendor = "mockcache"
		}
		display := cfg.GetString("providers.mockcache.display_name")
		if display == "" {
			display = "Mock Cache"
		}
		a.Manager.Register(builtin.NewMockCacheProvider(vendor, display, provider.UnitUSD, endpoint))
	}
	if base := cfg.GetString("providers.litellm.base_url"); base != "" {
		key := cfg.GetString("providers.litellm.api_key")
		a.Manager.Register(builtin.NewLiteLLMProvider(base, key))
	}
}

// EnsureRunning is the CLI-side helper: start the daemon if it isn't
// already, then wait until its IPC answers. Idempotent.
func EnsureRunning(ctx context.Context) error {
	c := ipc.NewClient()
	if _, err := c.Send(ctx, "version", nil); err == nil {
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "daemon", "start", "--foreground")
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil
	cmd.SysProcAttr = detachAttrs()
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("spawn daemon: %w", err)
	}
	// Don't wait — the spawned daemon outlives us. We just need it ready.
	go func() { _ = cmd.Wait() }()
	waitCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return c.WaitForReady(waitCtx)
}

// IsSocketHealthy is a quick liveness probe.
func IsSocketHealthy(ctx context.Context) bool {
	c := ipc.NewClient()
	probeCtx, cancel := context.WithTimeout(ctx, 1*time.Second)
	defer cancel()
	_, err := c.Send(probeCtx, "version", nil)
	return err == nil
}
