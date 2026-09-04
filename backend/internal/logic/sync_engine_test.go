package logic

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/github"
)

const inventoryQueryName = "InventorySearch"

type mockGraphQLClient struct {
	queryFunc  func(ctx context.Context, name string, q any, vars map[string]any) error
	mutateFunc func(ctx context.Context, name string, m any, vars map[string]any) error
}

func (m *mockGraphQLClient) QueryWithContext(ctx context.Context, name string, q any,
	vars map[string]any) error {
	if m.queryFunc != nil {
		return m.queryFunc(ctx, name, q, vars)
	}
	return nil
}

func (m *mockGraphQLClient) MutateWithContext(ctx context.Context, name string, mMut any,
	vars map[string]any) error {
	if m.mutateFunc != nil {
		return m.mutateFunc(ctx, name, mMut, vars)
	}
	return nil
}

type mockRESTClient struct {
	doFunc func(ctx context.Context, method string, path string, body io.Reader, response any) error
}

func (m *mockRESTClient) DoWithContext(ctx context.Context, method string, path string, body io.Reader,
	response any) error {
	if m.doFunc != nil {
		return m.doFunc(ctx, method, path, body, response)
	}
	return nil
}

type mockHTTPClient struct {
	doFunc func(req *http.Request) (*http.Response, error)
}

func (m *mockHTTPClient) Do(req *http.Request) (*http.Response, error) {
	if m.doFunc != nil {
		return m.doFunc(req)
	}
	return nil, errors.New("mockHTTPClient: doFunc not set")
}

func setupTestDB(t *testing.T) *database.DB {
	// Use in-memory SQLite
	db, err := database.Init(t.Context(), database.InMemoryDSN)
	require.NoError(t, err, "failed to init db")
	return db
}

func TestRunInventorySync_NewItem(t *testing.T) {
	const (
		expectedLogin = "testuser"
		expectedID    = "PR_GLOBAL_ID_1"
		expectedQuery = "is:open (assignee:@me OR author:@me) sort:updated-desc"
	)

	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	mockGQL := &mockGraphQLClient{}
	mockREST := &mockRESTClient{}

	mockGQL.queryFunc = func(_ context.Context, name string, q any, vars map[string]any) error {
		if name == inventoryQueryName {
			require.NotNil(t, vars["query"])
			queryStr := fmt.Sprint(vars["query"])
			var nodes []map[string]any

			// Check for combined query
			if queryStr == expectedQuery {
				nodes = []map[string]any{
					{
						"__typename": "PullRequest",
						"pullRequest": map[string]any{
							"id":         expectedID,
							"repository": map[string]any{"nameWithOwner": "owner/repo"},
							"number":     1,
							"state":      "OPEN",
							"updatedAt":  "2024-01-01T00:00:00Z",
							"title":      "Test PR",
							"url":        "http://test",
							"author":     map[string]any{"login": "author"},
							"comments":   map[string]any{"nodes": []any{}},
							"assignees":  map[string]any{"nodes": []any{}},
							"commits":    map[string]any{"nodes": []any{}},
						},
					},
				}
			} else {
				nodes = []map[string]any{}
			}

			jsonData, _ := json.Marshal(map[string]any{
				"search": map[string]any{
					"nodes": nodes,
					"pageInfo": map[string]any{
						"hasNextPage": false,
						"endCursor":   "cursor",
					},
				},
			})
			return json.Unmarshal(jsonData, q)
		}
		return nil
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL}
	cfg := config.NewForTest(octodeckv1.Config_builder{KnownBots: []string{}}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	err := engine.RunInventorySync(t.Context())
	require.NoError(t, err, "RunInventorySync failed")

	items, err := db.GetItems(t.Context(), nil)
	require.NoError(t, err, "GetItems failed")
	require.Len(t, items, 1, "expected 1 item")

	assert.Equal(t, expectedID, items[0].GetId())
	status := CalculateStatus(items[0], "", nil)
	assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW, status)
}

func TestRunIncrementalSync_304NotModified(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	// Seed previous sync timestamp and modified header
	lastMod := "Thu, 14 Aug 2026 01:00:00 GMT"
	require.NoError(t, db.SetMetadata(t.Context(), KeyLastNotificationModified, lastMod))
	require.NoError(t, db.SetMetadata(t.Context(), KeyLastNotificationSync, "2026-08-14T01:00:00Z"))

	var sentIfModifiedSince string
	mockHTTP := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			sentIfModifiedSince = req.Header.Get("If-Modified-Since")
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

	gqlCalled := false
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, _ string, _ any, _ map[string]any) error {
			gqlCalled = true
			return nil
		},
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL, HTTPClient: mockHTTP}
	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	err := engine.RunIncrementalSync(t.Context())
	require.NoError(t, err)

	assert.Equal(t, lastMod, sentIfModifiedSince, "If-Modified-Since header should match last_notification_modified")
	assert.False(t, gqlCalled, "Zero GraphQL queries should be made on HTTP 304")

	// Status and metadata should be updated
	status := engine.GetStatus()
	assert.True(t, status.HasLastSuccessfulSyncAt())
	assert.False(t, status.GetLastSyncFailed())

	// Verify trace recorded with 304 payload
	traces, err := db.GetSyncTraces(t.Context(), 10, "notification_sync")
	require.NoError(t, err)
	require.Len(t, traces, 1)
	assert.Equal(t, "notification_sync", traces[0].TraceType)
	assert.Equal(t, int64(0), traces[0].ItemsFetched)

	decompressed, err := database.DecompressPayload(traces[0].RawPayloadCompressed)
	require.NoError(t, err)
	var payload NotificationSyncPayload
	require.NoError(t, json.Unmarshal(decompressed, &payload))
	assert.Equal(t, http.StatusNotModified, payload.HTTPStatus)
	assert.Equal(t, lastMod, payload.LastModified)
	assert.Equal(t, 0, payload.NotificationsCount)
}

func TestRunIncrementalSync_200OK_HydrationAndTrace(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	notifJSON := `[
		{
			"id": "thread_1",
			"unread": true,
			"reason": "assign",
			"subject": {
				"title": "PR to be resolved and hydrated",
				"type": "PullRequest",
				"url": "https://api.github.com/repos/kubernetes/kubernetes/pulls/101"
			},
			"repository": {
				"full_name": "kubernetes/kubernetes"
			}
		}
	]`

	resolveGQLJSON := `{"data": {"q0": {"issueOrPullRequest": {"id": "PR_node_101"}}}}`

	mockHTTP := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			if strings.Contains(req.URL.Path, "notifications") {
				resp := &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(notifJSON)),
				}
				resp.Header.Set("Last-Modified", "Thu, 14 Aug 2026 02:00:00 GMT")
				return resp, nil
			}
			if strings.Contains(req.URL.Path, "graphql") {
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(resolveGQLJSON)),
				}, nil
			}
			return nil, fmt.Errorf("unexpected HTTP path: %s", req.URL.Path)
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

	var gqlFetchedIDs []string
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			if name == "ItemsFetch" {
				ids := vars["ids"].([]string)
				gqlFetchedIDs = append(gqlFetchedIDs, ids...)
				nodes := []any{
					map[string]any{
						"__typename": "PullRequest",
						"pullRequest": map[string]any{
							"id":         "PR_node_101",
							"repository": map[string]any{"nameWithOwner": "kubernetes/kubernetes"},
							"number":     101,
							"state":      "OPEN",
							"updatedAt":  "2026-08-14T02:00:00Z",
							"title":      "Hydrated PR 101",
							"url":        "https://github.com/kubernetes/kubernetes/pull/101",
							"author":     map[string]any{"login": "contributor"},
							"comments":   map[string]any{"nodes": []any{}},
							"assignees": map[string]any{
								"nodes": []any{map[string]any{"login": "testuser"}},
							},
							"commits":            map[string]any{"nodes": []any{}},
							"viewerSubscription": "SUBSCRIBED",
							"timelineItems": map[string]any{
								"nodes": []any{
									map[string]any{
										"__typename": "AssignedEvent",
										"assignedEvent": map[string]any{
											"createdAt": "2026-08-14T01:55:00Z",
											"actor":     map[string]any{"login": "reviewer"},
											"assignee": map[string]any{
												"user": map[string]any{
													"login": "testuser",
												},
											},
										},
									},
								},
							},
						},
					},
				}
				b, _ := json.Marshal(map[string]any{"nodes": nodes})
				return json.Unmarshal(b, q)
			}
			return nil
		},
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL, HTTPClient: mockHTTP}
	cfg := config.NewForTest(octodeckv1.Config_builder{KnownBots: []string{}}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	err := engine.RunIncrementalSync(t.Context())
	require.NoError(t, err)

	assert.Equal(t, []string{"PR_node_101"}, gqlFetchedIDs)

	// Item should be saved in DB
	saved, err := db.GetItem(t.Context(), "PR_node_101")
	require.NoError(t, err)
	assert.Equal(t, "Hydrated PR 101", saved.GetTitle())
	assert.Equal(t, octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED, saved.GetViewerSubscription())
	require.Len(t, saved.GetStateEvents(), 1)
	assert.Equal(t, octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED, saved.GetStateEvents()[0].GetType())

	// Status should be NEW for a freshly synced unread item
	status := CalculateStatus(saved, "testuser", nil)
	assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW, status)

	// Check cursors in DB
	lastModInDB, err := db.GetMetadata(t.Context(), KeyLastNotificationModified)
	require.NoError(t, err)
	assert.Equal(t, "Thu, 14 Aug 2026 02:00:00 GMT", lastModInDB)

	// Check trace
	traces, err := db.GetSyncTraces(t.Context(), 10, "notification_sync")
	require.NoError(t, err)
	require.Len(t, traces, 1)
	assert.Equal(t, int64(1), traces[0].ItemsFetched)
	assert.Equal(t, int64(1), traces[0].ItemsPersisted)

	decompressed, err := database.DecompressPayload(traces[0].RawPayloadCompressed)
	require.NoError(t, err)
	var payload NotificationSyncPayload
	require.NoError(t, json.Unmarshal(decompressed, &payload))
	assert.Equal(t, http.StatusOK, payload.HTTPStatus)
	assert.Equal(t, 1, payload.NotificationsCount)
	assert.Equal(t, 1, payload.ReasonsBreakdown["assign"])
	assert.Equal(t, []string{"PR_node_101"}, payload.HydratedItems)
}

