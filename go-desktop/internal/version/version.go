// Package version exposes build-time identity. Values are filled by the
// linker via -ldflags "-X .../version.Version=...".
package version

var (
	Version = "dev"
	Commit  = ""
	Date    = ""
)
