package services

import (
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/app"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/config"
)

type SettingsService struct {
	a *app.App
}

func NewSettingsService(a *app.App) *SettingsService { return &SettingsService{a: a} }

func (s *SettingsService) AppSettings() config.AppSettings {
	return s.a.Cfg.AppSettings()
}

// Get reads a dotted-path key from Viper. Returned as `any` so the JS side
// gets the natural type (number, bool, string, map, slice).
func (s *SettingsService) Get(key string) any {
	return s.a.Cfg.Underlying().Get(key)
}

func (s *SettingsService) Set(key string, value any) error {
	return s.a.Cfg.SetSetting(key, value)
}
