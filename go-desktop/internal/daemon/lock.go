// Package daemon owns the lifecycle of the long-running lcmbar process:
// flock-based single-instance, PID file management, foreground/start/stop,
// and the Unix-socket IPC server.
package daemon

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"syscall"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/config"
)

// AcquireLock takes the exclusive flock on ~/.lcmbar/lcmbar.lock. Returns
// the open *os.File so the caller can hold it for the daemon's lifetime;
// closing the file releases the lock.
//
// If another daemon already holds the lock, returns an error containing
// the existing PID (read from lcmbar.pid for diagnostics).
func AcquireLock() (*os.File, error) {
	if err := config.EnsureDirs(); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(config.LockFile(), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open lock: %w", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		pid := readPidFile()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			if pid > 0 {
				return nil, fmt.Errorf("daemon already running (pid %d)", pid)
			}
			return nil, errors.New("daemon already running")
		}
		return nil, fmt.Errorf("flock: %w", err)
	}
	if err := writePidFile(); err != nil {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

func writePidFile() error {
	pid := os.Getpid()
	return os.WriteFile(config.PidFile(), []byte(strconv.Itoa(pid)), 0o600)
}

func readPidFile() int {
	b, err := os.ReadFile(config.PidFile())
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(string(b))
	if err != nil {
		return 0
	}
	return pid
}

// ReadPid is the public accessor used by the CLI to fall back from
// "IPC quit failed" to "send SIGTERM".
func ReadPid() int { return readPidFile() }

// CleanupRuntimeFiles removes the socket + pid file. Safe to call after
// flock release.
func CleanupRuntimeFiles() {
	_ = os.Remove(config.SocketPath())
	_ = os.Remove(config.PidFile())
}
