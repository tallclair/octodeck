package logic

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/github"
)

// mockCallTracker tracks calls to mock GraphQL operations for assertions.
type mockCallTracker struct {
	searchedQueries []string
	hydratedIDs     []string
	searchCalls     int
	fetchCalls      int
}

func mockHandleCandidateSearch(
	tracker *mockCallTracker,
	candidateMap map[string][]string,
	vars map[string]any,
	target any,
) error {
	tracker.searchCalls++
	queryStr := fmt.Sprint(vars["query"])
	tracker.searchedQueries = append(tracker.searchedQueries, queryStr)

	ids, exists := candidateMap[queryStr]
	if !exists {
		for baseQ, cIDs := range candidateMap {
			if strings.HasPrefix(queryStr, strings.TrimSpace(baseQ)) {
				ids = cIDs
				exists = true
				break
			}
		}
	}
	if !exists {
		return fmt.Errorf("unexpected query: %s", queryStr)
	}

	var nodes []map[string]any
	for _, id := range ids {
		nodes = append(nodes, map[string]any{
			"__typename": "PullRequest",
			"pullRequest": map[string]any{
				"id": id,
			},
		})
	}

	data, _ := json.Marshal(map[string]any{
		"search": map[string]any{
			"nodes": nodes,
			"pageInfo": map[string]any{
				"hasNextPage": false,
				"endCursor":   "",
			},
		},
	})
	return json.Unmarshal(data, target)
}

func mockHandleItemsFetch(
	tracker *mockCallTracker,
	nodeMap map[string]map[string]any,
	vars map[string]any,
	target any,
) error {
	tracker.fetchCalls++
	requestedIDs := vars["ids"].([]string)
	tracker.hydratedIDs = append(tracker.hydratedIDs, requestedIDs...)

	var nodes []any
	for _, id := range requestedIDs {
		if node, ok := nodeMap[id]; ok {
			nodes = append(nodes, node)
		} else {
			nodes = append(nodes, nil)
		}
	}

	data, _ := json.Marshal(map[string]any{
		"nodes": nodes,
	})
	return json.Unmarshal(data, target)
}

func setupMockDiscoveryEngine(
	t *testing.T,
	trackedQueries []string,
	excludedRepos []string,
	candidateMap map[string][]string,
	nodeMap map[string]map[string]any,
) (*SyncEngine, *database.DB, *mockCallTracker) {
	t.Helper()
	db := setupTestDB(t)

	tracker := &mockCallTracker{
		searchedQueries: make([]string, 0),
		hydratedIDs:     make([]string, 0),
	}

	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			switch name {
			case "SearchCandidateIDs":
				return mockHandleCandidateSearch(tracker, candidateMap, vars, q)
			case "ItemsFetch":
				return mockHandleItemsFetch(tracker, nodeMap, vars, q)
			default:
				return nil
			}
		},
	}

	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _ string, path string, _ io.Reader, response any) error {
			if path == "user" {
				data, _ := json.Marshal(map[string]any{"login": "testuser"})
				return json.Unmarshal(data, response)
			}
			return nil
		},
	}
	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL, CurrentUser: "testuser"}

	cfgData := octodeckv1.Config_builder{
		TrackedQueries: trackedQueries,
		ExcludedRepos:  excludedRepos,
		KnownBots:      []string{},
	}.Build()
	cfg := config.NewForTest(cfgData)

	engine := NewSyncEngine(db, ghClient, cfg)
	return engine, db, tracker
}

func mockPullRequestNode(id, repo string, number int32) map[string]any {
	return map[string]any{
		"__typename": "PullRequest",
		"pullRequest": map[string]any{
			"id":                 id,
			"repository":         map[string]any{"nameWithOwner": repo},
			"number":             number,
			"state":              "OPEN",
			"updatedAt":          "2026-09-04T00:00:00Z",
			"title":              fmt.Sprintf("Title for %s", id),
			"url":                fmt.Sprintf("https://github.com/%s/pull/%d", repo, number),
			"author":             map[string]any{"login": "external-author"},
			"comments":           map[string]any{"nodes": []any{}},
			"assignees":          map[string]any{"nodes": []any{}},
			"commits":            map[string]any{"nodes": []any{}},
			"viewerSubscription": "UNSUBSCRIBED",
			"timelineItems":      map[string]any{"nodes": []any{}},
		},
	}
}

