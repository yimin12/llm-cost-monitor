// Command server is the Go port of server/index.ts. It is wire-compatible
// with the TS implementation: same DSN env, same migrations directory, same
// HTTP routes. Operators can swap one for the other without client changes.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/yimin12/llm-cost-monitor/go-server/internal/auth"
	"github.com/yimin12/llm-cost-monitor/go-server/internal/db"
	"github.com/yimin12/llm-cost-monitor/go-server/internal/httpapi"
	"github.com/yimin12/llm-cost-monitor/go-server/internal/team"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "[server] fatal: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	port := envInt("LCM_SERVER_PORT", 4017)
	bind := envStr("LCM_SERVER_BIND", "127.0.0.1")
	migrationsDir := envStr("LCM_SERVER_MIGRATIONS_DIR", defaultMigrationsDir())

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	pool, err := db.Open(ctx, "")
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer pool.Close()

	status, err := db.RunMigrations(ctx, pool, migrationsDir)
	if err != nil {
		return fmt.Errorf("migrations: %w", err)
	}
	logger.Info("migrations applied",
		"version", status.AppliedVersion,
		"ranThisRun", status.RanThisRun,
	)

	authCfg := auth.FromEnv()
	if authCfg.Mode == auth.ModeInsecureNoVerify {
		logger.Warn("LCM_SERVER_AUTH=insecure-noverify — JWTs are decoded without signature verification. " +
			"Use only for local development. Production must set LCM_SERVER_AUTH=jwks and LCM_SERVER_AUDIENCE.")
	}
	authorizer, err := auth.New(authCfg)
	if err != nil {
		return fmt.Errorf("auth: %w", err)
	}

	app := &httpapi.App{
		Service:    team.NewService(pool),
		Authorizer: authorizer,
		Log:        logger,
	}

	srv := &http.Server{
		Addr:              net.JoinHostPort(bind, strconv.Itoa(port)),
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen", "err", err)
			cancel()
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}

func envStr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

// defaultMigrationsDir returns the on-disk location of server-migrations/.
// Resolved relative to the executable's directory so a single binary plus
// the migrations folder can ship together. Falls back to ../server-migrations
// (the dev layout) when running `go run ./cmd/server` from the repo root.
func defaultMigrationsDir() string {
	exe, err := os.Executable()
	if err == nil {
		candidate := filepath.Join(filepath.Dir(exe), "server-migrations")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return filepath.Join("..", "server-migrations")
}
