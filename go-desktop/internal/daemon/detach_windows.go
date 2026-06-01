//go:build windows

package daemon

import "syscall"

func detachAttrs() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true}
}
