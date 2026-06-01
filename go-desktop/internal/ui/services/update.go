package services

import (
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/app"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/version"
)

// UpdateService — T10 placeholder. Surfaces the current version and a
// "check" stub that the real updater (internal/updater) will replace.
type UpdateService struct {
	a *app.App
}

func NewUpdateService(a *app.App) *UpdateService { return &UpdateService{a: a} }

type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
}

func (u *UpdateService) Check() UpdateInfo {
	return UpdateInfo{Current: version.Version, Latest: version.Version}
}
