package logic

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/github"
)

// TestAdversarial_304NotModified_PreservesCursorAndZeroGQL verifies that 304 responses
// strictly make zero GraphQL calls, advance notification sync timestamps, preserve the
// Last-Modified header, and record compressed diagnostic traces.
func TestAdversarial_304NotModified_PreservesCursorAndZeroGQL(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	const initialLastMod = "Wed, 13 Aug 2026 12:00:00 GMT"
	require.NoError(t, db.SetMetadata(t.Context(), KeyLastNotificationModified, initialLastMod))
	require.NoError(t, db.SetMetadata(t.Context(), KeyLastNotificationSync, "2026-08-13T12:00:00Z"))

	var httpReqCount atomic.Int32
	var gqlCallCount atomic.Int32

	mockHTTP := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			httpReqCount.Add(1)
			assert.Equal(t, initialLastMod, req.Header.Get("If-Modified-Since"))
			return &http.Response{
				StatusCode: http.StatusNotModified,
				Header:     make(http.Header),
				Body:       io.NopCloser(bytes.NewReader(nil)),
			}, nil
		},
	}

	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _, path string, _ io.Reader, response any) error {
			if path == "user" {
				return json.Unmarshal([]byte(`{"login":"testuser"}`), response)
			}
			return nil
		},
	}

	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, _ string, _ any, _ map[string]any) error {
			gqlCallCount.Add(1)
			return errors.New("unexpected GraphQL invocation on 304")
		},
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL, HTTPClient: mockHTTP}
	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	err := engine.RunIncrementalSync(t.Context())
	require.NoError(t, err)

	assert.Equal(t, int32(1), httpReqCount.Load())
	assert.Equal(t, int32(0), gqlCallCount.Load(), "GraphQL must never be called on 304")

	// Verify metadata
	savedLastMod, err := db.GetMetadata(t.Context(), KeyLastNotificationModified)
	require.NoError(t, err)
	assert.Equal(t, initialLastMod, savedLastMod, "Last-Modified header must be preserved on 304")

	savedLastSync, err := db.GetMetadata(t.Context(), KeyLastNotificationSync)
	require.NoError(t, err)
	assert.NotEmpty(t, savedLastSync)

	// Verify trace payload
	traces, err := db.GetSyncTraces(t.Context(), 1, "notification_sync")
	require.NoError(t, err)
	require.Len(t, traces, 1)
	decompressed, err := database.DecompressPayload(traces[0].RawPayloadCompressed)
	require.NoError(t, err)
	var payload NotificationSyncPayload
	require.NoError(t, json.Unmarshal(decompressed, &payload))
	assert.Equal(t, http.StatusNotModified, payload.HTTPStatus)
	assert.Equal(t, initialLastMod, payload.LastModified)
	assert.Empty(t, payload.HydratedItems)
}