func TestRunDiscovery_NoTrackedQueries(t *testing.T) {
	engine, db, tracker := setupMockDiscoveryEngine(t, nil, nil, nil, nil)
	defer func() { require.NoError(t, db.Close()) }()

	err := engine.RunDiscovery(t.Context())
	require.NoError(t, err)

	assert.Equal(t, 0, tracker.searchCalls, "expected 0 search calls when no queries configured")
	assert.Equal(t, 0, tracker.fetchCalls, "expected 0 fetch calls when no queries configured")

	traces, err := db.GetSyncTraces(t.Context(), 10, "")
	require.NoError(t, err)
	assert.Empty(t, traces, "expected no sync trace when no queries configured")
}

func TestRunDiscovery_DiscoversNewItemsAndSavesInitialSnapshot(t *testing.T) {
	const query = "repo:kubernetes/kubernetes is:open label:sig-node"
	candidates := map[string][]string{
		query: {"PR_CANDIDATE_1", "PR_CANDIDATE_2"},
	}
	nodes := map[string]map[string]any{
		"PR_CANDIDATE_1": mockPullRequestNode("PR_CANDIDATE_1", "kubernetes/kubernetes", 101),
		"PR_CANDIDATE_2": mockPullRequestNode("PR_CANDIDATE_2", "kubernetes/kubernetes", 102),
	}

	engine, db, tracker := setupMockDiscoveryEngine(t, []string{query}, nil, candidates, nodes)
	defer func() { require.NoError(t, db.Close()) }()

	err := engine.RunDiscovery(t.Context())
	require.NoError(t, err)

	assert.Equal(t, 1, tracker.searchCalls)
	assert.Equal(t, 1, tracker.fetchCalls)
	assert.Equal(t, []string{"PR_CANDIDATE_1", "PR_CANDIDATE_2"}, tracker.hydratedIDs)

	// Verify items stored in SQLite
	items, err := db.GetItems(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, items, 2)

	assert.Equal(t, octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED, items[0].GetViewerSubscription())
	assert.Equal(t, octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED, items[1].GetViewerSubscription())
	assert.NotNil(t, items[0].GetLastSyncedAt())
	assert.Empty(t, items[0].GetLocal().GetSyncError())

	// Verify sync trace
	traces, err := db.GetSyncTraces(t.Context(), 10, traceTypeDiscovery)
	require.NoError(t, err)
	require.Len(t, traces, 1)

	assert.Equal(t, traceTypeDiscovery, traces[0].TraceType)
	assert.Equal(t, int64(2), traces[0].ItemsFetched)
	assert.Equal(t, int64(2), traces[0].ItemsPersisted)

	// Verify decompressed payload
	decompressed, err := database.DecompressPayload(traces[0].RawPayloadCompressed)
	require.NoError(t, err)

	var payload DiscoverySyncPayload
	require.NoError(t, json.Unmarshal(decompressed, &payload))
	assert.Equal(t, 1, payload.QueriesCount)
	assert.Equal(t, 2, payload.CandidatesFound)
	assert.Equal(t, 0, payload.KnownSkippedCount)
	assert.Equal(t, 2, payload.UniqueNewCount)
	assert.Equal(t, 2, payload.HydratedCount)
}

func TestRunDiscovery_InMemoryDeduplication_SkipsKnownSQLiteItems(t *testing.T) {
	const query = "repo:kubernetes/kubernetes is:open label:sig-node"

	candidates := map[string][]string{
		query: {"PR_KNOWN_1", "PR_NEW_2"},
	}
	nodes := map[string]map[string]any{
		"PR_NEW_2": mockPullRequestNode("PR_NEW_2", "kubernetes/kubernetes", 202),
	}

	engine, db, tracker := setupMockDiscoveryEngine(t, []string{query}, nil, candidates, nodes)
	defer func() { require.NoError(t, db.Close()) }()

	// Pre-seed PR_KNOWN_1 into SQLite
	preExistingItem := octodeckv1.Item_builder{
		Id:                 config.Ptr("PR_KNOWN_1"),
		Repo:               config.Ptr("kubernetes/kubernetes"),
		Number:             config.Ptr(int32(201)),
		State:              config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		ViewerSubscription: config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED),
	}.Build()
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{preExistingItem}))

	err := engine.RunDiscovery(t.Context())
	require.NoError(t, err)

	// PR_KNOWN_1 must be skipped in memory, ONLY PR_NEW_2 hydrated!
	assert.Equal(t, 1, tracker.searchCalls)
	assert.Equal(t, 1, tracker.fetchCalls)
	assert.Equal(t, []string{"PR_NEW_2"}, tracker.hydratedIDs, "PR_KNOWN_1 must not be hydrated")

	// Trace verification
	traces, err := db.GetSyncTraces(t.Context(), 1, traceTypeDiscovery)
	require.NoError(t, err)
	decompressed, err := database.DecompressPayload(traces[0].RawPayloadCompressed)
	require.NoError(t, err)

	var payload DiscoverySyncPayload
	require.NoError(t, json.Unmarshal(decompressed, &payload))
	assert.Equal(t, 2, payload.CandidatesFound)
	assert.Equal(t, 1, payload.KnownSkippedCount)
	assert.Equal(t, 1, payload.UniqueNewCount)
}