func TestRunIncrementalSync_ExclusionFiltering(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	notifJSON := `[
		{
			"id": "thread_excluded",
			"unread": true,
			"reason": "mention",
			"subject": {
				"title": "Excluded Repo PR",
				"type": "PullRequest",
				"url": "https://api.github.com/repos/kubernetes/test-infra/pulls/1"
			},
			"repository": {"full_name": "kubernetes/test-infra"}
		},
		{
			"id": "thread_included",
			"unread": true,
			"reason": "mention",
			"subject": {
				"title": "Included Repo PR",
				"type": "PullRequest",
				"url": "https://api.github.com/repos/kubernetes/kubernetes/pulls/2"
			},
			"repository": {"full_name": "kubernetes/kubernetes"}
		}
	]`

	resolveGQLJSON := `{"data": {"q0": {"issueOrPullRequest": {"id": "PR_included_node_2"}}}}`

	var resolvedTargets []string
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
				b, _ := io.ReadAll(req.Body)
				resolvedTargets = append(resolvedTargets, string(b))
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(resolveGQLJSON)),
				}, nil
			}
			return nil, fmt.Errorf("unexpected HTTP path: %s", req.URL.Path)
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
				nodes := []any{
					map[string]any{
						"__typename": "PullRequest",
						"pullRequest": map[string]any{
							"id":         "PR_included_node_2",
							"repository": map[string]any{"nameWithOwner": "kubernetes/kubernetes"},
							"number":     2,
							"state":      "OPEN",
							"updatedAt":  "2026-08-14T02:00:00Z",
							"title":      "Included PR",
							"url":        "https://github.com/kubernetes/kubernetes/pull/2",
							"author":     map[string]any{"login": "contributor"},
							"comments":   map[string]any{"nodes": []any{}},
							"assignees":  map[string]any{"nodes": []any{}},
							"commits":    map[string]any{"nodes": []any{}},
						},
					},
				}
				b, _ := json.Marshal(map[string]any{"nodes": nodes})
				return json.Unmarshal(b, q)
			}
			return nil
		},
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL, HTTPClient: mockHTTP}
	cfg := config.NewForTest(octodeckv1.Config_builder{
		ExcludedRepos: []string{"kubernetes/test-infra"},
	}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	err := engine.RunIncrementalSync(t.Context())
	require.NoError(t, err)

	// Verify only kubernetes/kubernetes#2 was resolved, NOT test-infra
	require.Len(t, resolvedTargets, 1)
	assert.Contains(t, resolvedTargets[0], "kubernetes")
	assert.NotContains(t, resolvedTargets[0], "test-infra")

	// Verify trace payload recorded filtered repo count
	traces, err := db.GetSyncTraces(t.Context(), 10, "notification_sync")
	require.NoError(t, err)
	require.Len(t, traces, 1)

	decompressed, err := database.DecompressPayload(traces[0].RawPayloadCompressed)
	require.NoError(t, err)
	var payload NotificationSyncPayload
	require.NoError(t, json.Unmarshal(decompressed, &payload))
	assert.Equal(t, 1, payload.FilteredByRepoCount)
	assert.Equal(t, 2, payload.NotificationsCount)
	assert.Equal(t, []string{"PR_included_node_2"}, payload.HydratedItems)
}

func TestRunIncrementalSync_UnsupportedTypes(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	notifJSON := `[
		{
			"id": "thread_rel",
			"unread": true,
			"reason": "subscribed",
			"subject": {
				"title": "Release v1.31.0",
				"type": "Release",
				"url": "https://api.github.com/repos/kubernetes/kubernetes/releases/1"
			},
			"repository": {"full_name": "kubernetes/kubernetes"}
		},
		{
			"id": "thread_disc",
			"unread": false,
			"reason": "subscribed",
			"subject": {
				"title": "Q3 Roadmap Discussion",
				"type": "Discussion",
				"url": "https://api.github.com/repos/kubernetes/kubernetes/discussions/2"
			},
			"repository": {"full_name": "kubernetes/kubernetes"}
		}
	]`

	mockHTTP := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			if strings.Contains(req.URL.Path, "notifications") {
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(notifJSON)),
				}, nil
			}
			return nil, fmt.Errorf("unexpected HTTP path: %s", req.URL.Path)
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

	gqlCalled := false
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, _ string, _ any, _ map[string]any) error {
			gqlCalled = true
			return nil
		},
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL, HTTPClient: mockHTTP}
	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	err := engine.RunIncrementalSync(t.Context())
	require.NoError(t, err)
	assert.False(t, gqlCalled, "No GraphQL queries should be executed for unsupported notification types")

	traces, err := db.GetSyncTraces(t.Context(), 10, "notification_sync")
	require.NoError(t, err)
	require.Len(t, traces, 1)

	decompressed, err := database.DecompressPayload(traces[0].RawPayloadCompressed)
	require.NoError(t, err)
	var payload NotificationSyncPayload
	require.NoError(t, json.Unmarshal(decompressed, &payload))
	assert.Equal(t, 2, payload.NotificationsCount)
	assert.Equal(t, 1, payload.UnsupportedTypes["Release"])
	assert.Equal(t, 1, payload.UnsupportedTypes["Discussion"])
	assert.Empty(t, payload.HydratedItems)
}

func TestRunInventorySync_HybridColdStart(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	notifJSON := `[
		{
			"id": "thread_notif_1",
			"unread": true,
			"reason": "mention",
			"subject": {
				"title": "Notification Mention Issue",
				"type": "Issue",
				"url": "https://api.github.com/repos/kubernetes/kubernetes/issues/50"
			},
			"repository": {"full_name": "kubernetes/kubernetes"}
		}
	]`

	resolveGQLJSON := `{"data": {"q0": {"issueOrPullRequest": {"id": "ISSUE_node_50"}}}}`

	mockHTTP := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			if strings.Contains(req.URL.Path, "notifications") {
				resp := &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(notifJSON)),
				}
				resp.Header.Set("Last-Modified", "Thu, 14 Aug 2026 03:00:00 GMT")
				return resp, nil
			}
			if strings.Contains(req.URL.Path, "graphql") {
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(resolveGQLJSON)),
				}, nil
			}
			return nil, fmt.Errorf("unexpected HTTP path: %s", req.URL.Path)
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
			if name == inventoryQueryName {
				nodes := []any{
					map[string]any{
						"__typename": "PullRequest",
						"pullRequest": map[string]any{
							"id":         "PR_search_1",
							"repository": map[string]any{"nameWithOwner": "kubernetes/kubernetes"},
							"number":     1,
							"state":      "OPEN",
							"updatedAt":  "2026-08-14T01:00:00Z",
							"title":      "Search PR 1",
							"url":        "https://github.com/kubernetes/kubernetes/pull/1",
							"author":     map[string]any{"login": "testuser"},
							"comments":   map[string]any{"nodes": []any{}},
							"assignees":  map[string]any{"nodes": []any{}},
							"commits":    map[string]any{"nodes": []any{}},
						},
					},
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
					map[string]any{
						"__typename": "Issue",
						"issue": map[string]any{
							"id":         "ISSUE_node_50",
							"repository": map[string]any{"nameWithOwner": "kubernetes/kubernetes"},
							"number":     50,
							"state":      "OPEN",
							"updatedAt":  "2026-08-14T03:00:00Z",
							"title":      "Notification Mention Issue",
							"url":        "https://github.com/kubernetes/kubernetes/issues/50",
							"author":     map[string]any{"login": "external_author"},
							"comments":   map[string]any{"nodes": []any{}},
							"assignees":  map[string]any{"nodes": []any{}},
						},
					},
				}
				b, _ := json.Marshal(map[string]any{"nodes": nodes})
				return json.Unmarshal(b, q)
			}
			return nil
		},
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL, HTTPClient: mockHTTP}
	cfg := config.NewForTest(octodeckv1.Config_builder{KnownBots: []string{}}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	err := engine.RunInventorySync(t.Context())
	require.NoError(t, err)

	// Verify both items (from search and from notifications) are in DB
	items, err := db.GetItems(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, items, 2)

	itemMap := make(map[string]*octodeckv1.Item)
	for _, it := range items {
		itemMap[it.GetId()] = it
	}
	assert.Contains(t, itemMap, "PR_search_1")
	assert.Contains(t, itemMap, "ISSUE_node_50")

	// Verify metadata cursors initialized
	lastMod, err := db.GetMetadata(t.Context(), KeyLastNotificationModified)
	require.NoError(t, err)
	assert.Equal(t, "Thu, 14 Aug 2026 03:00:00 GMT", lastMod)

	lastNotifSync, err := db.GetMetadata(t.Context(), KeyLastNotificationSync)
	require.NoError(t, err)
	assert.NotEmpty(t, lastNotifSync)

	lastIncSync, err := db.GetMetadata(t.Context(), KeyLastIncSync)
	require.NoError(t, err)
	assert.NotEmpty(t, lastIncSync)
}

func TestForceSync(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	require.NoError(t, db.SetMetadata(t.Context(), KeyLastNotificationModified, "Cached-Header"))
	require.NoError(t, db.SetMetadata(t.Context(), KeyLastNotificationSync, "2026-08-14T01:00:00Z"))

	var receivedIfModSince string
	mockHTTP := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			receivedIfModSince = req.Header.Get("If-Modified-Since")
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("[]")),
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

	err := engine.ForceSync(t.Context())
	require.NoError(t, err)

	// Force sync must bypass If-Modified-Since header
	assert.Empty(t, receivedIfModSince, "ForceSync should bypass If-Modified-Since conditional caching")

	traces, err := db.GetSyncTraces(t.Context(), 10, "notification_sync")
	require.NoError(t, err)
	require.Len(t, traces, 1)
	assert.Equal(t, "force_sync", traces[0].TriggerSource)
}

