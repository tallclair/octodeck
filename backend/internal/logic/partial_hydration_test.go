package logic

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/github"
)

func TestRunDiscovery_RetriesFailedCandidateThenPassesOver(t *testing.T) {
	const query = "repo:kubernetes/kubernetes is:open"
	cursor := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	// Every run returns the same capped 5 pages; page 2's item can never be hydrated.
	m := &pagedSearchMock{
		pages:       DiscoveryMaxSearchPages + 2,
		firstUpdate: cursor.Add(time.Minute),
		forbidden:   map[string]bool{"PR_PAGE_2": true},
	}
	engine, db := newPagedDiscoveryEngine(t, query, m)
	ctx := t.Context()
	require.NoError(t, db.SetDiscoveryCursor(ctx, query, cursor))
	failedUpdate := m.firstUpdate.Add(time.Minute)
	newest := m.firstUpdate.Add(time.Duration(DiscoveryMaxSearchPages-1) * time.Minute)

	for attempt := 1; attempt <= discoveryMaxHydrationAttempts; attempt++ {
		m.cursors, m.hydrated = nil, nil
		require.NoError(t, engine.RunDiscovery(ctx), "attempt %d", attempt)

		assert.Contains(t, m.hydrated, "PR_PAGE_2", "attempt %d retries the failed candidate", attempt)
		got, _, err := db.GetDiscoveryCursor(ctx, query)
		require.NoError(t, err)
		assert.True(t, failedUpdate.Equal(got),
			"attempt %d: the cursor is held at the failed candidate (got %v)", attempt, got)
		p := discoveryPayload(t, db)
		assert.Contains(t, p.HydrationFailures["PR_PAGE_2"], "SAML")
		assert.Empty(t, p.AbandonedIDs)
	}
	// The other candidates were stored on the first run.
	_, err := db.GetItem(ctx, "PR_PAGE_3")
	require.NoError(t, err)

	// Out of attempts: the candidate is passed over and the cursor moves on.
	m.cursors, m.hydrated = nil, nil
	require.NoError(t, engine.RunDiscovery(ctx))
	got, _, err := db.GetDiscoveryCursor(ctx, query)
	require.NoError(t, err)
	assert.True(t, newest.Equal(got), "the cursor advances once the candidate is abandoned (got %v)", got)
	assert.Equal(t, []string{"PR_PAGE_2"}, discoveryPayload(t, db).AbandonedIDs)
	_, err = db.GetItem(ctx, "PR_PAGE_2")
	require.Error(t, err, "an abandoned candidate is not stored")
}

func TestDiscoveryQueryProgress_CursorWithRetries(t *testing.T) {
	prev := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	p := discoveryQueryProgress{
		prevCursor: prev,
		cursor:     prev.Add(time.Hour),
		candidates: []github.SearchCandidate{
			{ID: "a", UpdatedAt: prev.Add(10 * time.Minute)},
			{ID: "b", UpdatedAt: prev.Add(5 * time.Minute)},
			{ID: "early", UpdatedAt: prev.Add(-time.Minute)},
			{ID: "no-update-time"},
		},
	}
	tests := []struct {
		name  string
		retry []string
		want  time.Time
	}{
		{"no retries", nil, prev.Add(time.Hour)},
		{"held at the earliest retried candidate", []string{"a", "b"}, prev.Add(5 * time.Minute)},
		{"never moves backwards", []string{"early"}, prev},
		{"missing update time keeps the cursor", []string{"no-update-time", "a"}, prev},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			retry := map[string]struct{}{}
			for _, id := range tc.retry {
				retry[id] = struct{}{}
			}
			got := p.cursorWithRetries(retry)
			assert.True(t, tc.want.Equal(got), "got %v, want %v", got, tc.want)
		})
	}
}

