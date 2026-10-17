package config

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// TestMigratePinnedRepos_Basic tests converting valid pinned repos to repo:owner/name saved searches,
// trimming whitespace, assigning IDs, and clearing pinned_repos.
func TestMigratePinnedRepos_Basic(t *testing.T) {
	cfg := octodeckv1.Config_builder{
		PinnedRepos: []string{" kubernetes/kubernetes ", "owner/repo-name.v1"},
	}.Build()

	changed := MigratePinnedRepos(cfg)
	assert.True(t, changed)
	assert.Empty(t, cfg.GetPinnedRepos())

	searches := cfg.GetSavedSearches()
	require.Len(t, searches, 2)

	assert.NotEmpty(t, searches[0].GetId())
	assert.Equal(t, "kubernetes/kubernetes", searches[0].GetName())
	assert.Equal(t, "repo:kubernetes/kubernetes", searches[0].GetQuery())

	assert.NotEmpty(t, searches[1].GetId())
	assert.NotEqual(t, searches[0].GetId(), searches[1].GetId())
	assert.Equal(t, "owner/repo-name.v1", searches[1].GetName())
	assert.Equal(t, "repo:owner/repo-name.v1", searches[1].GetQuery())
}

// TestMigratePinnedRepos_InvalidAndDuplicates tests dropping invalid entries and deduplicating
// case-insensitively.
func TestMigratePinnedRepos_InvalidAndDuplicates(t *testing.T) {
	cfg := octodeckv1.Config_builder{
		PinnedRepos: []string{
			"valid/repo",
			"VALID/REPO", // duplicate
			"Valid/Repo", // duplicate
			"invalid-no-slash",
			"too/many/slashes/here",
			"has spaces/repo",
			"owner/has spaces",
			"",
			"   ",
			"/no-owner",
			"no-repo/",
			"owner/repo\nnewline",
		},
	}.Build()

	changed := MigratePinnedRepos(cfg)
	assert.True(t, changed)
	assert.Empty(t, cfg.GetPinnedRepos())

	searches := cfg.GetSavedSearches()
	require.Len(t, searches, 1)
	assert.Equal(t, "valid/repo", searches[0].GetName())
	assert.Equal(t, "repo:valid/repo", searches[0].GetQuery())
}

// TestMigratePinnedRepos_SkipsExistingNameOrQuery tests that entries whose name or query already
// exists (case-insensitively) in saved_searches are skipped, so a renamed converted search is
// not recreated.
func TestMigratePinnedRepos_SkipsExistingNameOrQuery(t *testing.T) {
	existing := []*octodeckv1.SavedSearch{
		// Same name, different query.
		octodeckv1.SavedSearch_builder{
			Id:    Ptr("s1"),
			Name:  Ptr("Kubernetes/Kubernetes"),
			Query: Ptr("repo:k8s/k8s is:open"),
		}.Build(),
		// Renamed search whose query matches repo:owner/name.
		octodeckv1.SavedSearch_builder{
			Id:    Ptr("s2"),
			Name:  Ptr("My Pinned Tool"),
			Query: Ptr("repo:Org/Tool"),
		}.Build(),
	}

	cfg := octodeckv1.Config_builder{
		SavedSearches: existing,
		PinnedRepos: []string{
			"kubernetes/kubernetes", // matches existing name (case-insensitive)
			"org/tool",              // matches existing query (case-insensitive)
			"new/repo",              // new entry, should be converted
		},
	}.Build()

	changed := MigratePinnedRepos(cfg)
	assert.True(t, changed)
	assert.Empty(t, cfg.GetPinnedRepos())

	searches := cfg.GetSavedSearches()
	require.Len(t, searches, 3)
	assert.Equal(t, "s1", searches[0].GetId())
	assert.Equal(t, "s2", searches[1].GetId())
	assert.Equal(t, "new/repo", searches[2].GetName())
	assert.Equal(t, "repo:new/repo", searches[2].GetQuery())
}

// TestMigratePinnedRepos_Idempotent verifies that running MigratePinnedRepos on an already-migrated
// or empty config is a no-op returning false.
func TestMigratePinnedRepos_Idempotent(t *testing.T) {
	cfg := octodeckv1.Config_builder{
		PinnedRepos: []string{"owner/repo"},
	}.Build()

	// First run converts pins.
	assert.True(t, MigratePinnedRepos(cfg))
	require.Len(t, cfg.GetSavedSearches(), 1)

	// Second run is a no-op.
	assert.False(t, MigratePinnedRepos(cfg))
	require.Len(t, cfg.GetSavedSearches(), 1)

	// Nil config or empty config.
	assert.False(t, MigratePinnedRepos(nil))
	assert.False(t, MigratePinnedRepos(&octodeckv1.Config{}))
}

// TestMigratePinnedRepos_NoLimit verifies that MigratePinnedRepos does not enforce the 50-item limit.
func TestMigratePinnedRepos_NoLimit(t *testing.T) {
	pinned := make([]string, 60)
	for i := range pinned {
		pinned[i] = fmt.Sprintf("org/repo-%02d", i)
	}

	cfg := octodeckv1.Config_builder{PinnedRepos: pinned}.Build()
	changed := MigratePinnedRepos(cfg)
	assert.True(t, changed)
	assert.Empty(t, cfg.GetPinnedRepos())
	assert.Len(t, cfg.GetSavedSearches(), 60)
}

// TestBackupPinnedRepos verifies the backup file behavior: written once when pins exist, never
// overwritten, and skipped when no pins exist.
func TestBackupPinnedRepos(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	backupPath := configPath + PinnedReposBackupSuffix

	// Empty configPath or nil cfg or empty pins: no backup created.
	require.NoError(t, BackupPinnedRepos("", nil))
	require.NoError(t, BackupPinnedRepos(configPath, nil))
	require.NoError(t, BackupPinnedRepos(configPath, &octodeckv1.Config{}))
	_, err := os.Stat(backupPath)
	assert.True(t, os.IsNotExist(err))

	// Write dummy config file.
	initialData := []byte(`{"pinnedRepos": ["owner/repo"]}`)
	require.NoError(t, os.WriteFile(configPath, initialData, 0600))

	cfgWithPins := octodeckv1.Config_builder{PinnedRepos: []string{"owner/repo"}}.Build()
	require.NoError(t, BackupPinnedRepos(configPath, cfgWithPins))

	// Backup file should exist with initialData and mode 0600.
	stat, err := os.Stat(backupPath)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0600), stat.Mode().Perm())
	backupContent, err := os.ReadFile(backupPath)
	require.NoError(t, err)
	assert.Equal(t, initialData, backupContent)

	// Change config file and re-run: backup must NOT be overwritten.
	modifiedData := []byte(`{"pinnedRepos": ["other/repo"]}`)
	require.NoError(t, os.WriteFile(configPath, modifiedData, 0600))

	require.NoError(t, BackupPinnedRepos(configPath, cfgWithPins))
	backupContentAfter, err := os.ReadFile(backupPath)
	require.NoError(t, err)
	assert.Equal(t, initialData, backupContentAfter, "backup file must not be overwritten")
}