func TestRunGarbageCollection(t *testing.T) {
	const (
		idStaleFound   = "ISSUE_1_GLOBAL_ID"
		idFresh        = "ISSUE_2_GLOBAL_ID"
		idStaleDeleted = "ISSUE_3_GLOBAL_ID"
		idStaleStarred = "ISSUE_4_GLOBAL_ID"
		idStaleNoted   = "ISSUE_5_GLOBAL_ID"
		repoName       = "owner/repo"
		expectedLogin  = "testuser"
	)

	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	staleTime := time.Now().Add(-31 * 24 * time.Hour)
	freshTime := time.Now()

	// 1. Stale Found (should be kept and updated)
	staleFound := octodeckv1.Item_builder{
		Id:           config.Ptr(idStaleFound),
		Repo:         config.Ptr(repoName),
		Number:       config.Ptr(int32(1)),
		Type:         config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:        config.Ptr("Stale Found"),
		State:        config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		UpdatedAt:    timestamppb.New(staleTime),
		LastSyncedAt: timestamppb.New(staleTime),
		Author:       octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Local:        octodeckv1.ItemLocalState_builder{}.Build(),
	}.Build()
	// 2. Fresh (should be ignored by GC)
	fresh := octodeckv1.Item_builder{
		Id:           config.Ptr(idFresh),
		Repo:         config.Ptr(repoName),
		Number:       config.Ptr(int32(2)),
		Type:         config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:        config.Ptr("Fresh"),
		State:        config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		UpdatedAt:    timestamppb.New(freshTime),
		LastSyncedAt: timestamppb.New(freshTime),
		Author:       octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Local:        octodeckv1.ItemLocalState_builder{}.Build(),
	}.Build()
	// 3. Stale Deleted (should be removed)
	staleDeleted := octodeckv1.Item_builder{
		Id:           config.Ptr(idStaleDeleted),
		Repo:         config.Ptr(repoName),
		Number:       config.Ptr(int32(3)),
		Type:         config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:        config.Ptr("Stale Deleted"),
		State:        config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		UpdatedAt:    timestamppb.New(staleTime),
		LastSyncedAt: timestamppb.New(staleTime),
		Author:       octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Local:        octodeckv1.ItemLocalState_builder{}.Build(),
	}.Build()
	// 4. Stale Starred (should be protected by sync_error and LastSyncedAt updated)
	staleStarred := octodeckv1.Item_builder{
		Id:           config.Ptr(idStaleStarred),
		Repo:         config.Ptr(repoName),
		Number:       config.Ptr(int32(4)),
		Type:         config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:        config.Ptr("Stale Starred"),
		State:        config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		UpdatedAt:    timestamppb.New(staleTime),
		LastSyncedAt: timestamppb.New(staleTime),
		Author:       octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Local:        octodeckv1.ItemLocalState_builder{Starred: config.Ptr(true)}.Build(),
	}.Build()
	// 5. Stale Noted (should be protected by sync_error and LastSyncedAt updated)
	staleNoted := octodeckv1.Item_builder{
		Id:           config.Ptr(idStaleNoted),
		Repo:         config.Ptr(repoName),
		Number:       config.Ptr(int32(5)),
		Type:         config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:        config.Ptr("Stale Noted"),
		State:        config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		UpdatedAt:    timestamppb.New(staleTime),
		LastSyncedAt: timestamppb.New(staleTime),
		Author:       octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Local:        octodeckv1.ItemLocalState_builder{PrivateNotes: config.Ptr("Important bug")}.Build(),
	}.Build()

	err := db.SaveItems(t.Context(), []*octodeckv1.Item{staleFound, fresh, staleDeleted, staleStarred, staleNoted})
	require.NoError(t, err, "failed to save setup items")

	mockREST := &mockRESTClient{}
	mockGQL := &mockGraphQLClient{}
	mockGQL.queryFunc = func(_ context.Context, name string, q any, vars map[string]any) error {
		if name == "ItemsFetch" {
			ids, ok := vars["ids"].([]string)
			require.True(t, ok)
			var nodes []any

			for _, id := range ids {
				switch id {
				case idStaleFound:
					nodes = append(nodes, map[string]any{
						"__typename": "Issue",
						"issue": map[string]any{
							"id":         idStaleFound,
							"repository": map[string]any{"nameWithOwner": repoName},
							"number":     1,
							"state":      "OPEN",
							"updatedAt":  time.Now().Format(time.RFC3339), // Just updated
							"title":      "Stale Found",
							"url":        "http://test/1",
							"author":     map[string]any{"login": "author"},
							"comments":   map[string]any{"nodes": []any{}},
							"assignees":  map[string]any{"nodes": []any{}},
						},
					})
				case idStaleDeleted, idStaleStarred, idStaleNoted:
					// Return null for deleted/missing items
					nodes = append(nodes, nil)
				case idFresh:
					assert.Failf(t, "GC requested fresh item ID %s", idFresh)
				}
			}

			jsonData, _ := json.Marshal(map[string]any{
				"nodes": nodes,
			})
			return json.Unmarshal(jsonData, q)
		}
		return nil
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL}
	cfg := config.NewForTest(octodeckv1.Config_builder{KnownBots: []string{}}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	err = engine.RunGarbageCollection(t.Context())
	require.NoError(t, err, "RunGarbageCollection failed")

	// Verify DB state
	items, err := db.GetItems(t.Context(), nil)
	require.NoError(t, err, "GetItems failed")

	itemMap := make(map[string]*octodeckv1.Item)
	for _, i := range items {
		itemMap[i.GetId()] = i
	}

	// 1. Stale Found
	if item, ok := itemMap[idStaleFound]; !ok {
		assert.Fail(t, "StaleFound item missing from DB")
	} else {
		assert.True(t, item.GetLastSyncedAt().AsTime().After(freshTime), "StaleFound item LastSyncedAt was not updated")
	}

	// 2. Fresh
	assert.Contains(t, itemMap, idFresh, "Fresh item missing from DB")

	// 3. Stale Deleted
	assert.NotContains(t, itemMap, idStaleDeleted, "StaleDeleted item still in DB")

	// 4. Stale Starred
	if item, ok := itemMap[idStaleStarred]; !ok {
		assert.Fail(t, "StaleStarred item missing from DB")
	} else {
		assert.Contains(t, item.GetLocal().GetSyncError(), "404", "StaleStarred missing sync_error")
		assert.True(t, item.GetLastSyncedAt().AsTime().After(freshTime), "StaleStarred LastSyncedAt was not updated")
	}

	// 5. Stale Noted
	if item, ok := itemMap[idStaleNoted]; !ok {
		assert.Fail(t, "StaleNoted item missing from DB")
	} else {
		assert.Contains(t, item.GetLocal().GetSyncError(), "404", "StaleNoted missing sync_error")
		assert.True(t, item.GetLastSyncedAt().AsTime().After(freshTime), "StaleNoted LastSyncedAt was not updated")
	}
}

func TestRunGarbageCollection_RetentionPruning(t *testing.T) {
	const (
		idPrune       = "PRUNE_ME_ID"
		repoName      = "owner/repo"
		expectedLogin = "testuser"
	)

	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	oldTime := time.Now().Add(-91 * 24 * time.Hour)

	// Item that should be pruned (closed and old)
	toPrune := octodeckv1.Item_builder{
		Id:           config.Ptr(idPrune),
		Repo:         config.Ptr(repoName),
		Number:       config.Ptr(int32(1)),
		Type:         config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:        config.Ptr("Prune Me"),
		State:        config.Ptr(octodeckv1.ItemState_ITEM_STATE_CLOSED),
		UpdatedAt:    timestamppb.New(oldTime),
		LastSyncedAt: timestamppb.New(oldTime),
		Author:       octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Local:        octodeckv1.ItemLocalState_builder{}.Build(),
	}.Build()

	err := db.SaveItems(t.Context(), []*octodeckv1.Item{toPrune})
	require.NoError(t, err)

	mockREST := &mockRESTClient{}
	mockGQL := &mockGraphQLClient{}
	// No stale items for drift check (they are CLOSED, GetStaleItems only returns OPEN)
	mockGQL.queryFunc = func(_ context.Context, name string, q any, _ map[string]any) error {
		if name == "ItemsFetch" {
			return json.Unmarshal([]byte(`{"nodes": []}`), q)
		}
		return nil
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL}
	cfg := config.NewForTest(octodeckv1.Config_builder{KnownBots: []string{}}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	err = engine.RunGarbageCollection(t.Context())
	require.NoError(t, err)

	items, err := db.GetItems(t.Context(), nil)
	require.NoError(t, err)
	assert.Empty(t, items, "Expected item to be pruned")
}

func TestMergeComments_UpdatesEditedCommentInPlace(t *testing.T) {
	t1 := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 1, 2, 10, 0, 0, 0, time.UTC)

	existing := []*octodeckv1.Comment{
		octodeckv1.Comment_builder{
			CommentId: config.Ptr(int64(101)),
			BodyText:  config.Ptr("Original comment 101"),
			CreatedAt: timestamppb.New(t1),
			Author:    octodeckv1.User_builder{Login: config.Ptr("author1")}.Build(),
		}.Build(),
		octodeckv1.Comment_builder{
			CommentId: config.Ptr(int64(102)),
			BodyText:  config.Ptr("Original comment 102"),
			CreatedAt: timestamppb.New(t2),
			Author:    octodeckv1.User_builder{Login: config.Ptr("author2")}.Build(),
		}.Build(),
	}

	fetched := []*octodeckv1.Comment{
		// Comment 102 was edited
		octodeckv1.Comment_builder{
			CommentId: config.Ptr(int64(102)),
			BodyText:  config.Ptr("Edited comment 102"),
			CreatedAt: timestamppb.New(t2),
			Author:    octodeckv1.User_builder{Login: config.Ptr("author2")}.Build(),
		}.Build(),
		// New comment 103
		octodeckv1.Comment_builder{
			CommentId: config.Ptr(int64(103)),
			BodyText:  config.Ptr("New comment 103"),
			CreatedAt: timestamppb.New(t2.Add(time.Hour)),
			Author:    octodeckv1.User_builder{Login: config.Ptr("author3")}.Build(),
		}.Build(),
	}

	merged := mergeComments(existing, fetched)
	require.Len(t, merged, 3)
	assert.Equal(t, int64(101), merged[0].GetCommentId())
	assert.Equal(t, "Original comment 101", merged[0].GetBodyText())
	assert.Equal(t, int64(102), merged[1].GetCommentId())
	assert.Equal(t, "Edited comment 102", merged[1].GetBodyText())
	assert.Equal(t, int64(103), merged[2].GetCommentId())
	assert.Equal(t, "New comment 103", merged[2].GetBodyText())
}

func TestMergeReviews(t *testing.T) {
	t1 := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 1, 2, 10, 0, 0, 0, time.UTC)
	t3 := time.Date(2026, 1, 3, 10, 0, 0, 0, time.UTC)

	existing := []*octodeckv1.Review{
		octodeckv1.Review_builder{
			SubmittedAt: timestamppb.New(t1),
			State:       config.Ptr("COMMENTED"),
			Author:      octodeckv1.User_builder{Login: config.Ptr("reviewer1")}.Build(),
		}.Build(),
		octodeckv1.Review_builder{
			Url:         config.Ptr("https://github.com/owner/repo/pull/1#pullrequestreview-2"),
			SubmittedAt: timestamppb.New(t2),
			State:       config.Ptr("CHANGES_REQUESTED"),
			Body:        config.Ptr("Old review body"),
			Author:      octodeckv1.User_builder{Login: config.Ptr("reviewer2")}.Build(),
			Comments: []*octodeckv1.ReviewComment{
				octodeckv1.ReviewComment_builder{
					Id:   config.Ptr("PRRC_1"),
					Body: config.Ptr("Old code comment"),
				}.Build(),
			},
		}.Build(),
	}

	fetched := []*octodeckv1.Review{
		// Updated review t2 (edited review body and edited review comment)
		octodeckv1.Review_builder{
			Url:         config.Ptr("https://github.com/owner/repo/pull/1#pullrequestreview-2"),
			SubmittedAt: timestamppb.New(t2),
			State:       config.Ptr("CHANGES_REQUESTED"),
			Body:        config.Ptr("Edited review body"),
			Author:      octodeckv1.User_builder{Login: config.Ptr("reviewer2")}.Build(),
			Comments: []*octodeckv1.ReviewComment{
				octodeckv1.ReviewComment_builder{
					Id:   config.Ptr("PRRC_1"),
					Body: config.Ptr("Edited code comment"),
				}.Build(),
			},
		}.Build(),
		// New review t3
		octodeckv1.Review_builder{
			SubmittedAt: timestamppb.New(t3),
			State:       config.Ptr("APPROVED"),
			Author:      octodeckv1.User_builder{Login: config.Ptr("reviewer2")}.Build(),
		}.Build(),
	}

	merged := mergeReviews(existing, fetched)
	require.Len(t, merged, 3)
	assert.Equal(t, "COMMENTED", merged[0].GetState())
	assert.Equal(t, "reviewer1", merged[0].GetAuthor().GetLogin())
	assert.Equal(t, "CHANGES_REQUESTED", merged[1].GetState())
	assert.Equal(t, "reviewer2", merged[1].GetAuthor().GetLogin())
	assert.Equal(t, "Edited review body", merged[1].GetBody())
	require.Len(t, merged[1].GetComments(), 1)
	assert.Equal(t, "Edited code comment", merged[1].GetComments()[0].GetBody())
	assert.Equal(t, "APPROVED", merged[2].GetState())
	assert.Equal(t, "reviewer2", merged[2].GetAuthor().GetLogin())
}

