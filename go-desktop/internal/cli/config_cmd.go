package cli

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/config"
)

func newConfigCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Read / write user configuration",
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "path",
		Short: "Print the resolved config file path",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Fprintln(os.Stdout, config.ConfigFile())
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "get [key]",
		Short: "Read a dotted-path key (e.g. app.refresh_interval_sec)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.New()
			if err != nil {
				return err
			}
			v := cfg.Underlying().Get(args[0])
			fmt.Fprintln(os.Stdout, v)
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "set [key] [value]",
		Short: "Set a dotted-path key and persist to disk",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.New()
			if err != nil {
				return err
			}
			// Coerce "true"/"false"/"123" — Viper reads them back as strings
			// otherwise. Numeric setting matters for refresh_interval_sec.
			value := coerce(args[1])
			return cfg.SetSetting(args[0], value)
		},
	})
	return cmd
}

func coerce(s string) any {
	switch strings.ToLower(s) {
	case "true":
		return true
	case "false":
		return false
	}
	// number?
	var n int
	if _, err := fmt.Sscanf(s, "%d", &n); err == nil {
		return n
	}
	return s
}
