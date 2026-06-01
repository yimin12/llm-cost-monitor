package services

import "github.com/yimin12/llm-cost-monitor/go-desktop/internal/app"

// PluginService — T9 placeholder. Returns an empty list until the plugin
// host is wired in. Keep the method here so the JS side can bind against a
// stable shape (an array of plugin descriptors).
type PluginService struct {
	a *app.App
}

func NewPluginService(a *app.App) *PluginService { return &PluginService{a: a} }

type PluginDescriptor struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version string `json:"version"`
	Status  string `json:"status"` // "running" | "stopped" | "errored"
}

func (p *PluginService) List() []PluginDescriptor { return nil }
