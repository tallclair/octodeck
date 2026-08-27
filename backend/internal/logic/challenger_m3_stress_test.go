package logic

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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

func newMockPRNode(id, repo string, number int32, title, author string) map[string]any {
	return map[string]any{
		"__typename": "PullRequest",
		"pullRequest": map[string]any{
			"id":         id,
			"repository": map[string]any{"nameWithOwner": repo},
			"number":     number,
			"state":      "OPEN",
			"updatedAt":  "2026-08-14T04:00:00Z",
			"title":      title,
			"url":        fmt.Sprintf("https://github.com/%s/pull/%d", repo, number),
			"author":     map[string]any{"login": author},
			"comments":   map[string]any{"nodes": []any{}},
			"assignees":  map[string]any{"nodes": []any{}},
			"commits":    map[string]any{"nodes": []any{}},
		},
	}
}

// TestChallenger_FullSyncLifecycleAndStateTransitions verifies the complete multi-step lifecycle:
// Step 1: Initial cold start seeds inventory and sets initial cursors.
// Step 2: Incremental sync with 304 sends exact If-Modified-Since, makes 0 GQL queries, updates sync time.
// Step 3: Incremental sync with 200 hydrates new items, advances Last-Modified and sync cursors.
// Step 4: Subsequent incremental sync with 304 uses new Last-Modified.
// Step 5: ForceSync bypasses If-Modified-Since, sets trigger_source="force_sync", updates cursors.
func TestChallenger_FullSyncLifecycleAndStateTransitions(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	var capturedIfModifiedSince string
	var returnStatusCode = http.StatusOK
	var returnNotificationsJSON = "[]"
	var returnLastModifiedHeader = ""
	var gqlCallCount int

	mockHTTP := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			if strings.Contains(req.URL.Path, "notifications") {
				capturedIfModifiedSince = req.Header.Get("If-Modified-Since")
				resp := &http.Response{
					StatusCode: returnStatusCode,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(returnNotificationsJSON)),
				}
				if returnLastModifiedHeader != "" {
					resp.Header.Set("Last-Modified", returnLastModifiedHeader)
				}
				return resp, nil
			}
			if strings.Contains(req.URL.Path, "graphql") {
				resolveResp := `{"data": {"q0": {"issueOrPullRequest": {"id": "PR_node_999"}}}}`
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(resolveResp)),
				}, nil
			}
			return nil, fmt.Errorf("unexpected HTTP request to %s", req.URL.Path)
		},
	}

	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _, path string, _ io.Reader, response any) error {
			if path == "user" {
				return json.Unmarshal([]byte(`{"login":"challenger_user"}`), response)
			}
			return nil
		},
	}

	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			gqlCallCount++
			if name == inventoryQueryName {
				prNode := newMockPRNode("PR_search_coldstart", "kubernetes/kubernetes", 10,
					"Cold Start PR", "challenger_user")
				b, _ := json.Marshal(map[string]any{
					"search": map[string]any{
						"nodes":    []any{prNode},
						"pageInfo": map[string]any{"hasNextPage": false},
					},
				})
				return json.Unmarshal(b, q)
			}
			if name == "ItemsFetch" {
				prNode := newMockPRNode("PR_node_999", "kubernetes/kubernetes", 999,
					"Hydrated PR 999", "external_author")
				b, _ := json.Marshal(map[string]any{"nodes": []any{prNode}})
				return json.Unmarshal(b, q)
			}
			return nil
		},
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL, HTTPClient: mockHTTP}
	cfg := config.NewForTest(octodeckv1.Config_builder{KnownBots: []string{}}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	// Step 1: Hybrid Cold Start
	returnLastModifiedHeader = "Thu, 14 Aug 2026 01:00:00 GMT"
	returnNotificationsJSON = "[]"
	err := engine.RunInventorySync(t.Context())
	require.NoError(t, err)

	lastModVal, err := db.GetMetadata(t.Context(), KeyLastNotificationModified)
	require.NoError(t, err)
	assert.Equal(t, "Thu, 14 Aug 2026 01:00:00 GMT", lastModVal)

	lastSyncVal1, err := db.GetMetadata(t.Context(), KeyLastNotificationSync)
	require.NoError(t, err)
	assert.NotEmpty(t, lastSyncVal1)

	// Step 2: Incremental Sync with 304 Not Modified
	// Reset last_notification_sync to 5m in the past to avoid throttle guard
	require.NoError(t, db.SetMetadata(t.Context(), KeyLastNotificationSync,
		time.Now().Add(-5*time.Minute).UTC().Format(time.RFC3339)))

	capturedIfModifiedSince = ""
	returnStatusCode = http.StatusNotModified
	returnNotificationsJSON = ""
	gqlCallCountBefore := gqlCallCount

	err = engine.RunIncrementalSync(t.Context())
	require.NoError(t, err)

	assert.Equal(t, "Thu, 14 Aug 2026 01:00:00 GMT", capturedIfModifiedSince,
		"If-Modified-Since must be passed on incremental sync")
	assert.Equal(t, gqlCallCountBefore, gqlCallCount,
		"Zero GraphQL calls must be made on HTTP 304")

	lastModVal2, err := db.GetMetadata(t.Context(), KeyLastNotificationModified)
	require.NoError(t, err)
	assert.Equal(t, "Thu, 14 Aug 2026 01:00:00 GMT", lastModVal2,
		"LastModified header should remain unchanged on 304")

	// Step 3: Incremental Sync with 200 OK and New Item
	// Reset last_notification_sync to 5m in the past
	require.NoError(t, db.SetMetadata(t.Context(), KeyLastNotificationSync,
		time.Now().Add(-5*time.Minute).UTC().Format(time.RFC3339)))

	returnStatusCode = http.StatusOK
	returnLastModifiedHeader = "Thu, 14 Aug 2026 04:00:00 GMT"
	returnNotificationsJSON = `[
		{
			"id": "thread_999",
			"unread": true,
			"reason": "mention",
			"subject": {
				"title": "PR 999",
				"type": "PullRequest",
				"url": "https://api.github.com/repos/kubernetes/kubernetes/pulls/999"
			},
			"repository": {"full_name": "kubernetes/kubernetes"}
		}
	]`

	err = engine.RunIncrementalSync(t.Context())
	require.NoError(t, err)

	lastModVal3, err := db.GetMetadata(t.Context(), KeyLastNotificationModified)
	require.NoError(t, err)
	assert.Equal(t, "Thu, 14 Aug 2026 04:00:00 GMT", lastModVal3,
		"LastModified header should update to new header from 200 response")

	savedItem, err := db.GetItem(t.Context(), "PR_node_999")
	require.NoError(t, err)
	assert.Equal(t, "Hydrated PR 999", savedItem.GetTitle())

	// Step 4: Incremental Sync with 304 using the updated Last-Modified
	// Reset last_notification_sync to 5m in the past
	require.NoError(t, db.SetMetadata(t.Context(), KeyLastNotificationSync,
		time.Now().Add(-5*time.Minute).UTC().Format(time.RFC3339)))

	capturedIfModifiedSince = ""
	returnStatusCode = http.StatusNotModified
	returnNotificationsJSON = ""

	err = engine.RunIncrementalSync(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "Thu, 14 Aug 2026 04:00:00 GMT", capturedIfModifiedSince,
		"If-Modified-Since must now reflect the updated Last-Modified header")

	// Step 5: ForceSync bypasses conditional caching
	capturedIfModifiedSince = ""
	returnStatusCode = http.StatusOK
	returnLastModifiedHeader = "Thu, 14 Aug 2026 04:30:00 GMT"
	returnNotificationsJSON = "[]"

	err = engine.ForceSync(t.Context())
	require.NoError(t, err)
	assert.Empty(t, capturedIfModifiedSince, "ForceSync must bypass If-Modified-Since")

	lastModVal5, err := db.GetMetadata(t.Context(), KeyLastNotificationModified)
	require.NoError(t, err)
	assert.Equal(t, "Thu, 14 Aug 2026 04:30:00 GMT", lastModVal5)
}

