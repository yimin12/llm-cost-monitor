package auth

import (
	"errors"
	"sync"

	"github.com/zalando/go-keyring"
)

// TokenStore — pluggable persistence. Production uses keyring; tests +
// headless servers use Memory.
type TokenStore interface {
	Save(s Session) error
	Load() (Session, error)
	Clear() error
}

const keyringService = "llm-cost-monitor"
const keyringUser = "default"

// KeyringStore — go-keyring backed. Stores AccessToken under the service +
// user key; everything else lives next to it as a JSON blob under "<user>:meta".
type KeyringStore struct{}

func (k *KeyringStore) Save(s Session) error {
	return errors.Join(
		keyring.Set(keyringService, keyringUser+":access", s.AccessToken),
		keyring.Set(keyringService, keyringUser+":refresh", s.RefreshToken),
		keyring.Set(keyringService, keyringUser+":id", s.IDToken),
	)
}

func (k *KeyringStore) Load() (Session, error) {
	a, err := keyring.Get(keyringService, keyringUser+":access")
	if err != nil {
		return Session{}, err
	}
	r, _ := keyring.Get(keyringService, keyringUser+":refresh")
	id, _ := keyring.Get(keyringService, keyringUser+":id")
	return Session{AccessToken: a, RefreshToken: r, IDToken: id}, nil
}

func (k *KeyringStore) Clear() error {
	for _, suffix := range []string{":access", ":refresh", ":id"} {
		_ = keyring.Delete(keyringService, keyringUser+suffix)
	}
	return nil
}

// MemoryStore — in-process fallback. Used when keyring isn't available
// (CI, server, --headless flag).
type MemoryStore struct {
	mu sync.RWMutex
	s  Session
}

func (m *MemoryStore) Save(s Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.s = s
	return nil
}

func (m *MemoryStore) Load() (Session, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.s.AccessToken == "" {
		return Session{}, errors.New("no session")
	}
	return m.s, nil
}

func (m *MemoryStore) Clear() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.s = Session{}
	return nil
}