func TestTrackDiscoveryHydrationFailures_UnstorableCountsDontRetry(t *testing.T) {
	engine, db := newPagedDiscoveryEngine(t, "repo:a/b", &pagedSearchMock{})
	ctx := t.Context()
	_, err := db.ExecContext(ctx, `CREATE TRIGGER fail_counts BEFORE INSERT ON metadata
		WHEN NEW.key = '`+KeyDiscoveryHydrationFailures+`' BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
	require.NoError(t, err)

	retry, abandoned := engine.trackDiscoveryHydrationFailures(ctx, map[string]string{"x": "FORBIDDEN"})
	assert.Empty(t, retry, "without stored counts, retries could repeat forever")
	assert.Equal(t, []string{"x"}, abandoned)
}

// forbiddenNodeGQL hydrates every requested ID as an open issue, except that forbidden IDs come
// back null with a FORBIDDEN error and gone IDs null with a NOT_FOUND error.
func forbiddenNodeGQL(forbidden, gone map[string]bool, hydrated *[]string) *mockGraphQLClient {
	return &mockGraphQLClient{queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
		if name != "ItemsFetch" {
			return nil
		}
		ids, _ := vars["ids"].([]string)
		*hydrated = append(*hydrated, ids...)
		nodes := make([]any, 0, len(ids))
		var errs []api.GraphQLErrorItem
		for i, id := range ids {
			path := []any{"nodes", float64(i)}
			switch {
			case forbidden[id]:
				nodes = append(nodes, nil)
				errs = append(errs, api.GraphQLErrorItem{Type: "FORBIDDEN", Path: path, Message: "SAML enforcement"})
			case gone[id]:
				nodes = append(nodes, nil)
				errs = append(errs, api.GraphQLErrorItem{Type: "NOT_FOUND", Path: path, Message: "gone"})
			default:
				nodes = append(nodes, map[string]any{"__typename": "Issue", "issue": map[string]any{
					"id": id, "repository": map[string]any{"nameWithOwner": "o/r"}, "number": 1,
					"state": "OPEN", "title": "Refreshed " + id, "url": "https://github.com/o/r/issues/1",
					"updatedAt": time.Now().UTC().Format(time.RFC3339),
					"author":    map[string]any{"login": "someone"},
				}})
			}
		}
		b, _ := json.Marshal(map[string]any{"nodes": nodes})
		if err := json.Unmarshal(b, q); err != nil {
			return err
		}
		if len(errs) > 0 {
			return &api.GraphQLError{Errors: errs}
		}
		return nil
	}}
}

func TestRunGarbageCollection_PartialBatchErrors(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()
	stale := time.Now().Add(-config.DefaultStaleItemAge - 24*time.Hour)
	var items []*octodeckv1.Item
	for i, id := range []string{"ISSUE_OK", "ISSUE_FORBIDDEN", "ISSUE_GONE"} {
		items = append(items, octodeckv1.Item_builder{
			Id: config.Ptr(id), Repo: config.Ptr("o/r"), Number: config.Ptr(int32(i + 1)),
			Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
			State:              config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			ViewerSubscription: config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED),
			Title:              config.Ptr("Stale " + id),
			UpdatedAt:          timestamppb.New(stale), LastSyncedAt: timestamppb.New(stale),
			Local: octodeckv1.ItemLocalState_builder{}.Build(),
		}.Build())
	}
	require.NoError(t, db.SaveItems(t.Context(), items))

	var hydrated []string
	gql := forbiddenNodeGQL(map[string]bool{"ISSUE_FORBIDDEN": true}, map[string]bool{"ISSUE_GONE": true}, &hydrated)
	engine := NewSyncEngine(db, &github.Client{GraphQLClient: gql, CurrentUser: "testuser"},
		config.NewForTest(octodeckv1.Config_builder{}.Build()))

	require.NoError(t, engine.RunGarbageCollection(t.Context()), "one bad item must not fail GC")

	ok, err := db.GetItem(t.Context(), "ISSUE_OK")
	require.NoError(t, err)
	assert.Equal(t, "Refreshed ISSUE_OK", ok.GetTitle())
	forbidden, err := db.GetItem(t.Context(), "ISSUE_FORBIDDEN")
	require.NoError(t, err, "a forbidden item is kept, not deleted")
	assert.Equal(t, "Stale ISSUE_FORBIDDEN", forbidden.GetTitle())
	_, err = db.GetItem(t.Context(), "ISSUE_GONE")
	require.Error(t, err, "a NOT_FOUND item is deleted like any missing item")
}

func TestRunIncrementalSync_PartialHydrationErrors(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()
	ctx := t.Context()
	// Both items are stored, so the notifications resolve without a node ID lookup.
	for i, id := range []string{"ISSUE_OK", "ISSUE_FORBIDDEN"} {
		require.NoError(t, db.SaveItems(ctx, []*octodeckv1.Item{octodeckv1.Item_builder{
			Id: config.Ptr(id), Repo: config.Ptr("o/r"), Number: config.Ptr(int32(i + 1)),
			Type:  config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
			State: config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			Title: config.Ptr("Old " + id), UpdatedAt: timestamppb.New(time.Now().Add(-time.Hour)),
			Local: octodeckv1.ItemLocalState_builder{}.Build(),
		}.Build()}))
	}
	threads := []github.NotificationThread{
		{ID: "t1", Reason: "mention", UpdatedAt: time.Now().UTC().Format(time.RFC3339),
			Subject: github.NotificationSubject{Type: "Issue", URL: "https://api.github.com/repos/o/r/issues/1"}},
		{ID: "t2", Reason: "mention", UpdatedAt: time.Now().UTC().Format(time.RFC3339),
			Subject: github.NotificationSubject{Type: "Issue", URL: "https://api.github.com/repos/o/r/issues/2"}},
	}
	body, _ := json.Marshal(threads)
	httpClient := &mockHTTPClient{doFunc: func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header),
			Body: io.NopCloser(bytes.NewReader(body))}, nil
	}}
	var hydrated []string
	gql := forbiddenNodeGQL(map[string]bool{"ISSUE_FORBIDDEN": true}, nil, &hydrated)
	engine := NewSyncEngine(db, &github.Client{GraphQLClient: gql, HTTPClient: httpClient, CurrentUser: "testuser"},
		config.NewForTest(octodeckv1.Config_builder{}.Build()))

	require.NoError(t, engine.RunIncrementalSync(ctx), "one bad item must not fail the sync")

	assert.ElementsMatch(t, []string{"ISSUE_OK", "ISSUE_FORBIDDEN"}, hydrated)
	ok, err := db.GetItem(ctx, "ISSUE_OK")
	require.NoError(t, err)
	assert.Equal(t, "Refreshed ISSUE_OK", ok.GetTitle())
	forbidden, err := db.GetItem(ctx, "ISSUE_FORBIDDEN")
	require.NoError(t, err)
	assert.Equal(t, "Old ISSUE_FORBIDDEN", forbidden.GetTitle(), "a forbidden item is left as it was")
	assert.Empty(t, forbidden.GetLocal().GetSyncError(), "it is not marked as deleted")
}
