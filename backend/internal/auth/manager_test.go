package auth_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tallclair/octodeck/backend/internal/auth"
	"github.com/tallclair/octodeck/backend/internal/database"
)

func TestAuthFlow(t *testing.T) {
	// Setup temporary DB
	db, err := database.Init(t.Context(), database.InMemoryDSN)
	require.NoError(t, err, "Failed to init db")
	defer func() { require.NoError(t, db.Close()) }()

	mgr := auth.NewManager(db)

	// 1. Generate Code
	code, err := mgr.GenerateCode()
	require.NoError(t, err, "GenerateCode failed")
	require.NotEmpty(t, code, "Generated code is empty")

	// 2. Exchange Code for Token
	token, err := mgr.ExchangeCode(t.Context(), code)
	require.NoError(t, err, "ExchangeCode failed")
	require.NotEmpty(t, token, "Generated token is empty")

	// 3. Try to exchange same code again (should fail)
	_, err = mgr.ExchangeCode(t.Context(), code)
	require.Error(t, err, "Expected error when exchanging code twice, got nil")

	// 4. Validate Token
	valid, err := mgr.ValidateToken(t.Context(), token)
	require.NoError(t, err, "ValidateToken failed")
	require.True(t, valid, "Token should be valid")

	// 5. Validate Invalid Token
	valid, err = mgr.ValidateToken(t.Context(), "invalid-token")
	require.NoError(t, err, "ValidateToken failed")
	require.False(t, valid, "Invalid token should not be valid")
}

func TestValidateTokenDBError(t *testing.T) {
	// Setup temporary DB
	db, err := database.Init(t.Context(), database.InMemoryDSN)
	require.NoError(t, err, "Failed to init db")

	mgr := auth.NewManager(db)

	// Close the DB to simulate an error
	require.NoError(t, db.Close())

	_, err = mgr.ValidateToken(t.Context(), "any-token")
	require.Error(t, err, "Expected an error when db is closed")
}