// TestAdversarial_ExclusionFiltering_StrictNoLeakage tests that excluded repos
// (including wildcard patterns and exact matches) never leak into Node ID resolution or hydration queries.
func TestAdversarial_ExclusionFiltering_StrictNoLeakage(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	notifJSON := `[
		{
			"id": "thread_excluded_1",
			"unread": true,
			"reason": "assign",
			"subject": {
				"title": "Excluded Repo Item",
				"type": "PullRequest",
				"url": "https://api.github.com/repos/kubernetes/test-infra/pulls/10"
			},
			"repository": {"full_name": "kubernetes/test-infra"}
		},
		{
			"id": "thread_excluded_wildcard",
			"unread": true,
			"reason": "mention",
			"subject": {
				"title": "Excluded Wildcard Item",
				"type": "Issue",
				"url": "https://api.github.com/repos/kubernetes-sigs/kind/issues/20"
			},
			"repository": {"full_name": "kubernetes-sigs/kind"}
		},
		{
			"id": "thread_included",
			"unread": true,
			"reason": "author",
			"subject": {
				"title": "Allowed Item",
				"type": "PullRequest",
				"url": "https://api.github.com/repos/kubernetes/kubernetes/pulls/30"
			},
			"repository": {"full_name": "kubernetes/kubernetes"}
		}
	]`

	resolveGQLJSON := `{"data": {"q0": {"issueOrPullRequest": {"id": "PR_node_allowed_30"}}}}`

	mockHTTP := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			if strings.Contains(req.URL.Path, "notifications") {
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(notifJSON)),
				}, nil
			}
			if strings.Contains(req.URL.Path, "graphql") {
				// Verify query does not contain test-infra or kind
				bodyBytes, _ := io.ReadAll(req.Body)
				reqStr := string(bodyBytes)
				assert.NotContains(t, reqStr, "test-infra", "Excluded repo must not appear in ResolveNodeIDs")
				assert.NotContains(t, reqStr, "kubernetes-sigs", "Wildcard repo must not appear in ResolveNodeIDs")
				assert.Contains(t, reqStr, "kubernetes", "Allowed repo must appear in ResolveNodeIDs")

				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(resolveGQLJSON)),
				}, nil
			}
			return nil, fmt.Errorf("unexpected HTTP request: %s", req.URL.Path)
		},
	}

	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _, path string, _ io.Reader, response any) error {
			if path == "user" {
				return json.Unmarshal([]byte(`{"login":"testuser"}`), response)
			}
			return nil
		},
	}

	var hydratedIDs []string
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			if name == "ItemsFetch" {
				ids := vars["ids"].([]string)
				hydratedIDs = append(hydratedIDs, ids...)
				prNode := makeMinimalPRNode("PR_node_allowed_30", 30, "Allowed PR Title")
				b, _ := json.Marshal(map[string]any{"nodes": []any{prNode}})
				return json.Unmarshal(b, q)
			}
			return nil
		},
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL, HTTPClient: mockHTTP}
	cfg := config.NewForTest(octodeckv1.Config_builder{
		ExcludedRepos: []string{"kubernetes/test-infra", "kubernetes-sigs/*"},
	}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	err := engine.RunIncrementalSync(t.Context())
	require.NoError(t, err)

	assert.Equal(t, []string{"PR_node_allowed_30"}, hydratedIDs)

	// Verify traces report filtered count = 2
	traces, err := db.GetSyncTraces(t.Context(), 1, "notification_sync")
	require.NoError(t, err)
	require.Len(t, traces, 1)
	decompressed, err := database.DecompressPayload(traces[0].RawPayloadCompressed)
	require.NoError(t, err)
	var payload NotificationSyncPayload
	require.NoError(t, json.Unmarshal(decompressed, &payload))
	assert.Equal(t, 2, payload.FilteredByRepoCount)
	assert.Equal(t, 3, payload.NotificationsCount)
	assert.Equal(t, 1, payload.ReasonsBreakdown["assign"])
	assert.Equal(t, 1, payload.ReasonsBreakdown["mention"])
	assert.Equal(t, 1, payload.ReasonsBreakdown["author"])
}

// TestAdversarial_RateLimitAndNetworkErrors_GracefulFailure verifies that rate limits (403/429)
// and network timeouts record failure status cleanly without corrupting state or crashing.
func TestAdversarial_RateLimitAndNetworkErrors_GracefulFailure(t *testing.T) {
	tests := []struct {
		name       string
		httpStatus int
		httpErr    error
		expectMsg  string
	}{
		{
			name:       "Rate limit 403 Forbidden",
			httpStatus: http.StatusForbidden,
			httpErr:    nil,
			expectMsg:  "status 403",
		},
		{
			name:       "Rate limit 429 Too Many Requests",
			httpStatus: http.StatusTooManyRequests,
			httpErr:    nil,
			expectMsg:  "status 429",
		},
		{
			name:       "Network timeout error",
			httpStatus: 0,
			httpErr:    context.DeadlineExceeded,
			expectMsg:  "context deadline exceeded",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			db := setupTestDB(t)
			defer func() { require.NoError(t, db.Close()) }()

			mockHTTP := &mockHTTPClient{
				doFunc: func(_ *http.Request) (*http.Response, error) {
					if tc.httpErr != nil {
						return nil, tc.httpErr
					}
					return &http.Response{
						StatusCode: tc.httpStatus,
						Header:     make(http.Header),
						Body:       io.NopCloser(strings.NewReader(`{"message":"API rate limit exceeded"}`)),
					}, nil
				},
			}

			mockREST := &mockRESTClient{
				doFunc: func(_ context.Context, _, path string, _ io.Reader, response any) error {
					if path == "user" {
						return json.Unmarshal([]byte(`{"login":"testuser"}`), response)
					}
					return nil
				},
			}

			ghClient := &github.Client{RestClient: mockREST, HTTPClient: mockHTTP}
			cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())
			engine := NewSyncEngine(db, ghClient, cfg)

			err := engine.RunIncrementalSync(t.Context())
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.expectMsg)

			// Verify status reflects failure
			status := engine.GetStatus()
			assert.True(t, status.GetLastSyncFailed())
			assert.Equal(t, int32(1), status.GetFailedAttemptsCount())
			assert.Contains(t, status.GetLastErrorMessage(), tc.expectMsg)

			// Verify failure trace was persisted
			traces, err := db.GetSyncTraces(t.Context(), 1, "notification_sync")
			require.NoError(t, err)
			require.Len(t, traces, 1)
			assert.Contains(t, traces[0].ErrorMessage, tc.expectMsg)
		})
	}
}

