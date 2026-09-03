package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
)

type mockGitHubClient struct {
	authenticated bool
	err           error
}

func (m *mockGitHubClient) CheckAuth(_ context.Context) (string, bool, error) {
	return "testuser", m.authenticated, m.err
}

type mockSyncEngine struct {
	forceSyncCalled   bool
	resetTickerCalled bool
	err               error
	refetchItemFn     func(ctx context.Context, id string) (*octodeckv1.Item, error)
}

func (m *mockSyncEngine) ForceSync(_ context.Context) error {
	m.forceSyncCalled = true
	return m.err
}

func (m *mockSyncEngine) RefetchItem(ctx context.Context, id string) (*octodeckv1.Item, error) {
	if m.refetchItemFn != nil {
		return m.refetchItemFn(ctx, id)
	}
	if id == "non_existent" {
		return nil, errors.New("item was not found on GitHub")
	}
	return octodeckv1.Item_builder{Id: config.Ptr(id)}.Build(), m.err
}

func (m *mockSyncEngine) GetStatus() *octodeckv1.SyncStatus {
	return octodeckv1.SyncStatus_builder{}.Build()
}

func (m *mockSyncEngine) ResetTicker() {
	m.resetTickerCalled = true
}

func TestStatusHandler(t *testing.T) {
	expectedVersion := Version
	const (
		authError = "UPSTREAM_AUTH_REQUIRED"
	)

	tests := []struct {
		name              string
		authenticated     bool
		authErr           error
		wantAuthenticated bool
		wantError         string
	}{
		{
			name:              "Authenticated",
			authenticated:     true,
			authErr:           nil,
			wantAuthenticated: true,
			wantError:         "",
		},
		{
			name:              "Not Authenticated",
			authenticated:     false,
			authErr:           errors.New("auth failed"),
			wantAuthenticated: false,
			wantError:         authError,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db, err := database.Init(t.Context(), database.InMemoryDSN)
			require.NoError(t, err, "Failed to init database")
			defer func() { require.NoError(t, db.Close()) }()

			mockGH := &mockGitHubClient{
				authenticated: tt.authenticated,
				err:           tt.authErr,
			}
			mockSync := &mockSyncEngine{}
			cfg := config.NewForTest(&octodeckv1.Config{})

			s := New(db, mockGH, mockSync, cfg, nil)
			ts := httptest.NewServer(s.router)
			defer ts.Close()
			// Generate valid local auth
			code, err := s.auth.GenerateCode()
			require.NoError(t, err, "Failed to generate auth code")
			token, err := s.auth.ExchangeCode(t.Context(), code)
			require.NoError(t, err, "Failed to exchange auth code")

			req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/status", nil)
			require.NoError(t, err)

			// Set Headers for Local Auth
			req.Header.Set("Origin", "chrome-extension://"+config.DevExtensionID)
			req.Header.Set("Authorization", "Bearer "+token)

			res, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer func() { require.NoError(t, res.Body.Close()) }()

			assert.Equal(t, http.StatusOK, res.StatusCode, "expected status OK")

			var resp struct {
				GHAuthenticated bool   `json:"gh_authenticated"`
				Version         string `json:"version"`
				Error           string `json:"error"`
				Message         string `json:"message"`
			}
			err = json.NewDecoder(res.Body).Decode(&resp)
			require.NoError(t, err)

			assert.Equal(t, expectedVersion, resp.Version, "expected version "+expectedVersion)
			assert.Equal(t, tt.wantAuthenticated, resp.GHAuthenticated, "expected GHAuthenticated match")
			assert.Equal(t, tt.wantError, resp.Error, "expected Error match")
		})
	}
}

func TestSPAFileServer(t *testing.T) {
	mockFS := fstest.MapFS{
		"frontend_dist/index.html":       &fstest.MapFile{Data: []byte("<html><body>Dashboard</body></html>")},
		"frontend_dist/assets/app.js":    &fstest.MapFile{Data: []byte("console.log('app');")},
		"frontend_dist/assets/style.css": &fstest.MapFile{Data: []byte("body { color: red; }")},
	}

	db, err := database.Init(t.Context(), database.InMemoryDSN)
	require.NoError(t, err)
	defer func() { require.NoError(t, db.Close()) }()

	cfg := config.NewForTest(&octodeckv1.Config{})
	s := New(db, &mockGitHubClient{authenticated: true}, &mockSyncEngine{}, cfg, mockFS)
	ts := httptest.NewServer(s.router)
	defer ts.Close()

	// 1. Root path serves index.html
	res, err := http.Get(ts.URL + "/")
	require.NoError(t, err)
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	assert.Equal(t, http.StatusOK, res.StatusCode)
	assert.Contains(t, string(body), "Dashboard")

	// 2. Static asset serves the file
	res, err = http.Get(ts.URL + "/assets/app.js")
	require.NoError(t, err)
	body, _ = io.ReadAll(res.Body)
	_ = res.Body.Close()
	assert.Equal(t, http.StatusOK, res.StatusCode)
	assert.Contains(t, string(body), "console.log('app');")

	// 3. /debug path falls back to index.html for SPA routing
	res, err = http.Get(ts.URL + "/debug")
	require.NoError(t, err)
	body, _ = io.ReadAll(res.Body)
	_ = res.Body.Close()
	assert.Equal(t, http.StatusOK, res.StatusCode)
	assert.Contains(t, string(body), "Dashboard")
}