func TestProcessItems_PreservesAndMergesReviews(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	t1 := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 1, 2, 10, 0, 0, 0, time.UTC)

	// Seed existing item with review 1
	existingItem := octodeckv1.Item_builder{
		Id:        config.Ptr("PR_1"),
		Repo:      config.Ptr("owner/repo"),
		Number:    config.Ptr(int32(1)),
		Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:     config.Ptr("Test PR"),
		State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		UpdatedAt: timestamppb.New(t1),
		Author:    octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Reviews: []*octodeckv1.Review{
			octodeckv1.Review_builder{
				SubmittedAt: timestamppb.New(t1),
				State:       config.Ptr("COMMENTED"),
				Author:      octodeckv1.User_builder{Login: config.Ptr("rev1")}.Build(),
			}.Build(),
		},
		Local: octodeckv1.ItemLocalState_builder{
			LastViewedAt: timestamppb.New(t1),
		}.Build(),
	}.Build()

	err := db.SaveItems(t.Context(), []*octodeckv1.Item{existingItem})
	require.NoError(t, err)

	// Process newly fetched item with review 2
	fetchedItem := octodeckv1.Item_builder{
		Id:        config.Ptr("PR_1"),
		Repo:      config.Ptr("owner/repo"),
		Number:    config.Ptr(int32(1)),
		Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:     config.Ptr("Test PR"),
		State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		UpdatedAt: timestamppb.New(t2),
		Author:    octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Reviews: []*octodeckv1.Review{
			octodeckv1.Review_builder{
				SubmittedAt: timestamppb.New(t2),
				State:       config.Ptr("APPROVED"),
				Author:      octodeckv1.User_builder{Login: config.Ptr("rev2")}.Build(),
			}.Build(),
		},
	}.Build()

	engine := NewSyncEngine(db, nil, config.NewForTest(octodeckv1.Config_builder{}.Build()))
	err = engine.processItems(t.Context(), []*octodeckv1.Item{fetchedItem})
	require.NoError(t, err)

	// Verify item in DB has both reviews and preserved local state
	saved, err := db.GetItem(t.Context(), "PR_1")
	require.NoError(t, err)
	require.Len(t, saved.GetReviews(), 2)
	assert.Equal(t, "COMMENTED", saved.GetReviews()[0].GetState())
	assert.Equal(t, "rev1", saved.GetReviews()[0].GetAuthor().GetLogin())
	assert.Equal(t, "APPROVED", saved.GetReviews()[1].GetState())
	assert.Equal(t, "rev2", saved.GetReviews()[1].GetAuthor().GetLogin())
	assert.Equal(t, t1.Unix(), saved.GetLocal().GetLastViewedAt().GetSeconds())
}

func TestSyncEngine_PersistSyncStatusAcrossRestart(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())
	engine1 := NewSyncEngine(db, nil, cfg)

	// Before any sync finishes, status has zero timestamps
	statusInit := engine1.GetStatus()
	assert.False(t, statusInit.HasLastSuccessfulSyncAt())
	assert.False(t, statusInit.HasLastUpdateReceivedAt())

	// Record a finished sync on engine1
	engine1.lastSyncAttemptAt = time.Now().Add(-500 * time.Millisecond)
	engine1.recordSyncFinish(t.Context(), nil, 2)

	status1 := engine1.GetStatus()
	require.True(t, status1.HasLastSuccessfulSyncAt())
	require.True(t, status1.HasLastUpdateReceivedAt())
	assert.Positive(t, status1.GetLastSyncDurationMs())
	lastSyncTime1 := status1.GetLastSuccessfulSyncAt().AsTime()
	lastUpdateTime1 := status1.GetLastUpdateReceivedAt().AsTime()
	lastDuration1 := status1.GetLastSyncDurationMs()

	// Verify metadata entries in DB directly
	valSync, err := db.GetMetadata(t.Context(), KeyLastSuccessfulSync)
	require.NoError(t, err)
	assert.NotEmpty(t, valSync)

	valUpdate, err := db.GetMetadata(t.Context(), KeyLastUpdateReceived)
	require.NoError(t, err)
	assert.NotEmpty(t, valUpdate)

	valDuration, err := db.GetMetadata(t.Context(), KeyLastSyncDurationMs)
	require.NoError(t, err)
	assert.NotEmpty(t, valDuration)

	// Simulate server restart by creating engine2 with the same database
	engine2 := NewSyncEngine(db, nil, cfg)
	status2 := engine2.GetStatus()

	require.True(t, status2.HasLastSuccessfulSyncAt())
	require.True(t, status2.HasLastUpdateReceivedAt())
	assert.Equal(t, lastDuration1, status2.GetLastSyncDurationMs())

	assert.Equal(t,
		lastSyncTime1.Format(time.RFC3339),
		status2.GetLastSuccessfulSyncAt().AsTime().Format(time.RFC3339),
	)
	assert.Equal(t,
		lastUpdateTime1.Format(time.RFC3339),
		status2.GetLastUpdateReceivedAt().AsTime().Format(time.RFC3339),
	)
}

func TestSyncEngine_ResetTicker(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	cfg := config.NewForTest(octodeckv1.Config_builder{
		PollingIntervalMin: config.Ptr(int32(15)),
	}.Build())
	engine := NewSyncEngine(db, nil, cfg)

	// Should not panic when tickerInc is nil
	engine.ResetTicker()

	// Start engine
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	engine.Start(ctx)
	defer engine.Stop()

	// Update cfg polling interval
	proto := cfg.GetProto()
	proto.SetPollingIntervalMin(1)
	err := cfg.UpdateProto(proto, nil)
	require.NoError(t, err)

	// Reset ticker
	engine.ResetTicker()
}

func TestSyncEngine_LastUpdateReceivedOnlyWhenItemsProcessed(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())
	engine := NewSyncEngine(db, nil, cfg)

	// Sync with 0 items processed when lastUpdateReceivedAt is zero
	engine.recordSyncFinish(t.Context(), nil, 0)

	status := engine.GetStatus()
	assert.True(t, status.HasLastSuccessfulSyncAt())
	assert.False(t, status.HasLastUpdateReceivedAt(), "lastUpdateReceivedAt should remain unset if 0 items processed")

	// Sync with 2 items processed
	engine.recordSyncFinish(t.Context(), nil, 2)

	status2 := engine.GetStatus()
	assert.True(t, status2.HasLastSuccessfulSyncAt())
	require.True(t, status2.HasLastUpdateReceivedAt())
	firstUpdateReceived := status2.GetLastUpdateReceivedAt().AsTime()

	// Subsequent sync with 0 items processed should not update lastUpdateReceivedAt
	time.Sleep(10 * time.Millisecond)
	engine.recordSyncFinish(t.Context(), nil, 0)

	status3 := engine.GetStatus()
	assert.True(t, status3.HasLastUpdateReceivedAt())
	assert.Equal(t,
		firstUpdateReceived.Format(time.RFC3339Nano),
		status3.GetLastUpdateReceivedAt().AsTime().Format(time.RFC3339Nano),
	)
}

