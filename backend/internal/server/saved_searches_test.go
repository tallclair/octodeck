package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/api/octodeck/v1/octodeckv1connect"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
)

type savedSearchTestEnv struct {
	client     octodeckv1connect.OctoDeckServiceClient
	addHeaders func(connect.AnyRequest)
	cfg        *config.Config
}

func setupSavedSearchTest(t *testing.T, cfg *config.Config) *savedSearchTestEnv {
	t.Helper()
	db, err := database.Init(t.Context(), database.InMemoryDSN)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	if cfg == nil {
		cfg = config.NewForTest(octodeckv1.Config_builder{}.Build())
	}
	s := New(db, &mockGitHubClient{authenticated: true}, &mockSyncEngine{}, cfg, nil)
	code, err := s.auth.GenerateCode()
	require.NoError(t, err)
	token, err := s.auth.ExchangeCode(t.Context(), code)
	require.NoError(t, err)

	ts := httptest.NewServer(s.router)
	t.Cleanup(ts.Close)

	client := octodeckv1connect.NewOctoDeckServiceClient(http.DefaultClient, ts.URL+"/api/v1")
	addHeaders := func(req connect.AnyRequest) {
		req.Header().Set("Origin", "chrome-extension://"+config.DevExtensionID)
		req.Header().Set("Authorization", "Bearer "+token)
	}

	return &savedSearchTestEnv{
		client:     client,
		addHeaders: addHeaders,
		cfg:        cfg,
	}
}

// TestSavedSearches_FieldValidationErrors tests invalid input errors for name and query.
func TestSavedSearches_FieldValidationErrors(t *testing.T) {
	env := setupSavedSearchTest(t, nil)

	testCases := []struct {
		name  string
		input *octodeckv1.SavedSearch
		code  connect.Code
	}{
		{
			name:  "empty name",
			input: octodeckv1.SavedSearch_builder{Name: config.Ptr(""), Query: config.Ptr("repo:a/b")}.Build(),
			code:  connect.CodeInvalidArgument,
		},
		{
			name:  "whitespace name",
			input: octodeckv1.SavedSearch_builder{Name: config.Ptr("   "), Query: config.Ptr("repo:a/b")}.Build(),
			code:  connect.CodeInvalidArgument,
		},
		{
			name:  "control character in name",
			input: octodeckv1.SavedSearch_builder{Name: config.Ptr("bad\nname"), Query: config.Ptr("repo:a/b")}.Build(),
			code:  connect.CodeInvalidArgument,
		},
		{
			name: "name too long",
			input: octodeckv1.SavedSearch_builder{
				Name:  config.Ptr(strings.Repeat("a", config.MaxSavedSearchNameLen+1)),
				Query: config.Ptr("repo:a/b"),
			}.Build(),
			code: connect.CodeInvalidArgument,
		},
		{
			name:  "empty query",
			input: octodeckv1.SavedSearch_builder{Name: config.Ptr("valid"), Query: config.Ptr("")}.Build(),
			code:  connect.CodeInvalidArgument,
		},
		{
			name: "query with newline",
			input: octodeckv1.SavedSearch_builder{
				Name:  config.Ptr("valid"),
				Query: config.Ptr("repo:a/b\nis:open"),
			}.Build(),
			code: connect.CodeInvalidArgument,
		},
		{
			name: "query too long",
			input: octodeckv1.SavedSearch_builder{
				Name:  config.Ptr("valid"),
				Query: config.Ptr(strings.Repeat("q", config.MaxSavedSearchQueryLen+1)),
			}.Build(),
			code: connect.CodeInvalidArgument,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			req := connect.NewRequest(octodeckv1.CreateSavedSearchRequest_builder{
				SavedSearch: tc.input,
			}.Build())
			env.addHeaders(req)
			_, err := env.client.CreateSavedSearch(t.Context(), req)
			require.Error(t, err)
			assert.Equal(t, tc.code, connect.CodeOf(err))
		})
	}
}