// TestAdversarial_PoisonPill_PartialResolutionAndMissingHydration verifies that
// unresolvable items and deleted (404) items record sync_error on DB records,
// log hydration errors in trace diagnostics, and allow other items to successfully persist.
func TestAdversarial_PoisonPill_PartialResolutionAndMissingHydration(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	// Seed existing item in DB that will become 404 (deleted on GitHub)
	deletedItem := octodeckv1.Item_builder{
		Id:     config.Ptr("PR_deleted_99"),
		Repo:   config.Ptr("kubernetes/kubernetes"),
		Number: config.Ptr(int32(99)),
		Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:  config.Ptr("Deleted Item"),
	}.Build()
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{deletedItem}))

	notifJSON := `[
		{
			"id": "thread_good",
			"unread": true,
			"reason": "mention",
			"subject": {
				"title": "Good Item",
				"type": "PullRequest",
				"url": "https://api.github.com/repos/kubernetes/kubernetes/pulls/1"
			},
			"repository": {"full_name": "kubernetes/kubernetes"}
		},
		{
			"id": "thread_unresolvable",
			"unread": true,
			"reason": "mention",
			"subject": {
				"title": "Unresolvable Nonexistent Item",
				"type": "Issue",
				"url": "https://api.github.com/repos/kubernetes/kubernetes/issues/999"
			},
			"repository": {"full_name": "kubernetes/kubernetes"}
		},
		{
			"id": "thread_deleted",
			"unread": true,
			"reason": "mention",
			"subject": {
				"title": "Deleted Item Notification",
				"type": "PullRequest",
				"url": "https://api.github.com/repos/kubernetes/kubernetes/pulls/99"
			},
			"repository": {"full_name": "kubernetes/kubernetes"}
		}
	]`

	resolveGQLJSON := `{
		"data": {
			"q0": {
				"issueOrPullRequest": {
					"id": "PR_node_good_1"
				}
			},
			"q1": {
				"issueOrPullRequest": null
			}
		}
	}`

	mockHTTP := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			if strings.Contains(req.URL.Path, "notifications") {
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(notifJSON)),
				}, nil
			}
			if strings.Contains(req.URL.Path, "graphql") {
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(resolveGQLJSON)),
				}, nil
			}
			return nil, fmt.Errorf("unexpected HTTP request: %s", req.URL.Path)
		},
	}

	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _, path string, _ io.Reader, response any) error {
			if path == "user" {
				return json.Unmarshal([]byte(`{"login":"testuser"}`), response)
			}
			return nil
		},
	}

	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			if name == "ItemsFetch" {
				ids := vars["ids"].([]string)
				nodes := make([]any, len(ids))
				for i, id := range ids {
					if id == "PR_node_good_1" {
						nodes[i] = makeMinimalPRNode("PR_node_good_1", 1, "Hydrated Good PR")
					} else {
						// PR_deleted_99 is not found on GitHub
						nodes[i] = nil
					}
				}
				b, _ := json.Marshal(map[string]any{"nodes": nodes})
				return json.Unmarshal(b, q)
			}
			return nil
		},
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL, HTTPClient: mockHTTP}
	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	err := engine.RunIncrementalSync(t.Context())
	require.NoError(t, err, "Incremental sync must not fail entirely when individual items fail")

	// Verify Good PR is saved
	goodItem, err := db.GetItem(t.Context(), "PR_node_good_1")
	require.NoError(t, err)
	assert.Equal(t, "Hydrated Good PR", goodItem.GetTitle())
	assert.Empty(t, goodItem.GetLocal().GetSyncError())

	// Verify Deleted PR has sync_error marked
	delItem, err := db.GetItem(t.Context(), "PR_deleted_99")
	require.NoError(t, err)
	assert.Contains(t, delItem.GetLocal().GetSyncError(), "404/deleted")

	// Verify unresolvable notification target is saved as a minimal stub item
	stubItem, err := db.GetItem(t.Context(), "kubernetes/kubernetes#999")
	require.NoError(t, err, "Unresolvable notification target must be saved as stub item")
	assert.Equal(t, "Notification: kubernetes/kubernetes#999", stubItem.GetTitle())
	assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW, stubItem.GetLocal().GetComputedStatus())
	assert.Contains(t, stubItem.GetLocal().GetSyncError(), "Failed to resolve GraphQL Node ID")

	// Verify trace diagnostics recorded both hydration errors
	traces, err := db.GetSyncTraces(t.Context(), 1, "notification_sync")
	require.NoError(t, err)
	require.Len(t, traces, 1)
	decompressed, err := database.DecompressPayload(traces[0].RawPayloadCompressed)
	require.NoError(t, err)
	var payload NotificationSyncPayload
	require.NoError(t, json.Unmarshal(decompressed, &payload))
	assert.Equal(t, "Failed to resolve GraphQL Node ID", payload.HydrationErrors["kubernetes/kubernetes#999"])
	assert.Contains(t, payload.HydrationErrors["PR_deleted_99"], "404/deleted")
}