func TestSyncEngine_BackfillItems(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	mockGQL := &mockGraphQLClient{}
	mockREST := &mockRESTClient{}

	mockREST.doFunc = func(_ context.Context, _, path string, _ io.Reader, response any) error {
		if path == "user" {
			return json.Unmarshal([]byte(`{"login":"testuser"}`), response)
		}
		return fmt.Errorf("unexpected REST path: %s", path)
	}

	mockGQL.queryFunc = func(_ context.Context, name string, q any, vars map[string]any) error {
		if name == "ItemsFetch" {
			ids := vars["ids"].([]string)
			var nodes []any
			for _, id := range ids {
				if id == "item_1" {
					nodes = append(nodes, map[string]any{
						"__typename": "PullRequest",
						"pullRequest": map[string]any{
							"id":         "item_1",
							"repository": map[string]any{"nameWithOwner": "owner/repo"},
							"number":     1,
							"state":      "OPEN",
							"updatedAt":  "2024-01-01T00:00:00Z",
							"title":      "Backfilled PR",
							"url":        "http://test/1",
							"author":     map[string]any{"login": "author"},
							"comments":   map[string]any{"nodes": []any{}},
							"assignees":  map[string]any{"nodes": []any{}},
							"commits":    map[string]any{"nodes": []any{}},
							"milestone":  map[string]any{"title": "v2.0"},
							"labels": map[string]any{
								"nodes": []any{
									map[string]any{"name": "area/api", "color": "123456"},
								},
							},
						},
					})
				}
			}
			jsonData, _ := json.Marshal(map[string]any{
				"nodes": nodes,
			})
			return json.Unmarshal(jsonData, q)
		}
		return nil
	}

	gh := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL}
	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())
	engine := NewSyncEngine(db, gh, cfg)

	// Backfill when DB empty
	count, err := engine.BackfillItems(t.Context())
	require.NoError(t, err)
	assert.Equal(t, 0, count)

	// Seed item in DB with existing local state
	seedItem := octodeckv1.Item_builder{
		Id:     config.Ptr("item_1"),
		Repo:   config.Ptr("owner/repo"),
		Number: config.Ptr(int32(1)),
		Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:  config.Ptr("Old Title"),
		State:  config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		Local: octodeckv1.ItemLocalState_builder{
			Starred:      config.Ptr(true),
			PrivateNotes: config.Ptr("My Note"),
		}.Build(),
	}.Build()
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{seedItem}))

	// Run backfill
	count, err = engine.BackfillItems(t.Context())
	require.NoError(t, err)
	assert.Equal(t, 1, count)

	// Verify database item updated with new fields & local state preserved
	updated, err := db.GetItem(t.Context(), "item_1")
	require.NoError(t, err)
	assert.Equal(t, "Backfilled PR", updated.GetTitle())
	require.NotNil(t, updated.GetMilestone())
	assert.Equal(t, "v2.0", updated.GetMilestone().GetTitle())
	require.Len(t, updated.GetLabels(), 1)
	assert.Equal(t, "area/api", updated.GetLabels()[0].GetName())
	assert.True(t, updated.GetLocal().GetStarred())
	assert.Equal(t, "My Note", updated.GetLocal().GetPrivateNotes())
}

func TestSyncEngine_RecordsAndPrunesTraces(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, _ string, q any, _ map[string]any) error {
			return nil
		},
	}
	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _ string, path string, _ io.Reader, response any) error {
			if path == "user" {
				return json.Unmarshal([]byte(`{"login":"testuser"}`), response)
			}
			return nil
		},
	}
	mockHTTP := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("[]")),
			}, nil
		},
	}
	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL, HTTPClient: mockHTTP}
	cfg := config.NewForTest(octodeckv1.Config_builder{KnownBots: []string{}}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	// 1. Run inventory sync -> should record "inventory" trace
	err := engine.RunInventorySync(t.Context())
	require.NoError(t, err)

	traces, err := db.GetSyncTraces(t.Context(), 10, "")
	require.NoError(t, err)
	require.Len(t, traces, 1)
	assert.Equal(t, "inventory", traces[0].TraceType)
	assert.Equal(t, "startup", traces[0].TriggerSource)

	// 2. Run force sync -> should record "notification_sync" trace with "force_sync" source
	err = engine.ForceSync(t.Context())
	require.NoError(t, err)

	traces, err = db.GetSyncTraces(t.Context(), 10, "")
	require.NoError(t, err)
	require.Len(t, traces, 2)
	assert.Equal(t, "notification_sync", traces[0].TraceType)
	assert.Equal(t, "force_sync", traces[0].TriggerSource)

	// 3. Seed an old trace (> 24h) and run GC -> old trace should be pruned
	oldTrace := &database.SyncTrace{
		ID:            "trace-old",
		TraceType:     "notification_sync",
		TriggerSource: "ticker",
		CreatedAt:     time.Now().UTC().Add(-26 * time.Hour).Format(time.RFC3339),
	}
	require.NoError(t, db.SaveSyncTrace(t.Context(), oldTrace))

	err = engine.RunGarbageCollection(t.Context())
	require.NoError(t, err)

	// oldTrace should be pruned, while recent traces and the new GC trace remain
	_, err = db.GetSyncTrace(t.Context(), "trace-old")
	assert.Error(t, err)
}

func TestSyncEngine_RecordsTraceOnContextCancellationOrTimeout(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	mockGQL := &mockGraphQLClient{
		queryFunc: func(ctx context.Context, _ string, _ any, _ map[string]any) error {
			// Simulate a slow GraphQL query that hits context deadline
			return ctx.Err()
		},
	}
	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _ string, path string, _ io.Reader, response any) error {
			if path == "user" {
				return json.Unmarshal([]byte(`{"login":"testuser"}`), response)
			}
			return nil
		},
	}
	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL}
	cfg := config.NewForTest(octodeckv1.Config_builder{KnownBots: []string{}}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	// Create a context that cancels immediately
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	err := engine.RunInventorySync(ctx)
	require.Error(t, err)

	// Trace should still be recorded with ErrorMessage populated
	traces, err := db.GetSyncTraces(t.Context(), 10, "")
	require.NoError(t, err)
	require.Len(t, traces, 1)
	assert.Equal(t, "inventory", traces[0].TraceType)
	assert.Contains(t, traces[0].ErrorMessage, "context canceled")

	// Status should also record failed sync
	status := engine.GetStatus()
	assert.True(t, status.GetLastSyncFailed())
	assert.Contains(t, status.GetLastErrorMessage(), "context canceled")
}

func TestProcessItems_CommentGapDetectionAndBackfill(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	// Seed existing item with 5 comments (IDs 101..105)
	var existingComments []*octodeckv1.Comment
	for i := int64(101); i <= 105; i++ {
		existingComments = append(existingComments, octodeckv1.Comment_builder{
			CommentId: config.Ptr(i),
			CreatedAt: timestamppb.New(time.Date(2026, 1, 1, int(i-100), 0, 0, 0, time.UTC)),
			BodyText:  config.Ptr(fmt.Sprintf("Comment %d", i)),
			Author:    octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		}.Build())
	}

	existingItem := octodeckv1.Item_builder{
		Id:        config.Ptr("item_gap"),
		Repo:      config.Ptr("owner/repo"),
		Number:    config.Ptr(int32(1)),
		Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:     config.Ptr("Gap Issue"),
		State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		Comments:  existingComments,
		UpdatedAt: timestamppb.New(time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)),
	}.Build()
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{existingItem}))

	// Fetched item has 20 comments with IDs 120..139 (gap between 105 and 120)
	var fetchedComments []*octodeckv1.Comment
	for i := int64(120); i <= 139; i++ {
		fetchedComments = append(fetchedComments, octodeckv1.Comment_builder{
			CommentId: config.Ptr(i),
			CreatedAt: timestamppb.New(time.Date(2026, 1, 2, int(i-120), 0, 0, 0, time.UTC)),
			BodyText:  config.Ptr(fmt.Sprintf("Comment %d", i)),
			Author:    octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		}.Build())
	}

	fetchedItem := octodeckv1.Item_builder{
		Id:        config.Ptr("item_gap"),
		Repo:      config.Ptr("owner/repo"),
		Number:    config.Ptr(int32(1)),
		Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:     config.Ptr("Gap Issue Updated"),
		State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		Comments:  fetchedComments,
		UpdatedAt: timestamppb.New(time.Date(2026, 1, 2, 20, 0, 0, 0, time.UTC)),
	}.Build()

	// Mock GraphQL client returning missing comments (IDs 106..119)
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			if name == "FetchItemComments" {
				var nodes []map[string]any
				for i := 106; i <= 119; i++ {
					nodes = append(nodes, map[string]any{
						"databaseId": i,
						"createdAt":  "2026-01-01T20:00:00Z",
						"bodyText":   fmt.Sprintf("Missing Comment %d", i),
						"author":     map[string]any{"login": "backfilled_user"},
					})
				}
				data := map[string]any{
					"node": map[string]any{
						"__typename": "Issue",
						"issue": map[string]any{
							"comments": map[string]any{
								"nodes": nodes,
								"pageInfo": map[string]any{
									"hasPreviousPage": false,
									"startCursor":     "",
								},
							},
						},
					},
				}
				b, _ := json.Marshal(data)
				return json.Unmarshal(b, q)
			}
			return nil
		},
	}

	ghClient := &github.Client{GraphQLClient: mockGQL}
	engine := NewSyncEngine(db, ghClient, config.NewForTest(octodeckv1.Config_builder{}.Build()))

	err := engine.processItems(t.Context(), []*octodeckv1.Item{fetchedItem})
	require.NoError(t, err)

	// Verify all comments from 101..139 are present and in order
	saved, err := db.GetItem(t.Context(), "item_gap")
	require.NoError(t, err)
	require.Len(t, saved.GetComments(), 39) // 5 existing + 14 missing + 20 fetched = 39
	assert.Equal(t, int64(101), saved.GetComments()[0].GetCommentId())
	assert.Equal(t, int64(139), saved.GetComments()[38].GetCommentId())
}

