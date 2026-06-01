package config

import (
	"bufio"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// LoadDotenv reads ~/.lcmbar/.env (if it exists) and exports each KEY=VALUE
// into the process environment iff the variable is not already set. We deliberately
// don't override real env vars — process-supplied secrets always win over disk.
//
// Format: trivial KEY=VALUE per line, lines starting with `#` ignored, surrounding
// quotes (single or double) stripped from the value. We don't expand variables —
// dotenv files are about static secrets, not shell scripting.
func LoadDotenv() error {
	path := filepath.Join(ConfigDir(), ".env")
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		val = strings.Trim(val, `"'`)
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		_ = os.Setenv(key, val)
	}
	return sc.Err()
}
