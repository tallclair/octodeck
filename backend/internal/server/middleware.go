package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"

	"github.com/tallclair/octodeck/backend/internal/auth"
	"github.com/tallclair/octodeck/backend/internal/config"
)

type contextKey string

const (
	authErrorKey contextKey = "authError"
	statusPath   string     = "/api/v1/status"
	//nolint:gosec // False positive: URL endpoint path, not a credential
	companionTokenPath string = "/api/v1/auth/companion-token"
	csrfCookie         string = "octodeck_csrf"
	csrfHeader         string = "X-Csrf-Token"
	csrfTokenLength    int    = 16
)

func generateCSRFToken() string {
	b := make([]byte, csrfTokenLength)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// SecurityMiddleware enforces Origin and Token checks.
func SecurityMiddleware(authMgr *auth.Manager, cfg *config.Config) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path := r.URL.Path

			// Auto-issue Anti-CSRF Cookie on GET / or status if missing
			if path == "/" || path == statusPath {
				if cookie, err := r.Cookie(csrfCookie); err != nil || cookie.Value == "" {
					//nolint:gosec // Cookie must be accessible via JS for Double-Submit Anti-CSRF pattern
					http.SetCookie(w, &http.Cookie{
						Name:     csrfCookie,
						Value:    generateCSRFToken(),
						Path:     "/",
						SameSite: http.SameSiteLaxMode,
					})
				}
			}

			// 1. Origin Check
			originValid, checkOrigin := checkOrigin(r, path, cfg)

			// 2. Token Check
			tokenValid, checkToken := checkToken(r, path, authMgr, cfg)

			// 3. Enforcement
			if path == statusPath {
				// The status endpoint reports errors in the context instead of blocking.
				handleStatusEnforcement(next, w, r, originValid, tokenValid, checkOrigin, checkToken)
				return
			}

			// Standard Enforcement
			if checkOrigin && !originValid {
				http.Error(w, "Invalid Origin", http.StatusForbidden)
				return
			}

			if checkToken && !tokenValid {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func handleStatusEnforcement(
	next http.Handler,
	w http.ResponseWriter,
	r *http.Request,
	originValid, tokenValid, checkOrigin, checkToken bool,
) {
	var authErr string
	if checkOrigin && !originValid {
		authErr = "Invalid Origin"
	} else if checkToken && !tokenValid {
		authErr = "Invalid Token"
	}

	if authErr != "" {
		ctx := context.WithValue(r.Context(), authErrorKey, authErr)
		next.ServeHTTP(w, r.WithContext(ctx))
		return
	}
	// If valid, just proceed
	next.ServeHTTP(w, r)
}

func checkOrigin(r *http.Request, path string, cfg *config.Config) (bool, bool) {
	// Enforce on all endpoints except auth flow entry points and status.
	shouldCheck := path != "/auth/authorize" && path != "/auth/approve"
	if !shouldCheck {
		return true, false
	}

	origin := r.Header.Get("Origin")
	if origin != "" {
		expectedExtensionOrigin := "chrome-extension://" + cfg.GetExtensionID()
		valid := origin == expectedExtensionOrigin ||
			strings.HasPrefix(origin, "http://127.0.0.1:") ||
			strings.HasPrefix(origin, "http://localhost:")
		return valid, true
	}

	// For browser requests without Origin header, verify Referer if present and local
	referer := r.Header.Get("Referer")
	if referer != "" {
		valid := strings.HasPrefix(referer, "http://127.0.0.1:") ||
			strings.HasPrefix(referer, "http://localhost:")
		return valid, true
	}

	// Direct top-level browser page loads (non-API static routes) do not send
	// Origin or Referer headers in web browsers and should be allowed.
	if !strings.HasPrefix(path, "/api/") {
		return true, true
	}

	return false, true
}

func checkToken(r *http.Request, path string, authMgr *auth.Manager, cfg *config.Config) (bool, bool) {
	// Enforce on API endpoints.
	shouldCheck := strings.HasPrefix(path, "/api/")
	if !shouldCheck {
		return true, false
	}

	// 1. Check Extension Bearer Token
	if token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		valid, err := authMgr.ValidateToken(r.Context(), token)
		if err == nil && valid {
			return true, true
		}
	}

	// 2. Allow Companion Token creation from Extension Origin
	if path == companionTokenPath {
		origin := r.Header.Get("Origin")
		if origin == "chrome-extension://"+cfg.GetExtensionID() {
			return true, true
		}
	}

	// 3. Check Double-Submit Anti-CSRF Token (Web App Mode)
	cookie, err := r.Cookie(csrfCookie)
	headerToken := r.Header.Get(csrfHeader)
	if err == nil && cookie.Value != "" && headerToken != "" && cookie.Value == headerToken {
		return true, true
	}

	return false, true
}

// GetAuthError retrieves the auth error from the context.
func GetAuthError(ctx context.Context) string {
	if val, ok := ctx.Value(authErrorKey).(string); ok {
		return val
	}
	return ""
}
