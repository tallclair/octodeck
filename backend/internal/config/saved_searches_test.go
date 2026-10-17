package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// TestSavedSearches_ProtojsonRoundTrip verifies that saved searches survive protojson encoding.
func TestSavedSearches_ProtojsonRoundTrip(t *testing.T) {
	cfg := octodeckv1.Config_builder{
		SavedSearches: []*octodeckv1.SavedSearch{
			octodeckv1.SavedSearch_builder{
				Id:    Ptr("9f2c4e1a7b3d4c55a1e0f6b2d8c9e7a4"),
				Name:  Ptr("k8s bugs"),
				Query: Ptr("repo:kubernetes/kubernetes label:kind/bug is:open"),
			}.Build(),
			octodeckv1.SavedSearch_builder{
				Id:    Ptr("0b7d5a3e9c1f4e22b6a8d4c0e2f1a9b3"),
				Name:  Ptr("Acked PRs"),
				Query: Ptr("triage:acked type:pr"),
				Sort: octodeckv1.Sort_builder{
					Key:   octodeckv1.SortKey_SORT_KEY_ACKED.Enum(),
					Order: octodeckv1.SortOrder_SORT_ORDER_DESC.Enum(),
				}.Build(),
			}.Build(),
		},
	}.Build()

	data, err := protojson.Marshal(cfg)
	require.NoError(t, err)

	unmarshaled := &octodeckv1.Config{}
	err = protojson.Unmarshal(data, unmarshaled)
	require.NoError(t, err)

	assert.True(t, proto.Equal(cfg, unmarshaled), "protojson round trip must match original message")
}

// TestSavedSearches_NormalizeMissingAndDuplicateIDs tests ID repair during normalisation.
func TestSavedSearches_NormalizeMissingAndDuplicateIDs(t *testing.T) {
	raw := []*octodeckv1.SavedSearch{
		octodeckv1.SavedSearch_builder{
			Id:    Ptr("dup-id"),
			Name:  Ptr("First"),
			Query: Ptr("repo:a/b"),
		}.Build(),
		octodeckv1.SavedSearch_builder{
			Id:    Ptr(""),
			Name:  Ptr("Missing ID"),
			Query: Ptr("repo:c/d"),
		}.Build(),
		octodeckv1.SavedSearch_builder{
			Id:    Ptr("dup-id"),
			Name:  Ptr("Second duplicate"),
			Query: Ptr("repo:e/f"),
		}.Build(),
	}

	res := NormalizeSavedSearches(raw)
	require.Len(t, res, 3)

	assert.Equal(t, "dup-id", res[0].GetId(), "first occurrence must keep its ID")
	assert.NotEmpty(t, res[1].GetId(), "missing ID must be populated")
	assert.NotEqual(t, "dup-id", res[1].GetId())
	assert.NotEmpty(t, res[2].GetId(), "second duplicate must get a new ID")
	assert.NotEqual(t, "dup-id", res[2].GetId())
	assert.NotEqual(t, res[1].GetId(), res[2].GetId(), "new IDs must be distinct")
}

// TestSavedSearches_NormalizeEmptyQueryDropped tests dropping empty queries.
func TestSavedSearches_NormalizeEmptyQueryDropped(t *testing.T) {
	raw := []*octodeckv1.SavedSearch{
		octodeckv1.SavedSearch_builder{
			Name:  Ptr("Valid"),
			Query: Ptr("repo:a/b"),
		}.Build(),
		octodeckv1.SavedSearch_builder{
			Name:  Ptr("Empty query"),
			Query: Ptr("   "),
		}.Build(),
		nil,
	}

	res := NormalizeSavedSearches(raw)
	require.Len(t, res, 1)
	assert.Equal(t, "Valid", res[0].GetName())
}

