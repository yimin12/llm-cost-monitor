package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/daemon"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/ipc"
)

func newStatusCmd() *cobra.Command {
	var asJSON bool
	var only string
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Print provider status (auto-starts daemon if not running)",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := daemon.EnsureRunning(ctx); err != nil {
				return err
			}
			c := ipc.NewClient()
			data, err := c.Send(ctx, "status", nil)
			if err != nil {
				return err
			}
			rows, _ := data.([]any)
			if only != "" {
				filtered := make([]any, 0, 1)
				for _, r := range rows {
					if m, ok := r.(map[string]any); ok && m["providerId"] == only {
						filtered = append(filtered, m)
					}
				}
				rows = filtered
			}
			if asJSON {
				return json.NewEncoder(os.Stdout).Encode(rows)
			}
			printStatusTable(rows)
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "machine-readable JSON output")
	cmd.Flags().StringVar(&only, "provider", "", "filter to a single provider id")
	return cmd
}

func printStatusTable(rows []any) {
	if len(rows) == 0 {
		fmt.Fprintln(os.Stdout, "no providers configured")
		return
	}
	fmt.Fprintf(os.Stdout, "%-12s  %-6s  %12s  %12s  %6s  %s\n",
		"PROVIDER", "UNIT", "SPEND", "BUDGET", "%", "STATUS")
	for _, r := range rows {
		m, _ := r.(map[string]any)
		status := "ok"
		if msg, _ := m["error"].(string); msg != "" {
			status = "ERR: " + msg
		}
		percent, _ := m["usagePercent"].(float64)
		spend, _ := m["spendUsd"].(float64)
		budget, _ := m["budgetUsd"].(float64)
		fmt.Fprintf(os.Stdout, "%-12s  %-6s  %12.4f  %12.4f  %5.1f%%  %s\n",
			m["providerId"], m["unit"], spend, budget, percent, status)
	}
}
