//go:build nogui

package main

import "fmt"

func launchGUI() error {
	return fmt.Errorf("gui not available in this build (built with -tags nogui)")
}
