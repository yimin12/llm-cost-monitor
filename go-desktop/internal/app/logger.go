package app

import (
	"log/slog"
	"os"
	"path/filepath"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/config"
)

// newLogger — slog JSON to stderr by default. The daemon-foreground path
// duplicates to ~/.lcmbar/logs/lcmbar.log (T10 will add lumberjack rotation;
// for now we write straight to a non-rotating file when the env var is set).
func newLogger() *slog.Logger {
	level := slog.LevelInfo
	if os.Getenv("LCMBAR_DEBUG") == "1" {
		level = slog.LevelDebug
	}
	logFile := filepath.Join(config.LogDir(), "lcmbar.log")
	if f, err := os.OpenFile(logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
		// Two-handler fan-out via stdHandler tee — simplest is to log only
		// to file when the daemon runs detached and to stderr when in
		// foreground. We pick file as the durable target; foreground mode
		// can re-open stderr by setting LCMBAR_LOG_STDERR=1.
		if os.Getenv("LCMBAR_LOG_STDERR") == "1" {
			return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
		}
		return slog.New(slog.NewJSONHandler(f, &slog.HandlerOptions{Level: level}))
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
}
