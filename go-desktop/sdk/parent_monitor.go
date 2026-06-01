package sdk

import (
	"os"
	"time"
)

// MonitorParent polls os.Getppid every 2s and exits when the parent (the
// daemon) dies. Without this, plugins linger as launchd orphans on macOS
// after an unclean daemon crash. This is the same pattern AIBar uses.
//
// Plugin main() should call:
//
//	go sdk.MonitorParent()
//
// Tests can override the interval via the optional argument.
func MonitorParent(opts ...time.Duration) {
	d := 2 * time.Second
	if len(opts) > 0 && opts[0] > 0 {
		d = opts[0]
	}
	startPPID := os.Getppid()
	for {
		time.Sleep(d)
		ppid := os.Getppid()
		// On Unix, parent dying re-parents to PID 1 (or to launchd on macOS).
		if ppid == 1 || ppid != startPPID {
			os.Exit(0)
		}
	}
}