// TestSavedSearches_NormalizeNameCleaning tests name control character replacement and fallback.
func TestSavedSearches_NormalizeNameCleaning(t *testing.T) {
	raw := []*octodeckv1.SavedSearch{
		octodeckv1.SavedSearch_builder{
			Name:  Ptr("Control\x00Chars\tHere"),
			Query: Ptr("repo:a/b"),
		}.Build(),
		octodeckv1.SavedSearch_builder{
			Name:  Ptr("\t\n"),
			Query: Ptr("repo:fallback/query"),
		}.Build(),
	}

	res := NormalizeSavedSearches(raw)
	require.Len(t, res, 2)
	assert.Equal(t, "Control Chars Here", res[0].GetName())
	assert.Equal(t, "repo:fallback/query", res[1].GetName(), "empty name must fall back to query")
}

// TestSavedSearches_NormalizeLongNameRuneSafe tests rune-safe name truncation.
func TestSavedSearches_NormalizeLongNameRuneSafe(t *testing.T) {
	// 85 runes of multi-byte Japanese characters.
	longName := strings.Repeat("日", 85)
	raw := []*octodeckv1.SavedSearch{
		octodeckv1.SavedSearch_builder{
			Name:  Ptr(longName),
			Query: Ptr("repo:a/b"),
		}.Build(),
	}

	res := NormalizeSavedSearches(raw)
	require.Len(t, res, 1)
	assert.Equal(t, strings.Repeat("日", MaxSavedSearchNameLen), res[0].GetName())
}

// TestSavedSearches_NormalizeDuplicatesAndLimitKept tests that duplicates and >50 entries are preserved.
func TestSavedSearches_NormalizeDuplicatesAndLimitKept(t *testing.T) {
	raw := make([]*octodeckv1.SavedSearch, 55)
	for i := range 55 {
		raw[i] = octodeckv1.SavedSearch_builder{
			Name:  Ptr("Duplicate Name"),
			Query: Ptr("repo:a/b"),
		}.Build()
	}

	res := NormalizeSavedSearches(raw)
	assert.Len(t, res, 55, "all 55 entries and duplicates must be kept")
}

// TestSavedSearches_HandEditedLoadSuccess tests loading a hand-edited well-formed protojson file.
func TestSavedSearches_HandEditedLoadSuccess(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.json")
	content := `{
  "savedSearches": [
    { "name": "No ID", "query": "repo:k/k" },
    { "id": "dup", "name": "First Dup", "query": "repo:a/b" },
    { "id": "dup", "name": "Second Dup", "query": "repo:c/d" },
    { "name": "Empty Query Dropped", "query": "   " }
  ]
}`
	err := os.WriteFile(configPath, []byte(content), 0600)
	require.NoError(t, err)

	cfg, err := Load(configPath, Overrides{})
	require.NoError(t, err, "well-formed hand-edited protojson must load without error")

	searches := cfg.GetSavedSearches()
	require.Len(t, searches, 3)
	assert.NotEmpty(t, searches[0].GetId())
	assert.Equal(t, "dup", searches[1].GetId())
	assert.NotEqual(t, "dup", searches[2].GetId())
}

// TestSavedSearches_HandEditedLoadMalformedFails tests that malformed protojson fails Load.
func TestSavedSearches_HandEditedLoadMalformedFails(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config_bad.json")
	// "query": 123 is a type mismatch in protojson.
	content := `{ "savedSearches": [ { "name": "Bad", "query": 123 } ] }`
	err := os.WriteFile(configPath, []byte(content), 0600)
	require.NoError(t, err)

	_, err = Load(configPath, Overrides{})
	require.Error(t, err, "malformed protojson must fail Load")
}