// TestSavedSearches_CreateSuccessAndDuplicates tests creation, duplicate check, and ID generation.
func TestSavedSearches_CreateSuccessAndDuplicates(t *testing.T) {
	env := setupSavedSearchTest(t, nil)

	oddQuery := "   repo:kubernetes/kubernetes   label:\"kind/bug\"  weird:?#%  "
	req := connect.NewRequest(octodeckv1.CreateSavedSearchRequest_builder{
		SavedSearch: octodeckv1.SavedSearch_builder{
			Name:  config.Ptr("K8s Bugs"),
			Query: &oddQuery,
		}.Build(),
	}.Build())
	env.addHeaders(req)
	resp, err := env.client.CreateSavedSearch(t.Context(), req)
	require.NoError(t, err)

	created := resp.Msg.GetSavedSearch()
	assert.NotEmpty(t, created.GetId())
	assert.Equal(t, "K8s Bugs", created.GetName())
	assert.Equal(t, oddQuery, created.GetQuery(), "query must be stored byte-for-byte")

	require.Len(t, resp.Msg.GetSavedSearches(), 1)
	assert.Equal(t, created.GetId(), resp.Msg.GetSavedSearches()[0].GetId())

	// Duplicate name rejected case-insensitively
	dupReq := connect.NewRequest(octodeckv1.CreateSavedSearchRequest_builder{
		SavedSearch: octodeckv1.SavedSearch_builder{
			Name:  config.Ptr("k8s bugs"),
			Query: config.Ptr("repo:other/repo"),
		}.Build(),
	}.Build())
	env.addHeaders(dupReq)
	_, err = env.client.CreateSavedSearch(t.Context(), dupReq)
	require.Error(t, err)
	assert.Equal(t, connect.CodeAlreadyExists, connect.CodeOf(err))

	// Visible through GetConfig
	cfgReq := connect.NewRequest(octodeckv1.GetConfigRequest_builder{}.Build())
	env.addHeaders(cfgReq)
	cfgResp, err := env.client.GetConfig(t.Context(), cfgReq)
	require.NoError(t, err)
	require.Len(t, cfgResp.Msg.GetConfig().GetSavedSearches(), 1)
	assert.Equal(t, created.GetId(), cfgResp.Msg.GetConfig().GetSavedSearches()[0].GetId())
}

// TestSavedSearches_LimitReached tests that creating the 51st search fails with ResourceExhausted.
func TestSavedSearches_LimitReached(t *testing.T) {
	searches := make([]*octodeckv1.SavedSearch, config.MaxSavedSearches)
	for i := range config.MaxSavedSearches {
		searches[i] = octodeckv1.SavedSearch_builder{
			Id:    config.Ptr(fmt.Sprintf("id-%02d", i)),
			Name:  config.Ptr(fmt.Sprintf("Search %d", i)),
			Query: config.Ptr("repo:a/b"),
		}.Build()
	}
	cfg := config.NewForTest(octodeckv1.Config_builder{SavedSearches: searches}.Build())
	env := setupSavedSearchTest(t, cfg)

	req := connect.NewRequest(octodeckv1.CreateSavedSearchRequest_builder{
		SavedSearch: octodeckv1.SavedSearch_builder{
			Name:  config.Ptr("51st Search"),
			Query: config.Ptr("repo:a/b"),
		}.Build(),
	}.Build())
	env.addHeaders(req)
	_, err := env.client.CreateSavedSearch(t.Context(), req)
	require.Error(t, err)
	assert.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err))
}

