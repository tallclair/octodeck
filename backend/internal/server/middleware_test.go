package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/auth"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
)

func TestSecurityMiddleware(t *testing.T) {
	db, err := database.Init(t.Context(), database.InMemoryDSN)
	require.NoError(t, err)
	defer func() { require.NoError(t, db.Close()) }()

	authMgr := auth.NewManager(db)

	// Helper to generate a valid token
	code, err := authMgr.GenerateCode()
	require.NoError(t, err)
	validToken, err := authMgr.ExchangeCode(t.Context(), code)
	require.NoError(t, err)

	cfg := config.NewForTest(&octodeckv1.Config{})
	mw := SecurityMiddleware(authMgr, cfg)

	tests := []struct {
		name           string
		path           string
		origin         string
		token          string // "Bearer ..."
		csrfCookieVal  string
		csrfHeaderVal  string
		expectedStatus int
		expectedErr    string // For status endpoint context check
	}{
		// Static Web App Pages (Direct browser navigation without Origin/Referer)
		{
			name:           "Web App Root (Direct browser navigation)",
			path:           "/",
			origin:         "",
			token:          "",
			expectedStatus: http.StatusOK,
		},
		{
			name:           "Web App Asset (Direct browser navigation)",
			path:           "/assets/index.js",
			origin:         "",
			token:          "",
			expectedStatus: http.StatusOK,
		},

		// Auth Endpoints (Exemptions)
		{
			name:           "Auth Authorize (No checks)",
			path:           "/auth/authorize",
			origin:         "",
			token:          "",
			expectedStatus: http.StatusOK,
		},
		{
			name:           "Auth Approve (No checks)",
			path:           "/auth/approve",
			origin:         "",
			token:          "",
			expectedStatus: http.StatusOK,
		},
		{
			name:           "Auth Token (Origin valid)",
			path:           "/auth/token",
			origin:         "chrome-extension://" + config.DevExtensionID,
			token:          "",
			expectedStatus: http.StatusOK,
		},
		{
			name:           "Auth Token (Origin invalid)",
			path:           "/auth/token",
			origin:         "http://evil.com",
			token:          "",
			expectedStatus: http.StatusForbidden,
		},

		// Status Endpoint (Reporting)
		{
			name:           "Status (No Origin, No Token - Report Error)",
			path:           "/api/v1/status",
			origin:         "",
			token:          "",
			expectedStatus: http.StatusOK,
			expectedErr:    "Invalid Origin",
		},
		{
			name:           "Status (Valid Origin, No Token - Report Error)",
			path:           "/api/v1/status",
			origin:         "chrome-extension://" + config.DevExtensionID,
			token:          "",
			expectedStatus: http.StatusOK,
			expectedErr:    "Invalid Token",
		},
		{
			name:           "Status (Valid Origin, Valid Token - No Error)",
			path:           "/api/v1/status",
			origin:         "chrome-extension://" + config.DevExtensionID,
			token:          "Bearer " + validToken,
			expectedStatus: http.StatusOK,
			expectedErr:    "",
		},

		// Protected API Endpoints
		{
			name:           "API (No Origin)",
			path:           "/api/v1/issues",
			origin:         "",
			token:          "Bearer " + validToken,
			expectedStatus: http.StatusForbidden,
		},
		{
			name:           "API (No Token)",
			path:           "/api/v1/issues",
			origin:         "chrome-extension://" + config.DevExtensionID,
			token:          "",
			expectedStatus: http.StatusUnauthorized,
		},
		{
			name:           "API (Invalid Token)",
			path:           "/api/v1/issues",
			origin:         "chrome-extension://" + config.DevExtensionID,
			token:          "Bearer invalid",
			expectedStatus: http.StatusUnauthorized,
		},
		{
			name:           "API (Success)",
			path:           "/api/v1/issues",
			origin:         "chrome-extension://" + config.DevExtensionID,
			token:          "Bearer " + validToken,
			expectedStatus: http.StatusOK,
		},
		{
			name:           "API (WebApp Local Origin + CSRF Token - Success)",
			path:           "/api/v1/issues",
			origin:         "http://127.0.0.1:38274",
			csrfCookieVal:  "secret-csrf-token",
			csrfHeaderVal:  "secret-csrf-token",
			expectedStatus: http.StatusOK,
		},
		{
			name:           "API (WebApp Local Origin + Mismatched CSRF Token - Unauthorized)",
			path:           "/api/v1/issues",
			origin:         "http://127.0.0.1:38274",
			csrfCookieVal:  "secret-csrf-token",
			csrfHeaderVal:  "wrong-csrf-token",
			expectedStatus: http.StatusUnauthorized,
		},
		{
			name:           "Companion Token Endpoint (Extension Origin - Success)",
			path:           "/api/v1/auth/companion-token",
			origin:         "chrome-extension://" + config.DevExtensionID,
			token:          "",
			expectedStatus: http.StatusOK,
		},
		{
			name:           "Companion Token Endpoint (Unknown Origin - Forbidden)",
			path:           "/api/v1/auth/companion-token",
			origin:         "chrome-extension://unknown-extension-id",
			token:          "",
			expectedStatus: http.StatusForbidden,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// Inner handler
				if tc.path == "/api/v1/status" {
					authErr := GetAuthError(r.Context())
					assert.Equal(t, tc.expectedErr, authErr, "Auth error mismatch")
				}
				w.WriteHeader(http.StatusOK)
			}))

			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.token != "" {
				req.Header.Set("Authorization", tc.token)
			}
			if tc.csrfCookieVal != "" {
				req.AddCookie(&http.Cookie{Name: "octodeck_csrf", Value: tc.csrfCookieVal})
			}
			if tc.csrfHeaderVal != "" {
				req.Header.Set("X-Csrf-Token", tc.csrfHeaderVal)
			}

			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code, "Status code mismatch")
		})
	}
}