// TestSavedSearches_UpdateSavedSearchesRollbackOnWriteError tests in-memory rollback if disk write fails.
func TestSavedSearches_UpdateSavedSearchesRollbackOnWriteError(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("skipping test requiring non-root user for directory permission enforcement")
	}

	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.json")

	cfg, err := Load(configPath, Overrides{})
	require.NoError(t, err)

	initial, _, err := cfg.CreateSavedSearch(octodeckv1.SavedSearch_builder{
		Name:  Ptr("Initial"),
		Query: Ptr("repo:a/b"),
	}.Build())
	require.NoError(t, err)
	assert.Equal(t, "Initial", initial.GetName())

	// Make directory read-only so next write fails.
	err = os.Chmod(tempDir, 0500)
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.Chmod(tempDir, 0700) })

	_, _, err = cfg.CreateSavedSearch(octodeckv1.SavedSearch_builder{
		Name:  Ptr("Should Fail"),
		Query: Ptr("repo:c/d"),
	}.Build())
	require.Error(t, err, "write must fail in read-only directory")

	current := cfg.GetSavedSearches()
	require.Len(t, current, 1, "in-memory list must not change when write fails")
	assert.Equal(t, "Initial", current[0].GetName())
}

// TestSavedSearches_AtomicWriteLeavesNoTempFiles tests that atomic writing cleans up temp files.
func TestSavedSearches_AtomicWriteLeavesNoTempFiles(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.json")

	cfg, err := Load(configPath, Overrides{})
	require.NoError(t, err)

	_, _, err = cfg.CreateSavedSearch(octodeckv1.SavedSearch_builder{
		Name:  Ptr("First"),
		Query: Ptr("repo:a/b"),
	}.Build())
	require.NoError(t, err)

	entries, err := os.ReadDir(tempDir)
	require.NoError(t, err)
	for _, e := range entries {
		assert.NotContains(t, e.Name(), ".tmp-", "no temp files should remain: %s", e.Name())
	}
}

// TestSavedSearches_AtomicWriteCleanupOnFailure tests that temp files are cleaned up if Write, Sync, or Rename fails.
func TestSavedSearches_AtomicWriteCleanupOnFailure(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.json")

	// Create configPath as a directory so os.Rename fails (cannot overwrite directory with file).
	err := os.Mkdir(configPath, 0755)
	require.NoError(t, err)

	cfg, err := Load(filepath.Join(tempDir, "nonexistent.json"), Overrides{})
	require.NoError(t, err)
	cfg.path = configPath

	_, _, err = cfg.CreateSavedSearch(octodeckv1.SavedSearch_builder{
		Name:  Ptr("FailsOnRename"),
		Query: Ptr("repo:a/b"),
	}.Build())
	require.Error(t, err)

	entries, err := os.ReadDir(tempDir)
	require.NoError(t, err)
	for _, e := range entries {
		assert.NotContains(t, e.Name(), ".tmp-", "no temp files should remain after failure: %s", e.Name())
	}
}

// TestSavedSearches_GetSavedSearchesReturnsCopies tests deep copy semantics of GetSavedSearches.
func TestSavedSearches_GetSavedSearchesReturnsCopies(t *testing.T) {
	cfg := NewForTest(octodeckv1.Config_builder{
		SavedSearches: []*octodeckv1.SavedSearch{
			octodeckv1.SavedSearch_builder{
				Id:    Ptr("id-1"),
				Name:  Ptr("Original"),
				Query: Ptr("repo:a/b"),
			}.Build(),
		},
	}.Build())

	list := cfg.GetSavedSearches()
	require.Len(t, list, 1)

	// Mutate the returned message
	list[0].SetName("Mutated")

	fresh := cfg.GetSavedSearches()
	require.Len(t, fresh, 1)
	assert.Equal(t, "Original", fresh[0].GetName(), "mutating returned list must not affect config")
}

// TestSavedSearches_ValidationHelpers tests ValidateSavedSearchName and ValidateSavedSearchQuery.
func TestSavedSearches_ValidationHelpers(t *testing.T) {
	require.Error(t, ValidateSavedSearchName(""), "empty name")
	require.Error(t, ValidateSavedSearchName("   "), "whitespace name")
	require.Error(t, ValidateSavedSearchName("bad\nname"), "control characters in name")
	require.Error(t, ValidateSavedSearchName(strings.Repeat("a", MaxSavedSearchNameLen+1)), "name too long")
	require.NoError(t, ValidateSavedSearchName("valid name"))

	require.Error(t, ValidateSavedSearchQuery(""), "empty query")
	require.Error(t, ValidateSavedSearchQuery("   "), "whitespace query")
	require.Error(t, ValidateSavedSearchQuery("query\nwith break"), "line break in query")
	require.Error(t, ValidateSavedSearchQuery(strings.Repeat("q", MaxSavedSearchQueryLen+1)), "query too long")
	require.NoError(t, ValidateSavedSearchQuery("repo:a/b is:open"))
}

