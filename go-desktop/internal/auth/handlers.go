package auth

import "context"

// LoginHandler runs the PKCE flow synchronously and returns a snapshot.
func LoginHandler(m *SessionManager) func(context.Context, map[string]any) (any, error) {
	return func(ctx context.Context, _ map[string]any) (any, error) {
		if err := m.Login(ctx); err != nil {
			return nil, err
		}
		return m.Snapshot(), nil
	}
}

// StatusHandler returns the sanitised AuthSnapshot.
func StatusHandler(m *SessionManager) func(context.Context, map[string]any) (any, error) {
	return func(_ context.Context, _ map[string]any) (any, error) {
		return m.Snapshot(), nil
	}
}

// LogoutHandler clears the in-memory and persisted session.
func LogoutHandler(m *SessionManager) func(context.Context, map[string]any) (any, error) {
	return func(_ context.Context, _ map[string]any) (any, error) {
		if err := m.Logout(); err != nil {
			return nil, err
		}
		return map[string]any{"loggedOut": true}, nil
	}
}