// TestSavedSearches_UpdateSavedSearch tests updating name and sort, mask handling, and errors.
func TestSavedSearches_UpdateSavedSearch(t *testing.T) {
	initial := []*octodeckv1.SavedSearch{
		octodeckv1.SavedSearch_builder{
			Id:    config.Ptr("s1"),
			Name:  config.Ptr("Original"),
			Query: config.Ptr("repo:a/b"),
			Sort: octodeckv1.Sort_builder{
				Key:   octodeckv1.SortKey_SORT_KEY_ACKED.Enum(),
				Order: octodeckv1.SortOrder_SORT_ORDER_DESC.Enum(),
			}.Build(),
		}.Build(),
		octodeckv1.SavedSearch_builder{
			Id:    config.Ptr("s2"),
			Name:  config.Ptr("Other"),
			Query: config.Ptr("repo:c/d"),
		}.Build(),
	}
	cfg := config.NewForTest(octodeckv1.Config_builder{SavedSearches: initial}.Build())
	env := setupSavedSearchTest(t, cfg)

	// Update name only with mask "name"
	reqName := connect.NewRequest(octodeckv1.UpdateSavedSearchRequest_builder{
		SavedSearch: octodeckv1.SavedSearch_builder{
			Id:   config.Ptr("s1"),
			Name: config.Ptr("Renamed"),
		}.Build(),
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"name"}},
	}.Build())
	env.addHeaders(reqName)
	respName, err := env.client.UpdateSavedSearch(t.Context(), reqName)
	require.NoError(t, err)
	assert.Equal(t, "Renamed", respName.Msg.GetSavedSearches()[0].GetName())
	assert.True(t, respName.Msg.GetSavedSearches()[0].HasSort(), "sort must be preserved when not in mask")

	// Update sort to unset resets to default
	reqSort := connect.NewRequest(octodeckv1.UpdateSavedSearchRequest_builder{
		SavedSearch: octodeckv1.SavedSearch_builder{Id: config.Ptr("s1")}.Build(),
		UpdateMask:  &fieldmaskpb.FieldMask{Paths: []string{"sort"}},
	}.Build())
	env.addHeaders(reqSort)
	respSort, err := env.client.UpdateSavedSearch(t.Context(), reqSort)
	require.NoError(t, err)
	assert.False(t, respSort.Msg.GetSavedSearches()[0].HasSort(), "unset sort must clear stored sort")

	// Renaming to already used name fails with AlreadyExists
	reqDup := connect.NewRequest(octodeckv1.UpdateSavedSearchRequest_builder{
		SavedSearch: octodeckv1.SavedSearch_builder{
			Id:   config.Ptr("s1"),
			Name: config.Ptr("Other"),
		}.Build(),
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"name"}},
	}.Build())
	env.addHeaders(reqDup)
	_, err = env.client.UpdateSavedSearch(t.Context(), reqDup)
	require.Error(t, err)
	assert.Equal(t, connect.CodeAlreadyExists, connect.CodeOf(err))

	// Update query
	reqQuery := connect.NewRequest(octodeckv1.UpdateSavedSearchRequest_builder{
		SavedSearch: octodeckv1.SavedSearch_builder{
			Id:    config.Ptr("s1"),
			Query: config.Ptr("repo:updated/query is:open"),
		}.Build(),
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"query"}},
	}.Build())
	env.addHeaders(reqQuery)
	respQuery, err := env.client.UpdateSavedSearch(t.Context(), reqQuery)
	require.NoError(t, err)
	assert.Equal(t, "repo:updated/query is:open", respQuery.Msg.GetSavedSearches()[0].GetQuery())
	assert.Equal(t, "Renamed", respQuery.Msg.GetSavedSearches()[0].GetName(), "name must be preserved when not in mask")

	// Invalid query returns InvalidArgument
	reqBadQuery := connect.NewRequest(octodeckv1.UpdateSavedSearchRequest_builder{
		SavedSearch: octodeckv1.SavedSearch_builder{
			Id:    config.Ptr("s1"),
			Query: config.Ptr(""),
		}.Build(),
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"query"}},
	}.Build())
	env.addHeaders(reqBadQuery)
	_, err = env.client.UpdateSavedSearch(t.Context(), reqBadQuery)
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))

	// Unknown ID fails with NotFound
	reqMissing := connect.NewRequest(octodeckv1.UpdateSavedSearchRequest_builder{
		SavedSearch: octodeckv1.SavedSearch_builder{Id: config.Ptr("missing")}.Build(),
	}.Build())
	env.addHeaders(reqMissing)
	_, err = env.client.UpdateSavedSearch(t.Context(), reqMissing)
	require.Error(t, err)
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))

	// Unsupported mask paths return InvalidArgument
	for _, badPath := range []string{"id", "unknown"} {
		reqBad := connect.NewRequest(octodeckv1.UpdateSavedSearchRequest_builder{
			SavedSearch: octodeckv1.SavedSearch_builder{Id: config.Ptr("s1")}.Build(),
			UpdateMask:  &fieldmaskpb.FieldMask{Paths: []string{badPath}},
		}.Build())
		env.addHeaders(reqBad)
		_, err = env.client.UpdateSavedSearch(t.Context(), reqBad)
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	}
}

