package services

import (
	"context"

	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/app"
	"github.com/yimin12/llm-cost-monitor/go-desktop/internal/auth"
)

// AuthService surfaces session state to the GUI. Mirrors the IPC handlers
// (auth-login / auth-status / auth-logout) but as direct calls when the GUI
// shares the daemon process.
type AuthService struct {
	a *app.App
}

func NewAuthService(a *app.App) *AuthService { return &AuthService{a: a} }

func (s *AuthService) Status() auth.AuthSnapshot {
	if s.a.Auth == nil {
		return auth.AuthSnapshot{}
	}
	return s.a.Auth.Snapshot()
}

func (s *AuthService) Login(ctx context.Context) (auth.AuthSnapshot, error) {
	if err := s.a.Auth.Login(ctx); err != nil {
		return auth.AuthSnapshot{}, err
	}
	return s.a.Auth.Snapshot(), nil
}

func (s *AuthService) Logout() error {
	return s.a.Auth.Logout()
}
