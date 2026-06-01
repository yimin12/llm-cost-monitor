package auth

import (
	"testing"
	"time"
)

func TestSessionManager_LoadAndSnapshot(t *testing.T) {
	store := &MemoryStore{}
	_ = store.Save(Session{
		Sub:         "u1",
		Email:       "alice@example.com",
		AccessToken: "atok",
		ExpiresAt:   time.Now().Add(time.Hour),
		IssuedAt:    time.Now(),
		Issuer:      "https://idp.example.com",
	})
	m := NewSessionManager(FlowConfig{Issuer: "https://idp.example.com"}, store, nil)
	if err := m.LoadFromStore(); err != nil {
		t.Fatalf("LoadFromStore: %v", err)
	}
	snap := m.Snapshot()
	if !snap.Authenticated {
		t.Fatalf("Authenticated should be true")
	}
	if snap.Email != "alice@example.com" {
		t.Fatalf("Email = %q, want alice@example.com", snap.Email)
	}
	if tok, ok := m.AccessToken(); !ok || tok != "atok" {
		t.Fatalf("AccessToken = (%q, %v), want (atok, true)", tok, ok)
	}
}

func TestSessionManager_LogoutClears(t *testing.T) {
	store := &MemoryStore{}
	_ = store.Save(Session{
		AccessToken: "atok",
		ExpiresAt:   time.Now().Add(time.Hour),
	})
	m := NewSessionManager(FlowConfig{}, store, nil)
	_ = m.LoadFromStore()
	if err := m.Logout(); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	if snap := m.Snapshot(); snap.Authenticated {
		t.Fatalf("Authenticated should be false after logout")
	}
	if _, err := store.Load(); err == nil {
		t.Fatalf("MemoryStore.Load should error after Clear")
	}
}

func TestSessionIsExpired_SkewWindow(t *testing.T) {
	// 30s of skew is baked into IsExpired — verify both sides.
	near := Session{ExpiresAt: time.Now().Add(10 * time.Second)}
	if !near.IsExpired() {
		t.Fatalf("token within skew window should be considered expired")
	}
	fresh := Session{ExpiresAt: time.Now().Add(2 * time.Minute)}
	if fresh.IsExpired() {
		t.Fatalf("token outside skew window should NOT be expired")
	}
}