// TestSavedSearches_DeleteSavedSearch tests deleting by ID and errors for missing IDs.
func TestSavedSearches_DeleteSavedSearch(t *testing.T) {
	initial := []*octodeckv1.SavedSearch{
		octodeckv1.SavedSearch_builder{
			Id:    config.Ptr("s1"),
			Name:  config.Ptr("First"),
			Query: config.Ptr("repo:a/b"),
		}.Build(),
	}
	cfg := config.NewForTest(octodeckv1.Config_builder{SavedSearches: initial}.Build())
	env := setupSavedSearchTest(t, cfg)

	// Missing ID fails with NotFound
	reqMissing := connect.NewRequest(octodeckv1.DeleteSavedSearchRequest_builder{
		Id: config.Ptr("missing"),
	}.Build())
	env.addHeaders(reqMissing)
	_, err := env.client.DeleteSavedSearch(t.Context(), reqMissing)
	require.Error(t, err)
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))

	// Delete existing succeeds
	reqDel := connect.NewRequest(octodeckv1.DeleteSavedSearchRequest_builder{
		Id: config.Ptr("s1"),
	}.Build())
	env.addHeaders(reqDel)
	resp, err := env.client.DeleteSavedSearch(t.Context(), reqDel)
	require.NoError(t, err)
	assert.Empty(t, resp.Msg.GetSavedSearches())
}

// TestSavedSearches_ReorderSavedSearches tests list ordering and permutation validation.
func TestSavedSearches_ReorderSavedSearches(t *testing.T) {
	initial := []*octodeckv1.SavedSearch{
		octodeckv1.SavedSearch_builder{
			Id: config.Ptr("s1"), Name: config.Ptr("A"), Query: config.Ptr("repo:a"),
		}.Build(),
		octodeckv1.SavedSearch_builder{
			Id: config.Ptr("s2"), Name: config.Ptr("B"), Query: config.Ptr("repo:b"),
		}.Build(),
		octodeckv1.SavedSearch_builder{
			Id: config.Ptr("s3"), Name: config.Ptr("C"), Query: config.Ptr("repo:c"),
		}.Build(),
	}
	cfg := config.NewForTest(octodeckv1.Config_builder{SavedSearches: initial}.Build())
	env := setupSavedSearchTest(t, cfg)

	// Successful reorder
	req := connect.NewRequest(octodeckv1.ReorderSavedSearchesRequest_builder{
		Ids: []string{"s3", "s1", "s2"},
	}.Build())
	env.addHeaders(req)
	resp, err := env.client.ReorderSavedSearches(t.Context(), req)
	require.NoError(t, err)
	require.Len(t, resp.Msg.GetSavedSearches(), 3)
	assert.Equal(t, "s3", resp.Msg.GetSavedSearches()[0].GetId())
	assert.Equal(t, "s1", resp.Msg.GetSavedSearches()[1].GetId())
	assert.Equal(t, "s2", resp.Msg.GetSavedSearches()[2].GetId())

	// Stale / invalid permutation errors
	badOrders := [][]string{
		{"s1", "s2"},             // missing ID
		{"s1", "s2", "s3", "s4"}, // extra ID
		{"s1", "s2", "s2"},       // duplicate ID
		{"s1", "s2", "missing"},  // unknown ID
	}
	for _, bad := range badOrders {
		reqBad := connect.NewRequest(octodeckv1.ReorderSavedSearchesRequest_builder{
			Ids: bad,
		}.Build())
		env.addHeaders(reqBad)
		_, err = env.client.ReorderSavedSearches(t.Context(), reqBad)
		require.Error(t, err)
		assert.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
	}
}

// TestSavedSearches_PerOperationValidationWithExistingViolations tests operations on loaded violations.
func TestSavedSearches_PerOperationValidationWithExistingViolations(t *testing.T) {
	// Start with 51 entries and two entries named "k8s".
	searches := make([]*octodeckv1.SavedSearch, 51)
	for i := range 51 {
		name := fmt.Sprintf("Search %d", i)
		if i == 0 || i == 1 {
			name = "k8s"
		}
		searches[i] = octodeckv1.SavedSearch_builder{
			Id:    config.Ptr(fmt.Sprintf("id-%02d", i)),
			Name:  &name,
			Query: config.Ptr("repo:a/b"),
		}.Build()
	}

	cfg := config.NewForTest(octodeckv1.Config_builder{SavedSearches: searches}.Build())
	env := setupSavedSearchTest(t, cfg)

	// 1. Create fails because list has 51 entries (> 50).
	reqCreate := connect.NewRequest(octodeckv1.CreateSavedSearchRequest_builder{
		SavedSearch: octodeckv1.SavedSearch_builder{Name: config.Ptr("New"), Query: config.Ptr("repo:x")}.Build(),
	}.Build())
	env.addHeaders(reqCreate)
	_, err := env.client.CreateSavedSearch(t.Context(), reqCreate)
	require.Error(t, err)
	assert.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err))

	// 2. Renaming one of the duplicate "k8s" entries to a free name succeeds.
	reqRename := connect.NewRequest(octodeckv1.UpdateSavedSearchRequest_builder{
		SavedSearch: octodeckv1.SavedSearch_builder{
			Id:   config.Ptr("id-00"),
			Name: config.Ptr("k8s-renamed"),
		}.Build(),
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"name"}},
	}.Build())
	env.addHeaders(reqRename)
	_, err = env.client.UpdateSavedSearch(t.Context(), reqRename)
	require.NoError(t, err)

	// 3. Reorder succeeds even with 51 entries.
	ids := make([]string, 51)
	for i := range 51 {
		ids[i] = fmt.Sprintf("id-%02d", 50-i)
	}
	reqReorder := connect.NewRequest(octodeckv1.ReorderSavedSearchesRequest_builder{
		Ids: ids,
	}.Build())
	env.addHeaders(reqReorder)
	_, err = env.client.ReorderSavedSearches(t.Context(), reqReorder)
	require.NoError(t, err)

	// 4. Delete succeeds.
	reqDel := connect.NewRequest(octodeckv1.DeleteSavedSearchRequest_builder{
		Id: config.Ptr("id-50"),
	}.Build())
	env.addHeaders(reqDel)
	respDel, err := env.client.DeleteSavedSearch(t.Context(), reqDel)
	require.NoError(t, err)
	assert.Len(t, respDel.Msg.GetSavedSearches(), 50)
}