// TestAdversarial_ColdStart_DeduplicationAndCursorInit verifies hybrid cold start
// inventory deduplication when search and notifications return overlapping items.
func TestAdversarial_ColdStart_DeduplicationAndCursorInit(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	notifJSON := `[
		{
			"id": "thread_overlap",
			"unread": true,
			"reason": "assign",
			"subject": {
				"title": "Overlap PR",
				"type": "PullRequest",
				"url": "https://api.github.com/repos/kubernetes/kubernetes/pulls/1"
			},
			"repository": {"full_name": "kubernetes/kubernetes"}
		}
	]`

	resolveGQLJSON := `{"data": {"q0": {"issueOrPullRequest": {"id": "PR_overlap_1"}}}}`

	mockHTTP := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			if strings.Contains(req.URL.Path, "notifications") {
				resp := &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(notifJSON)),
				}
				resp.Header.Set("Last-Modified", "Thu, 14 Aug 2026 05:00:00 GMT")
				return resp, nil
			}
			if strings.Contains(req.URL.Path, "graphql") {
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(resolveGQLJSON)),
				}, nil
			}
			return nil, fmt.Errorf("unexpected HTTP request: %s", req.URL.Path)
		},
	}

	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _, path string, _ io.Reader, response any) error {
			if path == "user" {
				return json.Unmarshal([]byte(`{"login":"testuser"}`), response)
			}
			return nil
		},
	}

	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, _ map[string]any) error {
			if name == inventoryQueryName {
				nodes := []map[string]any{
					makeMinimalPRNode("PR_overlap_1", 1, "Overlap Search PR"),
					makeMinimalPRNode("PR_search_only_2", 2, "Search Only PR"),
				}
				b, _ := json.Marshal(map[string]any{
					"search": map[string]any{
						"nodes":    nodes,
						"pageInfo": map[string]any{"hasNextPage": false},
					},
				})
				return json.Unmarshal(b, q)
			}
			if name == "ItemsFetch" {
				nodes := []any{
					makeMinimalPRNode("PR_overlap_1", 1, "Overlap Notification PR"),
				}
				b, _ := json.Marshal(map[string]any{"nodes": nodes})
				return json.Unmarshal(b, q)
			}
			return nil
		},
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL, HTTPClient: mockHTTP}
	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	err := engine.RunInventorySync(t.Context())
	require.NoError(t, err)

	items, err := db.GetItems(t.Context(), nil)
	require.NoError(t, err)
	assert.Len(t, items, 2, "Items must be deduplicated across inventory search and notifications")

	lastMod, err := db.GetMetadata(t.Context(), KeyLastNotificationModified)
	require.NoError(t, err)
	assert.Equal(t, "Thu, 14 Aug 2026 05:00:00 GMT", lastMod)

	lastNotifSync, err := db.GetMetadata(t.Context(), KeyLastNotificationSync)
	require.NoError(t, err)
	assert.NotEmpty(t, lastNotifSync)
}

func makeMinimalPRNode(id string, number int, title string) map[string]any {
	return map[string]any{
		"__typename": "PullRequest",
		"pullRequest": map[string]any{
			"id":         id,
			"repository": map[string]any{"nameWithOwner": "kubernetes/kubernetes"},
			"number":     number,
			"state":      "OPEN",
			"updatedAt":  time.Now().UTC().Format(time.RFC3339),
			"title":      title,
			"url":        fmt.Sprintf("https://github.com/kubernetes/kubernetes/pull/%d", number),
			"author":     map[string]any{"login": "testuser"},
			"comments":   map[string]any{"nodes": []any{}},
			"assignees":  map[string]any{"nodes": []any{}},
			"commits":    map[string]any{"nodes": []any{}},
		},
	}
}