func TestRunDiscovery_SubsequentRunSkipsAllHydration(t *testing.T) {
	const query = "repo:kubernetes/kubernetes is:open label:sig-node"
	candidates := map[string][]string{
		query: {"PR_ITEM_1", "PR_ITEM_2"},
	}
	nodes := map[string]map[string]any{
		"PR_ITEM_1": mockPullRequestNode("PR_ITEM_1", "kubernetes/kubernetes", 301),
		"PR_ITEM_2": mockPullRequestNode("PR_ITEM_2", "kubernetes/kubernetes", 302),
	}

	engine, db, tracker := setupMockDiscoveryEngine(t, []string{query}, nil, candidates, nodes)
	defer func() { require.NoError(t, db.Close()) }()

	// First run: hydrates both items
	require.NoError(t, engine.RunDiscovery(t.Context()))
	assert.Equal(t, 1, tracker.fetchCalls)
	assert.Len(t, tracker.hydratedIDs, 2)

	// Second run: both items are now in SQLite
	require.NoError(t, engine.RunDiscovery(t.Context()))
	assert.Equal(t, 1, tracker.fetchCalls, "fetchCalls must not increment on second run")
	assert.Len(t, tracker.hydratedIDs, 2, "hydratedIDs must not receive duplicate entries")
}

func TestRunDiscovery_MultiQueryDeduplication(t *testing.T) {
	query1 := "repo:kubernetes/kubernetes label:bug"
	query2 := "repo:kubernetes/kubernetes label:backend"

	// "PR_SHARED" appears in both search query results
	candidates := map[string][]string{
		query1: {"PR_1", "PR_SHARED"},
		query2: {"PR_SHARED", "PR_3"},
	}
	nodes := map[string]map[string]any{
		"PR_1":      mockPullRequestNode("PR_1", "kubernetes/kubernetes", 401),
		"PR_SHARED": mockPullRequestNode("PR_SHARED", "kubernetes/kubernetes", 402),
		"PR_3":      mockPullRequestNode("PR_3", "kubernetes/kubernetes", 403),
	}

	engine, db, tracker := setupMockDiscoveryEngine(t, []string{query1, query2}, nil, candidates, nodes)
	defer func() { require.NoError(t, db.Close()) }()

	err := engine.RunDiscovery(t.Context())
	require.NoError(t, err)

	assert.Equal(t, 2, tracker.searchCalls)
	assert.Equal(t, 1, tracker.fetchCalls)
	assert.Equal(t, []string{"PR_1", "PR_SHARED", "PR_3"}, tracker.hydratedIDs)

	items, err := db.GetItems(t.Context(), nil)
	require.NoError(t, err)
	assert.Len(t, items, 3, "expected exactly 3 items saved")
}

func TestRunDiscovery_PartialQueryFailureResilience(t *testing.T) {
	queryBad := "repo:kubernetes/kubernetes invalid:syntax"
	queryGood := "repo:kubernetes/kubernetes label:good"

	candidates := map[string][]string{
		queryGood: {"PR_VALID_1"},
	}
	nodes := map[string]map[string]any{
		"PR_VALID_1": mockPullRequestNode("PR_VALID_1", "kubernetes/kubernetes", 501),
	}

	engine, db, tracker := setupMockDiscoveryEngine(t, []string{queryBad, queryGood}, nil, candidates, nodes)
	defer func() { require.NoError(t, db.Close()) }()

	err := engine.RunDiscovery(t.Context())
	// Should report the partial error from queryBad
	require.Error(t, err)
	assert.Contains(t, err.Error(), queryBad)

	// But queryGood should have succeeded and saved PR_VALID_1!
	assert.Equal(t, []string{"PR_VALID_1"}, tracker.hydratedIDs)
	items, err := db.GetItems(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, "PR_VALID_1", items[0].GetId())
}

