package config

import (
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/spf13/viper"
)

// AppSettings — the cross-cutting daemon settings. Mirrors AIBar's
// internal/provider/types.go::AppSettings so callers that read this struct
// behave identically across the rewrite boundary.
type AppSettings struct {
	RefreshIntervalSec   int    `mapstructure:"refresh_interval_sec"`
	BudgetWarningPercent int    `mapstructure:"budget_warning_percent"`
	AutoUpdateMode       string `mapstructure:"auto_update_mode"`
}

func DefaultAppSettings() AppSettings {
	return AppSettings{
		RefreshIntervalSec:   300,
		BudgetWarningPercent: 80,
		AutoUpdateMode:       "notify-then-auto",
	}
}

// Provider section: each entry under `providers.<id>` is a free-form map;
// the ProviderConfig accessor returns it as map[string]any so individual
// builtin/extension providers can decode their own shape.
type ProviderSection map[string]any

// Budget per provider. Stored under `budgets.<id>`.
type Budget struct {
	LimitUSD float64 `mapstructure:"limit_usd"`
	Period   string  `mapstructure:"period"` // "daily" | "monthly"
}

// Config wraps a *viper.Viper under an RWMutex so concurrent readers from
// different goroutines (manager refresh, CLI status, GUI bindings) never
// race the writer (Save / SetSetting).
type Config struct {
	mu sync.RWMutex
	v  *viper.Viper
}

// New loads ~/.lcmbar/config.yaml (creating the directory if needed) and
// returns a ready-to-use Config. Missing file is fine — defaults apply.
func New() (*Config, error) {
	if err := EnsureDirs(); err != nil {
		return nil, fmt.Errorf("ensure config dirs: %w", err)
	}
	if err := LoadDotenv(); err != nil {
		// dotenv is optional — log via stderr but don't fail boot.
		fmt.Fprintf(os.Stderr, "lcmbar: dotenv: %v\n", err)
	}

	v := viper.New()
	v.SetConfigName("config")
	v.SetConfigType("yaml")
	v.AddConfigPath(ConfigDir())

	// Defaults — match AppSettings. Set BEFORE ReadInConfig so on-disk
	// values still win where the user has set them.
	v.SetDefault("app.refresh_interval_sec", 300)
	v.SetDefault("app.budget_warning_percent", 80)
	v.SetDefault("app.auto_update_mode", "notify-then-auto")

	v.SetEnvPrefix("LCMBAR")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	if err := v.ReadInConfig(); err != nil {
		// File-not-found is fine on first boot — Save() materialises it.
		var nfErr viper.ConfigFileNotFoundError
		if !errAs(err, &nfErr) {
			return nil, fmt.Errorf("read config: %w", err)
		}
	}

	return &Config{v: v}, nil
}

func (c *Config) AppSettings() AppSettings {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := DefaultAppSettings()
	_ = c.v.UnmarshalKey("app", &out)
	return out
}

func (c *Config) ProviderConfig(id string) ProviderSection {
	c.mu.RLock()
	defer c.mu.RUnlock()
	raw := c.v.GetStringMap("providers." + id)
	if raw == nil {
		return ProviderSection{}
	}
	return ProviderSection(raw)
}

func (c *Config) GetBudget(id string) (Budget, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if !c.v.IsSet("budgets." + id) {
		return Budget{}, false
	}
	var b Budget
	if err := c.v.UnmarshalKey("budgets."+id, &b); err != nil {
		return Budget{}, false
	}
	return b, true
}

// SetSetting writes a dotted-path value and persists. Lock-held writes only.
func (c *Config) SetSetting(key string, value any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.v.Set(key, value)
	return c.saveLocked()
}

// Save persists the current in-memory state to ~/.lcmbar/config.yaml.
func (c *Config) Save() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.saveLocked()
}

func (c *Config) saveLocked() error {
	target := ConfigFile()
	if err := c.v.WriteConfigAs(target); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}

// Path returns the resolved config file location for diagnostic CLI output.
func (c *Config) Path() string { return ConfigFile() }

// Underlying exposes the *viper.Viper for components that need full access
// (e.g., the auth package mapping its own subtree). Callers must respect
// the same RWMutex if they mutate.
func (c *Config) Underlying() *viper.Viper { return c.v }
func (c *Config) Lock()                    { c.mu.Lock() }
func (c *Config) Unlock()                  { c.mu.Unlock() }
func (c *Config) RLock()                   { c.mu.RLock() }
func (c *Config) RUnlock()                 { c.mu.RUnlock() }

// Tiny errors.As wrapper so we don't drag the errors import into the file
// header when it's only used once.
func errAs(err error, target any) bool {
	type asAware interface{ As(any) bool }
	for cur := err; cur != nil; cur = unwrap(cur) {
		if a, ok := cur.(asAware); ok && a.As(target) {
			return true
		}
		// viper returns its own error type; check direct identity.
		if matchType(cur, target) {
			return true
		}
	}
	return false
}

func unwrap(err error) error {
	type unwrapper interface{ Unwrap() error }
	if u, ok := err.(unwrapper); ok {
		return u.Unwrap()
	}
	return nil
}

func matchType(err error, target any) bool {
	switch target.(type) {
	case *viper.ConfigFileNotFoundError:
		_, ok := err.(viper.ConfigFileNotFoundError)
		return ok
	}
	return false
}