func TestBackfillItems_PoisonPillResilience(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	// Seed 2 items: item_valid and item_poison
	item1 := octodeckv1.Item_builder{
		Id:     config.Ptr("item_valid"),
		Repo:   config.Ptr("owner/repo"),
		Number: config.Ptr(int32(1)),
		Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:  config.Ptr("Valid Item"),
		State:  config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
	}.Build()

	item2 := octodeckv1.Item_builder{
		Id:     config.Ptr("item_poison"),
		Repo:   config.Ptr("owner/repo"),
		Number: config.Ptr(int32(2)),
		Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:  config.Ptr("Poison Item (Deleted on GitHub)"),
		State:  config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
	}.Build()

	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{item1, item2}))

	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			if name == "ItemsFetch" {
				ids := vars["ids"].([]string)
				var nodes []any
				for _, id := range ids {
					if id == "item_valid" {
						nodes = append(nodes, map[string]any{
							"__typename": "PullRequest",
							"pullRequest": map[string]any{
								"id":         "item_valid",
								"repository": map[string]any{"nameWithOwner": "owner/repo"},
								"number":     1,
								"state":      "OPEN",
								"updatedAt":  "2026-01-01T00:00:00Z",
								"title":      "Valid Item Updated",
								"url":        "http://test/1",
								"author":     map[string]any{"login": "author"},
							},
						})
					} else {
						nodes = append(nodes, nil) // item_poison is missing/404
					}
				}
				data := map[string]any{
					"nodes": nodes,
				}
				b, _ := json.Marshal(data)
				return json.Unmarshal(b, q)
			}
			return nil
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

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL}
	engine := NewSyncEngine(db, ghClient, config.NewForTest(octodeckv1.Config_builder{}.Build()))

	count, err := engine.BackfillItems(t.Context())
	require.NoError(t, err)
	assert.Equal(t, 1, count, "Only valid item is counted as hydrated")

	// Verify valid item updated
	saved1, err := db.GetItem(t.Context(), "item_valid")
	require.NoError(t, err)
	assert.Equal(t, "Valid Item Updated", saved1.GetTitle())
	assert.Empty(t, saved1.GetLocal().GetSyncError())

	// Verify poison item received sync error in LocalState
	saved2, err := db.GetItem(t.Context(), "item_poison")
	require.NoError(t, err)
	assert.Contains(t, saved2.GetLocal().GetSyncError(), "404")

	// Now simulate item_poison succeeding on next fetch -> sync error should be cleared
	mockGQL.queryFunc = func(_ context.Context, name string, q any, _ map[string]any) error {
		if name == "ItemsFetch" {
			data := map[string]any{
				"nodes": []any{
					map[string]any{
						"__typename": "PullRequest",
						"pullRequest": map[string]any{
							"id":         "item_poison",
							"repository": map[string]any{"nameWithOwner": "owner/repo"},
							"number":     2,
							"state":      "OPEN",
							"updatedAt":  "2026-01-02T00:00:00Z",
							"title":      "Poison Item Recovered",
							"url":        "http://test/2",
							"author":     map[string]any{"login": "author"},
						},
					},
				},
			}
			b, _ := json.Marshal(data)
			return json.Unmarshal(b, q)
		}
		return nil
	}

	// Refetch / process recovered item
	refetched, err := engine.RefetchItem(t.Context(), "item_poison")
	require.NoError(t, err)
	require.NotNil(t, refetched)

	recovered, err := db.GetItem(t.Context(), "item_poison")
	require.NoError(t, err)
	assert.Equal(t, "Poison Item Recovered", recovered.GetTitle())
	assert.Empty(t, recovered.GetLocal().GetSyncError(), "sync_error should be cleared upon successful hydration")
}

func TestRunIncrementalSync_KnownItemsBypassResolveNodeIDs(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	// Seed existing item in DB with repo owner/repo#1 and ID "PR_known_1"
	knownItem := octodeckv1.Item_builder{
		Id:     config.Ptr("PR_known_1"),
		Repo:   config.Ptr("kubernetes/kubernetes"),
		Number: config.Ptr(int32(1)),
		Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:  config.Ptr("Known Item Title"),
		State:  config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
	}.Build()
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{knownItem}))

	notifJSON := `[
		{
			"id": "thread_known",
			"unread": true,
			"reason": "mention",
			"subject": {
				"title": "Known Item Mention",
				"type": "PullRequest",
				"url": "https://api.github.com/repos/kubernetes/kubernetes/pulls/1"
			},
			"repository": {"full_name": "kubernetes/kubernetes"}
		}
	]`

	resolveGQLCalled := false
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
				resolveGQLCalled = true
				return nil, errors.New("ResolveNodeIDs should not be called for known items")
			}
			return nil, fmt.Errorf("unexpected HTTP path: %s", req.URL.Path)
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

	var gqlFetchedIDs []string
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			if name == "ItemsFetch" {
				ids := vars["ids"].([]string)
				gqlFetchedIDs = append(gqlFetchedIDs, ids...)
				nodes := []any{
					map[string]any{
						"__typename": "PullRequest",
						"pullRequest": map[string]any{
							"id":         "PR_known_1",
							"repository": map[string]any{"nameWithOwner": "kubernetes/kubernetes"},
							"number":     1,
							"state":      "OPEN",
							"updatedAt":  "2026-08-14T02:00:00Z",
							"title":      "Known Item Updated Title",
							"url":        "https://github.com/kubernetes/kubernetes/pull/1",
							"author":     map[string]any{"login": "contributor"},
							"comments":   map[string]any{"nodes": []any{}},
							"assignees":  map[string]any{"nodes": []any{}},
							"commits":    map[string]any{"nodes": []any{}},
						},
					},
				}
				b, _ := json.Marshal(map[string]any{"nodes": nodes})
				return json.Unmarshal(b, q)
			}
			return nil
		},
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL, HTTPClient: mockHTTP}
	cfg := config.NewForTest(octodeckv1.Config_builder{KnownBots: []string{}}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	err := engine.RunIncrementalSync(t.Context())
	require.NoError(t, err)

	assert.False(t, resolveGQLCalled, "ResolveNodeIDs should be bypassed for items already in local SQLite DB")
	assert.Equal(t, []string{"PR_known_1"}, gqlFetchedIDs)

	saved, err := db.GetItem(t.Context(), "PR_known_1")
	require.NoError(t, err)
	assert.Equal(t, "Known Item Updated Title", saved.GetTitle())
}

func TestRefetchItem_UntrackedItemOnDemandFetch(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, op string, q any, vars map[string]any) error {
			if op == "ViewerDetails" {
				b, _ := json.Marshal(map[string]any{
					"viewer": map[string]any{"login": "testuser"},
				})
				return json.Unmarshal(b, q)
			}
			if op == "ItemsFetch" || op == "FetchNodesBatch" {
				ids, _ := vars["ids"].([]string)
				nodes := make([]any, 0, len(ids))
				for _, id := range ids {
					nodes = append(nodes, map[string]any{
						"__typename": "Issue",
						"issue": map[string]any{
							"id":                 id,
							"repository":         map[string]any{"nameWithOwner": "external/project"},
							"number":             999,
							"state":              "OPEN",
							"viewerSubscription": "UNSUBSCRIBED",
							"updatedAt":          "2026-08-14T10:00:00Z",
							"title":              "Untracked Issue Title",
							"body":               "Issue body from GitHub",
							"url":                "https://github.com/external/project/issues/999",
							"author":             map[string]any{"login": "external-author"},
							"comments":           map[string]any{"nodes": []any{}},
							"assignees":          map[string]any{"nodes": []any{}},
							"timelineItems":      map[string]any{"nodes": []any{}},
						},
					})
				}
				b, _ := json.Marshal(map[string]any{"nodes": nodes})
				return json.Unmarshal(b, q)
			}
			return nil
		},
	}

	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _, _ string, _ io.Reader, response any) error {
			if userMap, ok := response.(*map[string]any); ok {
				(*userMap)["login"] = "testuser"
			}
			return nil
		},
	}
	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL}
	cfg := config.NewForTest(octodeckv1.Config_builder{KnownBots: []string{}}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	// Fetch untracked item that does not exist in DB
	item, err := engine.RefetchItem(t.Context(), "node_untracked_999")
	require.NoError(t, err)
	require.NotNil(t, item)
	assert.Equal(t, "node_untracked_999", item.GetId())
	assert.Equal(t, "external/project", item.GetRepo())
	assert.Equal(t, int32(999), item.GetNumber())
	assert.Equal(t, "Untracked Issue Title", item.GetTitle())
	assert.Equal(t, octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED, item.GetViewerSubscription())

	// Verify it was persisted to SQLite
	dbItem, err := db.GetItem(t.Context(), "node_untracked_999")
	require.NoError(t, err)
	assert.Equal(t, "Untracked Issue Title", dbItem.GetTitle())
}

// TestSyncEngine_TickerInitializationAndNilSafety tests ticker lifecycle initialization and nil safety.
func TestSyncEngine_TickerInitializationAndNilSafety(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	cfg := config.NewForTest(octodeckv1.Config_builder{
		PollingIntervalMin:   config.Ptr(int32(15)),
		DiscoveryIntervalMin: config.Ptr(int32(45)),
	}.Build())

	engine := NewSyncEngine(db, nil, cfg)

	// 1. Calling ResetTicker before Start() must NOT panic on nil tickers
	require.NotPanics(t, func() {
		engine.ResetTicker()
	})

	// 2. Start engine and verify tickers are initialized
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	engine.Start(ctx)
	defer engine.Stop()

	engine.mu.Lock()
	require.NotNil(t, engine.tickerInc, "tickerInc must be initialized after Start()")
	require.NotNil(t, engine.tickerDiscovery, "tickerDiscovery must be initialized after Start()")
	engine.mu.Unlock()

	// 3. Reset tickers after Start()
	require.NotPanics(t, func() {
		engine.ResetTicker()
	})
}

// TestSyncEngine_ResetTicker_DiscoveryInterval tests resetting both sync and discovery tickers.
func TestSyncEngine_ResetTicker_DiscoveryInterval(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	cfg := config.NewForTest(octodeckv1.Config_builder{
		PollingIntervalMin:   config.Ptr(int32(15)),
		DiscoveryIntervalMin: config.Ptr(int32(30)),
	}.Build())

	engine := NewSyncEngine(db, nil, cfg)

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	engine.Start(ctx)
	defer engine.Stop()

	// Mutate config with new discovery and polling intervals
	cfgProto := cfg.GetProto()
	cfgProto.SetPollingIntervalMin(5)
	cfgProto.SetDiscoveryIntervalMin(10)
	err := cfg.UpdateProto(cfgProto, nil)
	require.NoError(t, err)

	require.Equal(t, 5*time.Minute, cfg.GetSyncInterval())
	require.Equal(t, 10*time.Minute, cfg.GetDiscoveryInterval())

	// ResetTicker must safely update both tickers under lock
	require.NotPanics(t, func() {
		engine.ResetTicker()
	})
}

// TestSyncEngine_Stop_Idempotency tests that Stop() terminates cleanly and does not panic on multiple calls.
func TestSyncEngine_Stop_Idempotency(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())
	engine := NewSyncEngine(db, nil, cfg)

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	engine.Start(ctx)

	// First Stop() terminates the engine
	require.NotPanics(t, func() {
		engine.Stop()
	})

	// Subsequent Stop() calls must be idempotent and not panic with "close of closed channel"
	require.NotPanics(t, func() {
		engine.Stop()
		engine.Stop()
	})
}

