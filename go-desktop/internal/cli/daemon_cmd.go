package cli

import (
	"context"
	"fmt"
	"os"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/daemon"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/ipc"
)

func newDaemonCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "daemon",
		Short: "Manage the lcmbar background daemon",
	}
	cmd.AddCommand(newDaemonStartCmd())
	cmd.AddCommand(newDaemonStopCmd())
	cmd.AddCommand(newDaemonStatusCmd())
	cmd.AddCommand(newDaemonRestartCmd())
	return cmd
}

func newDaemonStartCmd() *cobra.Command {
	var foreground bool
	cmd := &cobra.Command{
		Use:   "start",
		Short: "Start the daemon (idempotent)",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := context.Background()
			if foreground {
				return daemon.RunForeground(ctx)
			}
			return daemon.EnsureRunning(ctx)
		},
	}
	cmd.Flags().BoolVar(&foreground, "foreground", false, "block in this process instead of spawning")
	return cmd
}

func newDaemonStopCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "stop",
		Short: "Stop the daemon (IPC quit, then SIGTERM as fallback)",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			c := ipc.NewClient()
			if _, err := c.Send(ctx, "quit", nil); err == nil {
				return nil
			}
			pid := daemon.ReadPid()
			if pid <= 0 {
				return fmt.Errorf("daemon not running (no IPC, no pid file)")
			}
			if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
				return fmt.Errorf("kill pid %d: %w", pid, err)
			}
			return nil
		},
	}
}

func newDaemonStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Print daemon health (alive / not alive)",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := context.Background()
			alive := daemon.IsSocketHealthy(ctx)
			fmt.Fprintln(os.Stdout, map[bool]string{true: "alive", false: "not running"}[alive])
			if !alive {
				os.Exit(1)
			}
			return nil
		},
	}
}

func newDaemonRestartCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "restart",
		Short: "Stop, then start",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			c := ipc.NewClient()
			_, _ = c.Send(ctx, "quit", nil)
			// Best-effort wait for the lock to release.
			time.Sleep(500 * time.Millisecond)
			return daemon.EnsureRunning(context.Background())
		},
	}
}