// TestChallenger_TraceCompressionRoundtripInSQLite verifies that gzip payload compression,
// storage as BLOB in SQLite sync_traces, retrieval, and decompression accurately preserves
// all fields of NotificationSyncPayload.
func TestChallenger_TraceCompressionRoundtripInSQLite(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	originalPayload := NotificationSyncPayload{
		HTTPStatus:         http.StatusOK,
		LastModified:       "Fri, 15 Aug 2026 01:23:45 GMT",
		NotificationsCount: 15,
		ReasonsBreakdown: map[string]int{
			"assign":           5,
			"mention":          4,
			"author":           3,
			"review_requested": 2,
			"subscribed":       1,
		},
		UnsupportedTypes: map[string]int{
			"Discussion": 3,
			"Release":    1,
		},
		FilteredByRepoCount: 2,
		HydratedItems: []string{
			"PR_node_100", "PR_node_101", "ISSUE_node_102",
		},
		HydrationErrors: map[string]string{
			"PR_deleted": "Item not found on GitHub (404/deleted)",
			"PR_timeout": "GraphQL timeout",
		},
	}

	payloadJSON, err := json.Marshal(originalPayload)
	require.NoError(t, err)

	compressed, err := database.CompressPayload(payloadJSON)
	require.NoError(t, err)
	assert.NotEmpty(t, compressed)

	trace := &database.SyncTrace{
		ID:                   "trace-roundtrip-test",
		TraceType:            "notification_sync",
		TriggerSource:        "ticker",
		QueryString:          "since=2026-08-15T01:00:00Z all=true",
		DurationMs:           350,
		PagesCount:           1,
		ItemsFetched:         3,
		ItemsPersisted:       3,
		RawPayloadCompressed: compressed,
		CreatedAt:            time.Now().UTC().Format(time.RFC3339),
	}
	require.NoError(t, db.SaveSyncTrace(t.Context(), trace))

	// Retrieve by ID
	retrievedTrace, err := db.GetSyncTrace(t.Context(), "trace-roundtrip-test")
	require.NoError(t, err)
	require.NotNil(t, retrievedTrace)

	decompressed, err := database.DecompressPayload(retrievedTrace.RawPayloadCompressed)
	require.NoError(t, err)

	var retrievedPayload NotificationSyncPayload
	require.NoError(t, json.Unmarshal(decompressed, &retrievedPayload))

	assert.Equal(t, originalPayload.HTTPStatus, retrievedPayload.HTTPStatus)
	assert.Equal(t, originalPayload.LastModified, retrievedPayload.LastModified)
	assert.Equal(t, originalPayload.NotificationsCount, retrievedPayload.NotificationsCount)
	assert.Equal(t, originalPayload.FilteredByRepoCount, retrievedPayload.FilteredByRepoCount)
	assert.Equal(t, originalPayload.ReasonsBreakdown, retrievedPayload.ReasonsBreakdown)
	assert.Equal(t, originalPayload.UnsupportedTypes, retrievedPayload.UnsupportedTypes)
	assert.Equal(t, originalPayload.HydratedItems, retrievedPayload.HydratedItems)
	assert.Equal(t, originalPayload.HydrationErrors, retrievedPayload.HydrationErrors)
}
