package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/api/octodeck/v1/octodeckv1connect"
	"github.com/tallclair/octodeck/backend/internal/auth"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
)

// Version is the server's version, intended to be overwritten at build time.
//
//nolint:gochecknoglobals // Version is set via ldflags at build time
var Version = "dev"

// GitHubClient defines the interface for GitHub authentication checks.
type GitHubClient interface {
	CheckAuth(ctx context.Context) (string, bool, error)
}

// SyncEngine defines the interface for synchronization and item refetching.
type SyncEngine interface {
	ForceSync(ctx context.Context) error
	RefetchItem(ctx context.Context, id string) (*octodeckv1.Item, error)
	GetStatus() *octodeckv1.SyncStatus
	ResetTicker()
}

// Server provides the HTTP server for the OctoDeck backend.
type Server struct {
	router     *chi.Mux
	db         *database.DB
	auth       *auth.Manager
	ghClient   GitHubClient
	syncEngine SyncEngine
	cfg        *config.Config
	webFS      fs.FS
}

// New creates a new Server instance with the provided dependencies.
func New(db *database.DB, ghClient GitHubClient, syncEngine SyncEngine, cfg *config.Config, webFS fs.FS) *Server {
	r := chi.NewRouter()

	// A good base middleware stack
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// Set a timeout value on the render context of each request, after 60 seconds
	r.Use(middleware.Timeout(config.ServerRequestTimeout))

	s := &Server{
		router:     r,
		db:         db,
		auth:       auth.NewManager(db),
		ghClient:   ghClient,
		syncEngine: syncEngine,
		cfg:        cfg,
		webFS:      webFS,
	}

	// Apply Security Middleware
	r.Use(SecurityMiddleware(s.auth, s.cfg))

	s.routes()

	return s
}

func (s *Server) routes() {
	// Auth routes
	s.router.Get("/auth/authorize", s.handleAuthorize)
	s.router.Post("/auth/approve", s.handleApprove)
	s.router.Post("/auth/token", s.handleToken)

	// Mount ConnectRPC handler
	_, handler := octodeckv1connect.NewOctoDeckServiceHandler(&octoDeckHandler{
		db:         s.db,
		syncEngine: s.syncEngine,
		cfg:        s.cfg,
		ghClient:   s.ghClient,
	})

	s.router.Route("/api/v1", func(r chi.Router) {
		r.Handle("/*", http.StripPrefix("/api/v1", handler))
		r.Get("/status", s.handleStatus)
		r.Post("/auth/companion-token", s.handleCompanionToken)
	})

	// Web App routes: Reverse proxy for --debug-server mode or static embed serving
	if devServerURL := s.cfg.GetDevServer(); devServerURL != "" {
		proxyURL, err := url.Parse(devServerURL)
		if err == nil {
			proxy := httputil.NewSingleHostReverseProxy(proxyURL)
			proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
				msg := fmt.Sprintf("503 Service Unavailable: Debug server at %s is unreachable. "+
					"Ensure 'npm run dev:webapp' is running.", devServerURL)
				http.Error(w, msg, http.StatusServiceUnavailable)
			}
			s.router.Handle("/*", proxy)
		}
	} else if s.webFS != nil {
		subFS, err := fs.Sub(s.webFS, "frontend_dist")
		if err == nil {
			s.router.Handle("/*", spaFileServer(subFS))
		}
	}
}

func spaFileServer(root fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path != "" {
			// If file exists in root, serve it directly
			if f, err := root.Open(path); err == nil {
				_ = f.Close()
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		// Fallback to index.html for client-side SPA routing
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}

type statusResponse struct {
	GHAuthenticated bool   `json:"gh_authenticated"`
	Version         string `json:"version"`
	Error           string `json:"error,omitempty"`
	Message         string `json:"message,omitempty"`
	LocalAuthError  string `json:"local_auth_error,omitempty"`
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	_, authenticated, err := s.ghClient.CheckAuth(r.Context())

	resp := statusResponse{
		GHAuthenticated: authenticated,
		Version:         Version,
	}

	if err != nil {
		resp.Error = "UPSTREAM_AUTH_REQUIRED"
		resp.Message = "Run 'gh auth login' to enable OctoDeck."
	}

	// Check for local auth errors reported by middleware
	if authErr := GetAuthError(r.Context()); authErr != "" {
		resp.LocalAuthError = authErr
		if resp.Error == "" {
			resp.Error = "LOCAL_AUTH_REQUIRED"
			resp.Message = authErr
		}
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		slog.ErrorContext(r.Context(), "Failed to encode status response", "error", err)
	}
}

// Start runs the HTTP server on the specified port.
// It blocks until the context is cancelled or a server error occurs.
func (s *Server) Start(ctx context.Context, port int) error {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.router,
		ReadHeaderTimeout: config.ServerReadHeaderTimeout,
	}

	// Channel to listen for errors coming from the listener.
	serverErrors := make(chan error, 1)

	go func() {
		slog.InfoContext(ctx, "Starting server", "address", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			serverErrors <- err
		}
	}()

	// Blocking wait for either context cancellation or server error
	select {
	case err := <-serverErrors:
		return fmt.Errorf("server error: %w", err)
	case <-ctx.Done():
		// Graceful shutdown
		slog.InfoContext(ctx, "Shutting down server...")

		// Create a timeout for the shutdown
		shutdownCtx, cancel := context.WithTimeout(context.Background(), config.ServerShutdownTimeout)
		defer cancel()

		if err := srv.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("could not stop server gracefully: %w", err)
		}
	}

	return nil
}
