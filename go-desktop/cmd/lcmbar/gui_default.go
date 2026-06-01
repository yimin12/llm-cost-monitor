//go:build !nogui

package main

import (
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/ui"
)

// launchGUI is the GUI build's runner. The nogui build replaces this with a
// stub that prints a "GUI not available in this build" message, so the same
// `lcmbar gui` subcommand exists in both binaries (with degraded behaviour
// on the CLI-only build).
func launchGUI() error {
	return ui.Run()
}