func TestRunDiscovery_ExcludedRepoFiltering(t *testing.T) {
	query := "is:open label:sig-node"
	candidates := map[string][]string{
		query: {"PR_ALLOWED", "PR_EXCLUDED"},
	}
	nodes := map[string]map[string]any{
		"PR_ALLOWED":  mockPullRequestNode("PR_ALLOWED", "kubernetes/kubernetes", 601),
		"PR_EXCLUDED": mockPullRequestNode("PR_EXCLUDED", "kubernetes/legacy-repo", 602),
	}

	engine, db, tracker := setupMockDiscoveryEngine(
		t,
		[]string{query},
		[]string{"kubernetes/legacy-repo"}, // Excluded repo
		candidates,
		nodes,
	)
	defer func() { require.NoError(t, db.Close()) }()

	err := engine.RunDiscovery(t.Context())
	require.NoError(t, err)

	assert.Equal(t, 1, tracker.searchCalls)
	assert.Equal(t, 1, tracker.fetchCalls)
	assert.Equal(t, []string{"PR_ALLOWED", "PR_EXCLUDED"}, tracker.hydratedIDs)

	items, err := db.GetItems(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, "PR_ALLOWED", items[0].GetId())
}

func TestRunDiscovery_ContextCanceled(t *testing.T) {
	query := "repo:kubernetes/kubernetes is:open"
	candidates := map[string][]string{
		query: {"PR_CANDIDATE_1"},
	}
	nodes := map[string]map[string]any{
		"PR_CANDIDATE_1": mockPullRequestNode("PR_CANDIDATE_1", "kubernetes/kubernetes", 701),
	}

	engine, db, _ := setupMockDiscoveryEngine(t, []string{query}, nil, candidates, nodes)
	defer func() { require.NoError(t, db.Close()) }()

	ctx, cancel := context.WithCancel(t.Context())
	cancel() // Cancel context immediately

	err := engine.RunDiscovery(ctx)
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
}

func TestRunDiscovery_InjectsUpdatedFilterWithBuffer(t *testing.T) {
	const baseQuery = "repo:kubernetes/kubernetes is:open label:sig-node"
	candidates := map[string][]string{
		baseQuery: {"PR_CANDIDATE_1"},
	}
	nodes := map[string]map[string]any{
		"PR_CANDIDATE_1": mockPullRequestNode("PR_CANDIDATE_1", "kubernetes/kubernetes", 801),
	}

	engine, db, tracker := setupMockDiscoveryEngine(t, []string{baseQuery}, nil, candidates, nodes)
	defer func() { require.NoError(t, db.Close()) }()

	// Seed cursor to an explicit time in the past
	pastTime := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	require.NoError(t, db.SetDiscoveryCursor(t.Context(), baseQuery, pastTime))

	err := engine.RunDiscovery(t.Context())
	require.NoError(t, err)

	require.Len(t, tracker.searchedQueries, 1)
	expectedSince := pastTime.Add(-DiscoveryIndexingBuffer).UTC().Format("2006-01-02T15:04:05Z")
	expectedQuery := fmt.Sprintf("%s updated:>%s", baseQuery, expectedSince)
	assert.Equal(t, expectedQuery, tracker.searchedQueries[0])

	// Cursor should have advanced to a recent time
	cursor, exists, err := db.GetDiscoveryCursor(t.Context(), baseQuery)
	require.NoError(t, err)
	assert.True(t, exists)
	assert.True(t, cursor.After(pastTime), "cursor should advance past the initial timestamp")
}

func TestRunDiscovery_NoBackfill_SeedsCursorOnAdd(t *testing.T) {
	const query = "repo:kubernetes/kubernetes is:open label:sig-auth"
	candidates := map[string][]string{
		query: {"PR_AUTH_1"},
	}
	nodes := map[string]map[string]any{
		"PR_AUTH_1": mockPullRequestNode("PR_AUTH_1", "kubernetes/kubernetes", 802),
	}

	engine, db, tracker := setupMockDiscoveryEngine(t, []string{query}, nil, candidates, nodes)
	defer func() { require.NoError(t, db.Close()) }()

	// Ensure no cursor exists initially
	_, exists, err := db.GetDiscoveryCursor(t.Context(), query)
	require.NoError(t, err)
	assert.False(t, exists, "cursor should not exist before discovery runs")

	beforeRun := time.Now().UTC()
	err = engine.RunDiscovery(t.Context())
	require.NoError(t, err)

	// Verify cursor was seeded and updated
	cursor, exists, err := db.GetDiscoveryCursor(t.Context(), query)
	require.NoError(t, err)
	assert.True(t, exists, "cursor should be seeded during run")
	assert.True(t, cursor.After(beforeRun.Add(-2*time.Second)), "cursor should reflect current time, not historical")

	// Verify that the query sent had an updated:> filter
	require.Len(t, tracker.searchedQueries, 1)
	assert.Contains(t, tracker.searchedQueries[0], "updated:>")
}
