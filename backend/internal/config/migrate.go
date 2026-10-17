package config

import (
	"errors"
	"log/slog"
	"os"
	"strings"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// PinnedReposBackupSuffix is the filename suffix used for the one-time pre-migration config backup.
const PinnedReposBackupSuffix = ".bak-pinned-repos"

// MigratePinnedRepos converts cfg.pinned_repos into saved searches (in order, trimmed, and
// deduplicated case-insensitively) and clears cfg.pinned_repos. Invalid owner/name entries are
// logged and skipped. An entry is skipped if a saved search already has the same name or query
// text (case-insensitively). Returns true if cfg had any pinned_repos entries.
func MigratePinnedRepos(cfg *octodeckv1.Config) bool {
	if cfg == nil || len(cfg.GetPinnedRepos()) == 0 {
		return false
	}
	pinned := cfg.GetPinnedRepos()
	searches := cloneSavedSearches(cfg.GetSavedSearches())
	usedIDs := make(map[string]struct{}, len(searches))
	for _, s := range searches {
		if id := s.GetId(); id != "" {
			usedIDs[id] = struct{}{}
		}
	}

	seenPinned := make(map[string]struct{}, len(pinned))
	for _, raw := range pinned {
		repo := strings.TrimSpace(raw)
		if !isValidPinnedRepo(repo) {
			slog.Warn("Dropping invalid pinned_repos entry during migration", "repo", raw)
			continue
		}
		foldedRepo := strings.ToLower(repo)
		if _, dup := seenPinned[foldedRepo]; dup {
			continue
		}
		seenPinned[foldedRepo] = struct{}{}

		query := "repo:" + repo
		if hasSavedSearchWithNameOrQuery(searches, repo, query) {
			continue
		}

		id := generateSavedSearchID(usedIDs)
		usedIDs[id] = struct{}{}
		searches = append(searches, octodeckv1.SavedSearch_builder{
			Id:    &id,
			Name:  &repo,
			Query: &query,
		}.Build())
	}

	cfg.SetSavedSearches(searches)
	cfg.SetPinnedRepos(nil)
	return true
}

func hasSavedSearchWithNameOrQuery(searches []*octodeckv1.SavedSearch, name, query string) bool {
	for _, s := range searches {
		if strings.EqualFold(s.GetName(), name) || strings.EqualFold(strings.TrimSpace(s.GetQuery()), query) {
			return true
		}
	}
	return false
}

func isValidPinnedRepo(s string) bool {
	owner, name, ok := strings.Cut(s, "/")
	if !ok || strings.Contains(name, "/") {
		return false
	}
	return isRepoSegment(owner) && isRepoSegment(name)
}

func isRepoSegment(s string) bool {
	if s == "" {
		return false
	}
	for i := range len(s) {
		c := s[i]
		valid := (c >= 'A' && c <= 'Z') ||
			(c >= 'a' && c <= 'z') ||
			(c >= '0' && c <= '9') ||
			c == '_' || c == '.' || c == '-'
		if !valid {
			return false
		}
	}
	return true
}

// BackupPinnedRepos copies the file at configPath to configPath + PinnedReposBackupSuffix when cfg
// has non-empty pinned_repos and the backup file does not already exist.
func BackupPinnedRepos(configPath string, cfg *octodeckv1.Config) error {
	if configPath == "" || cfg == nil || len(cfg.GetPinnedRepos()) == 0 {
		return nil
	}
	backupPath := configPath + PinnedReposBackupSuffix
	if _, err := os.Stat(backupPath); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(backupPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return nil
		}
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(backupPath)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(backupPath)
		return err
	}
	return f.Close()
}
