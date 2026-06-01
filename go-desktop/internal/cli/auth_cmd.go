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

func newAuthCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "auth",
		Short: "Sign in / out via OIDC (T7)",
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "login",
		Short: "Run the PKCE flow and store the session in the keyring",
		RunE:  authIPC("auth-login"),
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "status",
		Short: "Show the current sign-in state",
		RunE:  authIPC("auth-status"),
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "logout",
		Short: "Forget the stored session",
		RunE:  authIPC("auth-logout"),
	})
	return cmd
}

func authIPC(cmd string) func(*cobra.Command, []string) error {
	return func(_ *cobra.Command, _ []string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if err := daemon.EnsureRunning(ctx); err != nil {
			return err
		}
		c := ipc.NewClient()
		data, err := c.Send(ctx, cmd, nil)
		if err != nil {
			return fmt.Errorf("%s: %w", cmd, err)
		}
		return json.NewEncoder(os.Stdout).Encode(data)
	}
}
