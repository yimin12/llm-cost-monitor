// Package cli builds the Cobra command tree.
//
// The GUI binary calls SetGUIRunner(launchGUI) before Execute() so the
// `lcmbar gui` subcommand is wired only in the GUI build. The CLI-only
// build provides a stub that errors out, keeping the command surface
// uniform across builds.
package cli

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/version"
)

var guiRunner = func() error {
	return fmt.Errorf("gui runner not set (cli-only build)")
}

func SetGUIRunner(fn func() error) { guiRunner = fn }

func newRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:           "lcmbar",
		Short:         "llm-cost-monitor desktop daemon + CLI",
		Long:          "lcmbar — Go reimplementation of the llm-cost-monitor desktop. Runs as a tray-resident daemon; this CLI talks to it over a Unix socket.",
		SilenceErrors: true,
		SilenceUsage:  true,
		Version:       version.Version,
	}
	root.AddCommand(newDaemonCmd())
	root.AddCommand(newStatusCmd())
	root.AddCommand(newRefreshCmd())
	root.AddCommand(newAuthCmd())
	root.AddCommand(newConfigCmd())
	root.AddCommand(newVersionCmd())
	root.AddCommand(newGuiCmd())
	return root
}

func Execute() {
	if err := newRootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func newGuiCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "gui",
		Short: "Launch the tray + dashboard GUI (full build only)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return guiRunner()
		},
	}
}

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print version information",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Printf("lcmbar %s (%s)\n", version.Version, version.Commit)
		},
	}
}