// TestSyncEngine_ConcurrentStart_Race verifies that 10 concurrent goroutines calling
// Start(ctx) on the same engine does not trigger data races and starts cleanly under -race.
func TestSyncEngine_ConcurrentStart_Race(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	// Seed database to prevent background inventory sync goroutines
	dummyItem := octodeckv1.Item_builder{
		Id:     config.Ptr("ISSUE_CONCURRENT_START"),
		Repo:   config.Ptr("owner/repo"),
		Number: config.Ptr(int32(1)),
		Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		State:  config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		Title:  config.Ptr("Concurrent Start Test Issue"),
		Author: octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Local:  octodeckv1.ItemLocalState_builder{}.Build(),
	}.Build()
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{dummyItem}))

	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _, path string, _ io.Reader, response any) error {
			if path == "user" {
				data, _ := json.Marshal(map[string]any{"login": "testuser"})
				return json.Unmarshal(data, response)
			}
			return nil
		},
	}
	ghClient := &github.Client{RestClient: mockREST}
	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	const concurrency = 10
	var wg sync.WaitGroup
	startGate := make(chan struct{})

	for range concurrency {
		wg.Go(func() {
			<-startGate // Synchronize goroutines to hit Start() concurrently
			engine.Start(ctx)
		})
	}

	close(startGate)
	wg.Wait()

	// Engine must have initialized tickers and started
	assert.NotNil(t, engine.tickerInc, "tickerInc should be initialized")
	assert.NotNil(t, engine.tickerDiscovery, "tickerDiscovery should be initialized")

	// Engine must stop cleanly without panic
	require.NotPanics(t, func() {
		engine.Stop()
	})
}

// TestSyncEngine_RepeatedStart_Idempotent verifies that calling Start(ctx) sequentially
// multiple times is fully idempotent: tickers are not recreated and only a single event loop is running.
func TestSyncEngine_RepeatedStart_Idempotent(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	// Seed database to prevent background inventory sync goroutine
	dummyItem := octodeckv1.Item_builder{
		Id:     config.Ptr("ISSUE_REPEATED_START"),
		Repo:   config.Ptr("owner/repo"),
		Number: config.Ptr(int32(1)),
		Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		State:  config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		Title:  config.Ptr("Repeated Start Test Issue"),
		Author: octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Local:  octodeckv1.ItemLocalState_builder{}.Build(),
	}.Build()
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{dummyItem}))

	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _, path string, _ io.Reader, response any) error {
			if path == "user" {
				data, _ := json.Marshal(map[string]any{"login": "testuser"})
				return json.Unmarshal(data, response)
			}
			return nil
		},
	}
	ghClient := &github.Client{RestClient: mockREST}
	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	// Initial Start call
	engine.Start(ctx)

	tickerIncFirst := engine.tickerInc
	tickerDiscFirst := engine.tickerDiscovery
	require.NotNil(t, tickerIncFirst, "tickerInc must be initialized on first Start()")
	require.NotNil(t, tickerDiscFirst, "tickerDiscovery must be initialized on first Start()")

	// Wait briefly for the single event loop goroutine to start
	time.Sleep(20 * time.Millisecond)
	baselineGoroutines := runtime.NumGoroutine()

	// Call Start() sequentially multiple times
	const repeatCount = 5
	for range repeatCount {
		engine.Start(ctx)
	}

	time.Sleep(20 * time.Millisecond)
	goroutinesAfterRepeats := runtime.NumGoroutine()

	// 1. Assert tickers are not recreated (pointer identity preserved)
	assert.Same(t, tickerIncFirst, engine.tickerInc, "tickerInc must not be recreated on repeated Start()")
	assert.Same(t, tickerDiscFirst, engine.tickerDiscovery, "tickerDiscovery must not be recreated on repeated Start()")

	// 2. Assert only a single event loop is running (no extra goroutines spawned)
	assert.Equal(t, baselineGoroutines, goroutinesAfterRepeats,
		"calling Start() repeatedly must not spawn redundant event loop goroutines")

	// 3. Clean termination: verify event loop exits after Stop()
	engine.Stop()
	require.Eventually(t, func() bool {
		buf := make([]byte, 8192)
		n := runtime.Stack(buf, true)
		return !strings.Contains(string(buf[:n]), "runEventLoop")
	}, 1*time.Second, 10*time.Millisecond, "event loop goroutine must terminate after Stop()")
}

// TestSyncEngine_ConcurrentStartAndStop verifies that concurrent Start(ctx) and Stop()
// calls across multiple goroutines do not panic, deadlock, or trigger data races under -race.
func TestSyncEngine_ConcurrentStartAndStop(t *testing.T) {
	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _, path string, _ io.Reader, response any) error {
			if path == "user" {
				data, _ := json.Marshal(map[string]any{"login": "testuser"})
				return json.Unmarshal(data, response)
			}
			return nil
		},
	}
	ghClient := &github.Client{RestClient: mockREST}
	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())

	// Run across multiple iterations to test different thread interleavings
	for iter := range 10 {
		db := setupTestDB(t)
		dummyItem := octodeckv1.Item_builder{
			Id:     config.Ptr(fmt.Sprintf("ISSUE_START_STOP_%d", iter)),
			Repo:   config.Ptr("owner/repo"),
			Number: config.Ptr(int32(1)),
			Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
			State:  config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			Title:  config.Ptr("Start Stop Test Issue"),
			Author: octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
			Local:  octodeckv1.ItemLocalState_builder{}.Build(),
		}.Build()
		require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{dummyItem}))

		engine := NewSyncEngine(db, ghClient, cfg)
		ctx, cancel := context.WithCancel(t.Context())

		const numStarters = 10
		const numStoppers = 10
		var wg sync.WaitGroup
		gate := make(chan struct{})

		for range numStarters {
			wg.Go(func() {
				<-gate
				engine.Start(ctx)
			})
		}

		for range numStoppers {
			wg.Go(func() {
				<-gate
				engine.Stop()
			})
		}

		close(gate)
		wg.Wait()
		cancel()

		// Final Stop and ResetTicker calls must remain safe and idempotent
		require.NotPanics(t, func() {
			engine.Stop()
			engine.ResetTicker()
		})

		require.NoError(t, db.Close())
	}
}

// TestRunDiscovery_DoesNotBlockGetStatus verifies that RunDiscovery acquiring discoveryMu
// frees s.mu during network I/O, allowing GetStatus() to complete immediately without lock contention.
func TestRunDiscovery_DoesNotBlockGetStatus(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	searchStarted := make(chan struct{})
	allowSearchFinish := make(chan struct{})

	mockGQL := &mockGraphQLClient{
		queryFunc: func(ctx context.Context, name string, q any, vars map[string]any) error {
			if name == "SearchCandidateIDs" {
				select {
				case <-searchStarted:
				default:
					close(searchStarted)
				}
				select {
				case <-allowSearchFinish:
				case <-ctx.Done():
				}
			}
			return nil
		},
	}
	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _, path string, _ io.Reader, response any) error {
			if path == "user" {
				data, _ := json.Marshal(map[string]any{"login": "testuser"})
				return json.Unmarshal(data, response)
			}
			return nil
		},
	}
	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL}
	cfg := config.NewForTest(octodeckv1.Config_builder{
		TrackedQueries: []string{"repo:owner/repo is:issue"},
	}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	// Launch RunDiscovery in background (will pause in mock GraphQL SearchCandidateIDs)
	discDone := make(chan struct{})
	go func() {
		defer close(discDone)
		_ = engine.RunDiscovery(ctx)
	}()

	// Wait until RunDiscovery enters GraphQL network I/O under discoveryMu
	select {
	case <-searchStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("RunDiscovery did not start network I/O in time")
	}

	// While RunDiscovery is paused in network I/O, GetStatus() must complete immediately (< 50ms)
	start := time.Now()
	status := engine.GetStatus()
	duration := time.Since(start)

	assert.NotNil(t, status)
	assert.Less(t, duration, 50*time.Millisecond, "GetStatus must not be blocked by RunDiscovery network I/O")

	// Release mock GraphQL and wait for discovery to return
	close(allowSearchFinish)
	<-discDone
}

