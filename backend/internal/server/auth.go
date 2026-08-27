package server

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
)

//go:embed templates/authorize.html
var authorizeHTML []byte

func (s *Server) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html")
	if _, err := w.Write(authorizeHTML); err != nil {
		slog.ErrorContext(r.Context(), "Failed to write authorize HTML", "error", err)
	}
}

func (s *Server) handleApprove(w http.ResponseWriter, r *http.Request) {
	code, err := s.auth.GenerateCode()
	if err != nil {
		http.Error(w, "Failed to generate code", http.StatusInternalServerError)
		return
	}

	// Redirect to Chrome Extension using hardcoded ID
	redirectURL := fmt.Sprintf("https://%s.chromiumapp.org/?code=%s", s.cfg.GetExtensionID(), code)
	http.Redirect(w, r, redirectURL, http.StatusFound)
}

func (s *Server) handleToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	token, err := s.auth.ExchangeCode(r.Context(), req.Code)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	resp := struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}{
		AccessToken: token,
		TokenType:   "Bearer",
	}

	w.Header().Set("Content-Type", "application/json")
	//nolint:gosec // False positive: returning access token in OAuth flow
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		slog.ErrorContext(r.Context(), "Failed to encode token response", "error", err)
	}
}

func (s *Server) handleCompanionToken(w http.ResponseWriter, r *http.Request) {
	token, err := s.auth.GenerateToken(r.Context())
	if err != nil {
		http.Error(w, "Failed to generate companion token", http.StatusInternalServerError)
		return
	}

	resp := struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}{
		AccessToken: token,
		TokenType:   "Bearer",
	}

	w.Header().Set("Content-Type", "application/json")
	//nolint:gosec // False positive: returning access token in OAuth flow
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		slog.ErrorContext(r.Context(), "Failed to encode companion token response", "error", err)
	}
}