// TestSavedSearches_ConcurrentCreatesPersist tests concurrent mutations from multiple goroutines
// and verifies persistence to disk.
func TestSavedSearches_ConcurrentCreatesPersist(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.json")
	cfg, err := config.Load(configPath, config.Overrides{})
	require.NoError(t, err)

	env := setupSavedSearchTest(t, cfg)

	const n = 10
	var wg sync.WaitGroup
	errs := make(chan error, n)

	for i := range n {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			req := connect.NewRequest(octodeckv1.CreateSavedSearchRequest_builder{
				SavedSearch: octodeckv1.SavedSearch_builder{
					Name:  config.Ptr(fmt.Sprintf("Concurrent %d", idx)),
					Query: config.Ptr(fmt.Sprintf("repo:org/repo-%d", idx)),
				}.Build(),
			}.Build())
			env.addHeaders(req)
			_, err := env.client.CreateSavedSearch(t.Context(), req)
			if err != nil {
				errs <- err
			}
		}(i)
	}

	wg.Wait()
	close(errs)

	for err := range errs {
		require.NoError(t, err)
	}

	cfgReq := connect.NewRequest(octodeckv1.GetConfigRequest_builder{}.Build())
	env.addHeaders(cfgReq)
	cfgResp, err := env.client.GetConfig(t.Context(), cfgReq)
	require.NoError(t, err)

	searches := cfgResp.Msg.GetConfig().GetSavedSearches()
	require.Len(t, searches, n)

	// Verify all mutations persisted to disk by loading from the config file.
	diskCfg, err := config.Load(configPath, config.Overrides{})
	require.NoError(t, err)
	require.Len(t, diskCfg.GetSavedSearches(), n)
}

// TestSavedSearches_DiskWriteErrorMapsToInternal tests mapping disk write failure to CodeInternal.
func TestSavedSearches_DiskWriteErrorMapsToInternal(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("skipping test requiring non-root user for directory permission enforcement")
	}

	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.json")
	cfg, err := config.Load(configPath, config.Overrides{})
	require.NoError(t, err)

	env := setupSavedSearchTest(t, cfg)

	// Make directory read-only so write fails
	err = os.Chmod(tempDir, 0500)
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.Chmod(tempDir, 0700) })

	req := connect.NewRequest(octodeckv1.CreateSavedSearchRequest_builder{
		SavedSearch: octodeckv1.SavedSearch_builder{
			Name:  config.Ptr("Will Fail"),
			Query: config.Ptr("repo:a/b"),
		}.Build(),
	}.Build())
	env.addHeaders(req)
	_, err = env.client.CreateSavedSearch(t.Context(), req)
	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))

	// Verify in-memory list remains empty
	cfgReq := connect.NewRequest(octodeckv1.GetConfigRequest_builder{}.Build())
	env.addHeaders(cfgReq)
	cfgResp, err := env.client.GetConfig(t.Context(), cfgReq)
	require.NoError(t, err)
	assert.Empty(t, cfgResp.Msg.GetConfig().GetSavedSearches())
}
