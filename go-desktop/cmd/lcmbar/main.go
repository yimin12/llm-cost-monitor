// Command lcmbar — GUI build (default).
//
// Mirrors AIBar's main.go: the GUI binary registers a launchGUI runner with
// the CLI package and then defers to cobra.Execute(). Build with `-tags nogui`
// to skip the Wails dependency entirely (handled by the cmd/lcmbar-cli twin).
package main

import (
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/cli"
)

func main() {
	cli.SetGUIRunner(launchGUI)
	cli.Execute()
}
