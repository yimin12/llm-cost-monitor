package app

import "os"

// isHeadless — true when running on a CI runner / server that has no OS
// keyring. Toggle by exporting LCMBAR_HEADLESS=1 before starting the daemon.
func isHeadless() bool {
	v := os.Getenv("LCMBAR_HEADLESS")
	return v == "1" || v == "true"
}