// TestSyncEngine_UntrackedItem_LifecycleAndGCRefresh verifies requirement R3:
// 1. Unsubscribed items remain dormant without polling.
// 2. Only stale (>30 days) open items are fetched during GC.
// 3. Stale unsubscribed items have their LastSyncedAt updated and viewer_subscription refreshed.
func TestSyncEngine_UntrackedItem_LifecycleAndGCRefresh(t *testing.T) {
	const (
		idUntrackedStale  = "ISSUE_UNTRACKED_STALE"
		idUntrackedFresh  = "ISSUE_UNTRACKED_FRESH"
		idUntrackedClosed = "ISSUE_UNTRACKED_CLOSED"
		idSubscribedStale = "ISSUE_SUBSCRIBED_STALE"
		repoName          = "owner/repo"
	)

	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	staleTime := time.Now().Add(-31 * 24 * time.Hour)
	freshTime := time.Now().Add(-2 * 24 * time.Hour)

	// 1. Untracked Stale: Open, UNSUBSCRIBED, synced 31 days ago
	untrackedStale := octodeckv1.Item_builder{
		Id:                 config.Ptr(idUntrackedStale),
		Repo:               config.Ptr(repoName),
		Number:             config.Ptr(int32(101)),
		Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:              config.Ptr("Untracked Stale"),
		State:              config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		ViewerSubscription: config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED),
		UpdatedAt:          timestamppb.New(staleTime),
		LastSyncedAt:       timestamppb.New(staleTime),
		Author:             octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Local:              octodeckv1.ItemLocalState_builder{}.Build(),
	}.Build()

	// 2. Untracked Fresh: Open, UNSUBSCRIBED, synced 2 days ago (must NOT be touched by GC)
	untrackedFresh := octodeckv1.Item_builder{
		Id:                 config.Ptr(idUntrackedFresh),
		Repo:               config.Ptr(repoName),
		Number:             config.Ptr(int32(102)),
		Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:              config.Ptr("Untracked Fresh"),
		State:              config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		ViewerSubscription: config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED),
		UpdatedAt:          timestamppb.New(freshTime),
		LastSyncedAt:       timestamppb.New(freshTime),
		Author:             octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Local:              octodeckv1.ItemLocalState_builder{}.Build(),
	}.Build()

	// 3. Untracked Closed: CLOSED, UNSUBSCRIBED, updated 31 days ago (must NOT be refreshed by GC)
	untrackedClosed := octodeckv1.Item_builder{
		Id:                 config.Ptr(idUntrackedClosed),
		Repo:               config.Ptr(repoName),
		Number:             config.Ptr(int32(103)),
		Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:              config.Ptr("Untracked Closed"),
		State:              config.Ptr(octodeckv1.ItemState_ITEM_STATE_CLOSED),
		ViewerSubscription: config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED),
		UpdatedAt:          timestamppb.New(staleTime),
		LastSyncedAt:       timestamppb.New(staleTime),
		Author:             octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Local:              octodeckv1.ItemLocalState_builder{}.Build(),
	}.Build()

	// 4. Subscribed Stale: Open, SUBSCRIBED, synced 31 days ago (refreshed by GC)
	subscribedStale := octodeckv1.Item_builder{
		Id:                 config.Ptr(idSubscribedStale),
		Repo:               config.Ptr(repoName),
		Number:             config.Ptr(int32(104)),
		Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:              config.Ptr("Subscribed Stale"),
		State:              config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		ViewerSubscription: config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED),
		UpdatedAt:          timestamppb.New(staleTime),
		LastSyncedAt:       timestamppb.New(staleTime),
		Author:             octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Local:              octodeckv1.ItemLocalState_builder{}.Build(),
	}.Build()

	err := db.SaveItems(t.Context(), []*octodeckv1.Item{
		untrackedStale, untrackedFresh, untrackedClosed, subscribedStale,
	})
	require.NoError(t, err)

	requestedIDs := make(map[string]bool)
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			if name == "ItemsFetch" {
				ids, ok := vars["ids"].([]string)
				require.True(t, ok)
				var nodes []any
				for _, id := range ids {
					requestedIDs[id] = true
					switch id {
					case idUntrackedStale:
						nodes = append(nodes, map[string]any{
							"__typename": "Issue",
							"issue": map[string]any{
								"id":                 idUntrackedStale,
								"repository":         map[string]any{"nameWithOwner": repoName},
								"number":             101,
								"state":              "OPEN",
								"updatedAt":          time.Now().Format(time.RFC3339),
								"title":              "Untracked Stale Updated",
								"url":                "http://test/101",
								"author":             map[string]any{"login": "author"},
								"comments":           map[string]any{"nodes": []any{}},
								"assignees":          map[string]any{"nodes": []any{}},
								"viewerSubscription": "UNSUBSCRIBED",
								"timelineItems":      map[string]any{"nodes": []any{}},
							},
						})
					case idSubscribedStale:
						nodes = append(nodes, map[string]any{
							"__typename": "Issue",
							"issue": map[string]any{
								"id":                 idSubscribedStale,
								"repository":         map[string]any{"nameWithOwner": repoName},
								"number":             104,
								"state":              "OPEN",
								"updatedAt":          time.Now().Format(time.RFC3339),
								"title":              "Subscribed Stale Updated",
								"url":                "http://test/104",
								"author":             map[string]any{"login": "author"},
								"comments":           map[string]any{"nodes": []any{}},
								"assignees":          map[string]any{"nodes": []any{}},
								"viewerSubscription": "SUBSCRIBED",
								"timelineItems":      map[string]any{"nodes": []any{}},
							},
						})
					default:
						assert.Failf(t, "Unexpected item requested by GC", "id: %s", id)
					}
				}
				jsonData, _ := json.Marshal(map[string]any{"nodes": nodes})
				return json.Unmarshal(jsonData, q)
			}
			return nil
		},
	}
	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _, path string, _ io.Reader, response any) error {
			if path == "user" {
				data, _ := json.Marshal(map[string]any{"login": "testuser"})
				return json.Unmarshal(data, response)
			}
			return nil
		},
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL, CurrentUser: "testuser"}
	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	// Run GC pass
	gcStartTime := time.Now()
	err = engine.RunGarbageCollection(t.Context())
	require.NoError(t, err)

	// Assert only stale open items were requested
	assert.True(t, requestedIDs[idUntrackedStale], "Untracked stale item must be fetched by GC")
	assert.True(t, requestedIDs[idSubscribedStale], "Subscribed stale item must be fetched by GC")
	assert.False(t, requestedIDs[idUntrackedFresh], "Untracked fresh item must NOT be fetched by GC")
	assert.False(t, requestedIDs[idUntrackedClosed], "Untracked closed item must NOT be fetched by GC")

	// Verify database persistence
	itemUntrackedStale, err := db.GetItem(t.Context(), idUntrackedStale)
	require.NoError(t, err)
	assert.True(t, itemUntrackedStale.GetLastSyncedAt().AsTime().After(gcStartTime), "LastSyncedAt must be updated")
	assert.Equal(t,
		octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED,
		itemUntrackedStale.GetViewerSubscription())
	assert.Equal(t, "Untracked Stale Updated", itemUntrackedStale.GetTitle())

	itemUntrackedFresh, err := db.GetItem(t.Context(), idUntrackedFresh)
	require.NoError(t, err)
	assert.True(t, itemUntrackedFresh.GetLastSyncedAt().AsTime().Before(gcStartTime),
		"Fresh item LastSyncedAt must remain untouched")

	itemUntrackedClosed, err := db.GetItem(t.Context(), idUntrackedClosed)
	require.NoError(t, err)
	assert.True(t, itemUntrackedClosed.GetLastSyncedAt().AsTime().Before(gcStartTime),
		"Closed item LastSyncedAt must remain untouched")
}

// TestStress_FetchCurrentUser_Concurrency verifies that multiple concurrent callers of
// fetchCurrentUser and fetchCurrentUserLocked under -race execute safely with 0 warnings.
func TestStress_FetchCurrentUser_Concurrency(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _, path string, _ io.Reader, response any) error {
			if path == "user" {
				data, _ := json.Marshal(map[string]any{"login": "concurrent_user"})
				return json.Unmarshal(data, response)
			}
			return nil
		},
	}
	ghClient := &github.Client{RestClient: mockREST}
	cfg := config.NewForTest((&octodeckv1.Config_builder{}).Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	ctx := t.Context()
	const numGoroutines = 20
	const iterations = 15

	var wg sync.WaitGroup
	startCh := make(chan struct{})

	for workerID := range numGoroutines {
		wg.Go(func() {
			<-startCh
			for range iterations {
				if workerID%2 == 0 {
					err := engine.fetchCurrentUser(ctx)
					require.NoError(t, err)
				} else {
					engine.mu.Lock()
					err := engine.fetchCurrentUserLocked(ctx)
					engine.mu.Unlock()
					require.NoError(t, err)
				}
				user := engine.getCurrentUser()
				assert.Equal(t, "concurrent_user", user)
			}
		})
	}

	close(startCh)
	wg.Wait()
}

// TestStress_CalculateItemState_CurrentUser_Race verifies that concurrent RunDiscovery,
// calculateItemState, and fetchCurrentUser callers pass under -race with 0 warnings.
func TestStress_CalculateItemState_CurrentUser_Race(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, _ map[string]any) error {
			if name == "SearchCandidateIDs" {
				data, _ := json.Marshal(map[string]any{
					"search": map[string]any{
						"nodes": []map[string]any{
							{"__typename": "Issue", "issue": map[string]any{"id": "ISSUE_RACE_1"}},
						},
						"pageInfo": map[string]any{"hasNextPage": false, "endCursor": ""},
					},
				})
				return json.Unmarshal(data, q)
			}
			if name == "ItemsFetch" {
				data, _ := json.Marshal(map[string]any{
					"nodes": []map[string]any{
						{
							"__typename": "Issue",
							"issue": map[string]any{
								"id":                 "ISSUE_RACE_1",
								"number":             42,
								"title":              "Discovered Issue",
								"state":              "OPEN",
								"createdAt":          "2026-09-01T00:00:00Z",
								"updatedAt":          "2026-09-01T01:00:00Z",
								"url":                "https://github.com/owner/repo/issues/42",
								"author":             map[string]any{"login": "author_user"},
								"repository":         map[string]any{"nameWithOwner": "owner/repo"},
								"viewerSubscription": "UNSUBSCRIBED",
								"comments": map[string]any{
									"nodes": []map[string]any{
										{
											"id":        1,
											"createdAt": "2026-09-01T01:00:00Z",
											"bodyText":  "comment text",
											"author":    map[string]any{"login": "race_user"},
										},
									},
								},
							},
						},
					},
				})
				return json.Unmarshal(data, q)
			}
			return nil
		},
	}

	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _, path string, _ io.Reader, response any) error {
			if path == "user" {
				data, _ := json.Marshal(map[string]any{"login": "race_user"})
				return json.Unmarshal(data, response)
			}
			return nil
		},
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL}
	cfg := config.NewForTest(octodeckv1.Config_builder{
		TrackedQueries:     []string{"repo:owner/repo is:issue"},
		AutoAckOwnActivity: config.Ptr(true),
	}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	ctx := t.Context()
	const iterations = 20

	var wg sync.WaitGroup
	startCh := make(chan struct{})

	// Goroutine 1: RunDiscovery
	wg.Go(func() {
		<-startCh
		for range iterations {
			_ = engine.RunDiscovery(ctx)
		}
	})

	// Goroutine 2: fetchCurrentUser callers
	wg.Go(func() {
		<-startCh
		for i := range iterations {
			if i%2 == 0 {
				_ = engine.fetchCurrentUser(ctx)
			} else {
				engine.mu.Lock()
				_ = engine.fetchCurrentUserLocked(ctx)
				engine.mu.Unlock()
			}
		}
	})

	// Goroutine 3: direct calculateItemState calls
	wg.Go(func() {
		<-startCh
		testItem := (&octodeckv1.Item_builder{
			Id: config.Ptr("ISSUE_RACE_DIRECT"),
			Comments: []*octodeckv1.Comment{
				(&octodeckv1.Comment_builder{
					CreatedAt: timestamppb.New(time.Now()),
					Author:    (&octodeckv1.User_builder{Login: config.Ptr("race_user")}).Build(),
				}).Build(),
			},
			Local: (&octodeckv1.ItemLocalState_builder{}).Build(),
		}).Build()

		for range iterations {
			engine.calculateItemState(testItem)
		}
	})

	close(startCh)
	wg.Wait()
}
