// Command lcmbar-cli — pure-CLI build with no GUI dependencies.
//
// Always builds with -tags nogui so the Wails/runtime UI imports are stripped.
// Useful for headless/server installs that only need the daemon and CLI.
package main

import (
	"fmt"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/cli"
)

func main() {
	cli.SetGUIRunner(func() error {
		return fmt.Errorf("gui not available in lcmbar-cli (use the full lcmbar binary)")
	})
	cli.Execute()
}
