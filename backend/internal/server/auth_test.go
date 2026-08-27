package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
)

func TestAuthHandlers(t *testing.T) {
	db, err := database.Init(t.Context(), database.InMemoryDSN)
	require.NoError(t, err)
	defer func() { require.NoError(t, db.Close()) }()

	mockSync := &mockSyncEngine{}
	mockGH := &mockGitHubClient{authenticated: true}
	cfg := config.NewForTest(&octodeckv1.Config{})

	s := New(db, mockGH, mockSync, cfg, nil)

	t.Run("handleAuthorize", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/authorize", nil)
		w := httptest.NewRecorder()

		s.handleAuthorize(w, req)

		resp := w.Result()
		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Contains(t, w.Body.String(), "<!DOCTYPE html>") // Assuming template starts with this
	})

	t.Run("handleApprove", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/approve", nil)
		w := httptest.NewRecorder()

		s.handleApprove(w, req)

		resp := w.Result()
		assert.Equal(t, http.StatusFound, resp.StatusCode)

		location := resp.Header.Get("Location")
		assert.Contains(t, location, config.DevExtensionID)
		assert.Contains(t, location, "code=")
	})

	t.Run("handleToken", func(t *testing.T) {
		// 1. Generate a valid code first
		code, err := s.auth.GenerateCode()
		require.NoError(t, err)

		// 2. Exchange it
		body := map[string]string{"code": code}
		bodyBytes, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/token", bytes.NewReader(bodyBytes))
		w := httptest.NewRecorder()

		s.handleToken(w, req)

		resp := w.Result()
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var respBody map[string]string
		err = json.NewDecoder(resp.Body).Decode(&respBody)
		require.NoError(t, err)
		assert.NotEmpty(t, respBody["access_token"])
		assert.Equal(t, "Bearer", respBody["token_type"])
	})

	t.Run("handleToken_InvalidCode", func(t *testing.T) {
		body := map[string]string{"code": "invalid"}
		bodyBytes, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/token", bytes.NewReader(bodyBytes))
		w := httptest.NewRecorder()

		s.handleToken(w, req)

		resp := w.Result()
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("handleToken_InvalidJSON", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/token", strings.NewReader("bad json"))
		w := httptest.NewRecorder()

		s.handleToken(w, req)

		resp := w.Result()
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})
}
