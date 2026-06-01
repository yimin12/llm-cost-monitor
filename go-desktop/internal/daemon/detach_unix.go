//go:build unix

package daemon

import "syscall"

// detachAttrs — start the spawned daemon in its own process group so it
// survives the CLI's exit. On unix that's Setsid + Setpgid.
func detachAttrs() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}
