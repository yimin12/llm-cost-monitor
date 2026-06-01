// Package logging owns daemon-process logging. Today it provides a small
// configuration helper that returns a slog.Handler writing to a rotating
// file plus optional stderr.
//
// Rotation policy mirrors AIBar: 5 MB per file, 3 backups. We don't pull
// in lumberjack here — it's a one-import dependency we'll add in the same
// PR that wires this into app.go's newLogger(). For now, callers should
// continue using app.newLogger; this package is the seam for the next PR.
package logging

import (
	"io"
	"log/slog"
	"os"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/config"
)

// FileWriter returns the file handle that lcmbar.log should write to.
// Caller is responsible for closing and rotating. T10 follow-up swaps this
// out for *lumberjack.Logger.
func FileWriter() (io.WriteCloser, error) {
	return os.OpenFile(
		config.LogDir()+string(os.PathSeparator)+"lcmbar.log",
		os.O_CREATE|os.O_WRONLY|os.O_APPEND,
		0o600,
	)
}

// New returns a slog.Logger configured the way the daemon prefers: JSON
// output, per-record source line, level controlled by LCMBAR_DEBUG.
func New(w io.Writer) *slog.Logger {
	level := slog.LevelInfo
	if v := os.Getenv("LCMBAR_DEBUG"); v == "1" || v == "true" {
		level = slog.LevelDebug
	}
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level:     level,
		AddSource: true,
	}))
}
