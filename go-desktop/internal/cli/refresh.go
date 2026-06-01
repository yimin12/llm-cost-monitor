package cli

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/daemon"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/ipc"
)

func newRefreshCmd() *cobra.Command {
	var only string
	cmd := &cobra.Command{
		Use:   "refresh",
		Short: "Trigger a fetch from every (or one) provider",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := daemon.EnsureRunning(ctx); err != nil {
				return err
			}
			c := ipc.NewClient()
			args2 := map[string]any{}
			if only != "" {
				args2["provider"] = only
			}
			if _, err := c.Send(ctx, "refresh", args2); err != nil {
				return err
			}
			fmt.Fprintln(os.Stdout, "refresh requested")
			return nil
		},
	}
	cmd.Flags().StringVar(&only, "provider", "", "refresh a single provider id")
	return cmd
}
