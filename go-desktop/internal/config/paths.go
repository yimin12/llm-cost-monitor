// Package config holds Viper-backed config + the canonical filesystem
// paths used across the daemon, CLI, and GUI builds.
//
// Layout under $HOME/.lcmbar (override with $LCMBAR_HOME):
//
//	config.yaml         user-editable settings + provider config
//	logs/lcmbar.log     slog JSON, rotated
//	plugins/            installed plugins
//	plugins/state.yaml  plugin registry state
//	jwks-cache.json     JWKS disk cache (T7)
//	lcmbar.sock         Unix socket for daemon IPC (T5)
//	lcmbar.pid          PID of the running daemon (T5)
//	lcmbar.lock         flock target for single-instance (T5)
package config

import (
	"os"
	"path/filepath"
)

const (
	homeEnv     = "LCMBAR_HOME"
	defaultName = ".lcmbar"
)

func ConfigDir() string {
	if explicit := os.Getenv(homeEnv); explicit != "" {
		return explicit
	}
	home, err := os.UserHomeDir()
	if err != nil {
		// Fallback to CWD; better than panicking. The dotenv loader and
		// daemon both call MkdirAll so a stale ".lcmbar" subdir is harmless.
		return filepath.Join(".", defaultName)
	}
	return filepath.Join(home, defaultName)
}

func LogDir() string     { return filepath.Join(ConfigDir(), "logs") }
func PluginDir() string  { return filepath.Join(ConfigDir(), "plugins") }
func SocketPath() string { return filepath.Join(ConfigDir(), "lcmbar.sock") }
func PidFile() string    { return filepath.Join(ConfigDir(), "lcmbar.pid") }
func LockFile() string   { return filepath.Join(ConfigDir(), "lcmbar.lock") }
func ConfigFile() string { return filepath.Join(ConfigDir(), "config.yaml") }

// EnsureDirs creates all directories the daemon needs on startup. Idempotent.
func EnsureDirs() error {
	for _, d := range []string{ConfigDir(), LogDir(), PluginDir()} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	return nil
}
