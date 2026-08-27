package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
)

const (
	authCodeLength  = 32
	authTokenLength = 64
)

// Manager handles the Local OAuth flow logic.
type Manager struct {
	db *database.DB

	// codes stores active authorization codes.
	// map key is the code string.
	codes  sync.Map
	stopCh chan struct{}
}

type authCodeInfo struct {
	ExpiresAt time.Time
}

// NewManager creates a new Auth Manager.
func NewManager(db *database.DB) *Manager {
	return &Manager{
		db:     db,
		stopCh: make(chan struct{}),
	}
}

// Start begins the manager's background tasks, like cleaning up expired codes.
func (m *Manager) Start() {
	ticker := time.NewTicker(1 * time.Hour)
	go func() {
		for {
			select {
			case <-ticker.C:
				m.cleanupCodes()
			case <-m.stopCh:
				ticker.Stop()
				return
			}
		}
	}()
}

// Stop terminates the manager's background tasks.
func (m *Manager) Stop() {
	close(m.stopCh)
}

func (m *Manager) cleanupCodes() {
	m.codes.Range(func(key, value any) bool {
		info, ok := value.(authCodeInfo)
		if !ok {
			slog.Error("Unexpected auth code value type", "key", key, "value", value)
			return true
		}
		if time.Now().After(info.ExpiresAt) {
			m.codes.Delete(key)
		}
		return true
	})
}

// GenerateCode generates a short-lived authorization code.
func (m *Manager) GenerateCode() (string, error) {
	code, err := generateRandomString(authCodeLength)
	if err != nil {
		return "", fmt.Errorf("failed to generate code: %w", err)
	}

	info := authCodeInfo{
		ExpiresAt: time.Now().Add(config.AuthCodeExpiry),
	}

	m.codes.Store(code, info)
	return code, nil
}

// ExchangeCode validates the authorization code and exchanges it for a persistent token.
func (m *Manager) ExchangeCode(ctx context.Context, code string) (string, error) {
	val, ok := m.codes.LoadAndDelete(code)
	if !ok {
		return "", errors.New("invalid or expired authorization code")
	}

	info, ok := val.(authCodeInfo)
	if !ok {
		return "", fmt.Errorf("invalid code type %T for code %s in store", val, code)
	}
	if time.Now().After(info.ExpiresAt) {
		return "", errors.New("authorization code expired")
	}

	token, err := generateRandomString(authTokenLength)
	if err != nil {
		return "", fmt.Errorf("failed to generate token: %w", err)
	}

	// Store token in DB
	_, err = m.db.ExecContext(ctx, "INSERT INTO tokens (token, created_at) VALUES (?, ?)",
		token, time.Now())
	if err != nil {
		return "", fmt.Errorf("failed to persist token: %w", err)
	}

	return token, nil
}

// GenerateToken creates a persistent Bearer token directly and stores it in the database.
func (m *Manager) GenerateToken(ctx context.Context) (string, error) {
	token, err := generateRandomString(authTokenLength)
	if err != nil {
		return "", fmt.Errorf("failed to generate token: %w", err)
	}

	_, err = m.db.ExecContext(ctx, "INSERT INTO tokens (token, created_at) VALUES (?, ?)",
		token, time.Now())
	if err != nil {
		return "", fmt.Errorf("failed to persist token: %w", err)
	}

	return token, nil
}

// ValidateToken checks if the bearer token exists in the database.
func (m *Manager) ValidateToken(ctx context.Context, token string) (bool, error) {
	var exists int
	err := m.db.QueryRowContext(ctx, "SELECT 1 FROM tokens WHERE token = ?", token).Scan(&exists)
	if err != nil {
		if err == sql.ErrNoRows {
			// Valid case: token doesn't exist.
			return false, nil
		}
		// Actual database error.
		return false, fmt.Errorf("failed to query token: %w", err)
	}
	return exists == 1, nil
}

func generateRandomString(length int) (string, error) {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}