// TestSavedSearches_InListCRUDAndReorder tests per-operation list manipulation functions.
func TestSavedSearches_InListCRUDAndReorder(t *testing.T) {
	var list []*octodeckv1.SavedSearch

	// Create
	next, created, err := CreateSavedSearchInList(list, octodeckv1.SavedSearch_builder{
		Name:  Ptr("Search 1"),
		Query: Ptr("repo:a/b"),
	}.Build())
	require.NoError(t, err)
	require.Len(t, next, 1)
	id1 := created.GetId()

	// Duplicate name rejected
	_, _, err = CreateSavedSearchInList(next, octodeckv1.SavedSearch_builder{
		Name:  Ptr("search 1"),
		Query: Ptr("repo:c/d"),
	}.Build())
	require.ErrorIs(t, err, ErrSavedSearchNameTaken)

	// Create second
	next, created2, err := CreateSavedSearchInList(next, octodeckv1.SavedSearch_builder{
		Name:  Ptr("Search 2"),
		Query: Ptr("repo:c/d"),
	}.Build())
	require.NoError(t, err)
	id2 := created2.GetId()

	// Update name
	updated, err := UpdateSavedSearchInList(next, octodeckv1.SavedSearch_builder{
		Id:   &id1,
		Name: Ptr("Renamed 1"),
	}.Build(), &fieldmaskpb.FieldMask{Paths: []string{"name"}})
	require.NoError(t, err)
	assert.Equal(t, "Renamed 1", updated[0].GetName())

	// Update query
	const queryField = "query"
	updated, err = UpdateSavedSearchInList(updated, octodeckv1.SavedSearch_builder{
		Id:    &id1,
		Query: Ptr("repo:updated/query"),
	}.Build(), &fieldmaskpb.FieldMask{Paths: []string{queryField}})
	require.NoError(t, err)
	assert.Equal(t, "Renamed 1", updated[0].GetName())
	assert.Equal(t, "repo:updated/query", updated[0].GetQuery())

	// Update query invalid fails
	_, err = UpdateSavedSearchInList(updated, octodeckv1.SavedSearch_builder{
		Id:    &id1,
		Query: Ptr(""),
	}.Build(), &fieldmaskpb.FieldMask{Paths: []string{queryField}})
	require.ErrorIs(t, err, ErrSavedSearchInvalid)

	// Update query with full mask (nil)
	updated, err = UpdateSavedSearchInList(updated, octodeckv1.SavedSearch_builder{
		Id:    &id1,
		Name:  Ptr("Final 1"),
		Query: Ptr("repo:final/query"),
	}.Build(), nil)
	require.NoError(t, err)
	assert.Equal(t, "Final 1", updated[0].GetName())
	assert.Equal(t, "repo:final/query", updated[0].GetQuery())

	// Reorder
	reordered, err := ReorderSavedSearchesInList(updated, []string{id2, id1})
	require.NoError(t, err)
	assert.Equal(t, id2, reordered[0].GetId())
	assert.Equal(t, id1, reordered[1].GetId())

	// Reorder stale order error
	_, err = ReorderSavedSearchesInList(updated, []string{id2, "unknown"})
	require.ErrorIs(t, err, ErrSavedSearchStaleOrder)

	// Delete
	deleted, err := DeleteSavedSearchInList(reordered, id2)
	require.NoError(t, err)
	require.Len(t, deleted, 1)
	assert.Equal(t, id1, deleted[0].GetId())

	// Delete non-existent
	_, err = DeleteSavedSearchInList(deleted, "missing")
	require.ErrorIs(t, err, ErrSavedSearchNotFound)
}
