package logic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"testing"
	"time"

	graphql "github.com/cli/shurcooL-graphql"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/github"
)

// pagedSearchMock answers SearchCandidates with pages of one PR each, updated one minute apart
// from firstUpdate, reporting a next page while page < pages. ItemsFetch hydrates every
// requested ID as an open PR unless fetchErr is set.
type pagedSearchMock struct {
	pages       int
	firstUpdate time.Time
	fetchErr    error

	queries  []string
	cursors  []any
	hydrated []string
}

func (m *pagedSearchMock) query(_ context.Context, name string, q any, vars map[string]any) error {
	switch name {
	case "SearchCandidates":
		m.queries = append(m.queries, fmt.Sprint(vars["query"]))
		var cursor any
		if c, ok := vars["cursor"].(*graphql.String); ok && c != nil {
			cursor = string(*c)
		}
		m.cursors = append(m.cursors, cursor)
		page := len(m.cursors)
		b, _ := json.Marshal(map[string]any{"search": map[string]any{
			"nodes": []any{map[string]any{
				"__typename": "PullRequest",
				"pullRequest": map[string]any{
					"id":        fmt.Sprintf("PR_PAGE_%d", page),
					"updatedAt": m.firstUpdate.Add(time.Duration(page-1) * time.Minute).Format(time.RFC3339),
				},
			}},
			"pageInfo": map[string]any{"hasNextPage": page < m.pages, "endCursor": fmt.Sprintf("c%d", page)},
		}})
		return json.Unmarshal(b, q)
	case "ItemsFetch":
		if m.fetchErr != nil {
			return m.fetchErr
		}
		ids, _ := vars["ids"].([]string)
		m.hydrated = append(m.hydrated, ids...)
		nodes := make([]any, 0, len(ids))
		for i, id := range ids {
			nodes = append(nodes, mockPullRequestNode(id, "kubernetes/kubernetes", int32(1000+i)))
		}
		b, _ := json.Marshal(map[string]any{"nodes": nodes})
		return json.Unmarshal(b, q)
	}
	return nil
}

func newPagedDiscoveryEngine(t *testing.T, query string, m *pagedSearchMock) (*SyncEngine, *database.DB) {
	t.Helper()
	db := setupTestDB(t)
	t.Cleanup(func() { require.NoError(t, db.Close()) })
	ghClient := &github.Client{GraphQLClient: &mockGraphQLClient{queryFunc: m.query}, CurrentUser: "testuser"}
	cfg := config.NewForTest(octodeckv1.Config_builder{TrackedQueries: []string{query}, KnownBots: []string{}}.Build())
	return NewSyncEngine(db, ghClient, cfg), db
}

func discoveryPayload(t *testing.T, db *database.DB) DiscoverySyncPayload {
	t.Helper()
	traces, err := db.GetSyncTraces(t.Context(), 1, traceTypeDiscovery)
	require.NoError(t, err)
	require.Len(t, traces, 1)
	raw, err := database.DecompressPayload(traces[0].RawPayloadCompressed)
	require.NoError(t, err)
	var p DiscoverySyncPayload
	require.NoError(t, json.Unmarshal(raw, &p))
	return p
}

func TestBuildDiscoverySearchQuery_SortsByUpdateAscending(t *testing.T) {
	since := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		base, want string
	}{
		{"repo:a/b is:open", "repo:a/b is:open updated:>2026-09-01T12:00:00Z sort:updated-asc"},
		{"repo:a/b sort:created-desc is:open", "repo:a/b  is:open updated:>2026-09-01T12:00:00Z sort:updated-asc"},
		{"sort:comments repo:a/b", "repo:a/b updated:>2026-09-01T12:00:00Z sort:updated-asc"},
		{"repo:a/b label:resort:x", "repo:a/b label:resort:x updated:>2026-09-01T12:00:00Z sort:updated-asc"},
	}
	for _, tc := range tests {
		assert.Equal(t, tc.want, BuildDiscoverySearchQuery(tc.base, since), "base %q", tc.base)
	}
}

func TestRunDiscovery_PagesAndResumesFromNewestUpdateWhenCapped(t *testing.T) {
	const query = "repo:kubernetes/kubernetes is:open"
	cursor := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	m := &pagedSearchMock{pages: DiscoveryMaxSearchPages + 3, firstUpdate: cursor.Add(time.Minute)}
	engine, db := newPagedDiscoveryEngine(t, query, m)
	ctx := t.Context()
	require.NoError(t, db.SetDiscoveryCursor(ctx, query, cursor))

	require.NoError(t, engine.RunDiscovery(ctx))

	require.Len(t, m.cursors, DiscoveryMaxSearchPages, "the search stops at the page cap")
	assert.Nil(t, m.cursors[0])
	assert.Equal(t, "c1", m.cursors[1], "later pages follow the search cursor")
	assert.Contains(t, m.queries[0], "sort:updated-asc")
	assert.Len(t, m.hydrated, DiscoveryMaxSearchPages)

	// The cursor moves to the newest update reached, not to the search time.
	newest := m.firstUpdate.Add(time.Duration(DiscoveryMaxSearchPages-1) * time.Minute)
	got, ok, err := db.GetDiscoveryCursor(ctx, query)
	require.NoError(t, err)
	require.True(t, ok)
	assert.True(t, newest.Equal(got), "cursor %v, want %v", got, newest)

	p := discoveryPayload(t, db)
	assert.Equal(t, []string{query}, p.TruncatedQueries)

	// The next run resumes from there (minus the indexing buffer).
	m.cursors, m.queries = nil, nil
	require.NoError(t, engine.RunDiscovery(ctx))
	require.NotEmpty(t, m.queries)
	wantSince := newest.Add(-DiscoveryIndexingBuffer).Format("2006-01-02T15:04:05Z")
	assert.Contains(t, m.queries[0], "updated:>"+wantSince)
}

func TestRunDiscovery_CompleteSearchMovesCursorToSearchTime(t *testing.T) {
	const query = "repo:kubernetes/kubernetes is:open"
	cursor := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	m := &pagedSearchMock{pages: 2, firstUpdate: cursor.Add(time.Minute)}
	engine, db := newPagedDiscoveryEngine(t, query, m)
	ctx := t.Context()
	require.NoError(t, db.SetDiscoveryCursor(ctx, query, cursor))

	before := time.Now().UTC().Add(-time.Second)
	require.NoError(t, engine.RunDiscovery(ctx))

	assert.Len(t, m.cursors, 2)
	got, _, err := db.GetDiscoveryCursor(ctx, query)
	require.NoError(t, err)
	assert.True(t, got.After(before), "cursor %v should be the search start time", got)
	assert.Empty(t, discoveryPayload(t, db).TruncatedQueries)
}

func TestRunDiscovery_HydrationFailureKeepsCursorAndYield(t *testing.T) {
	const query = "repo:kubernetes/kubernetes is:open"
	cursor := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	m := &pagedSearchMock{pages: 1, firstUpdate: cursor.Add(time.Minute), fetchErr: errors.New("boom")}
	engine, db := newPagedDiscoveryEngine(t, query, m)
	ctx := t.Context()
	require.NoError(t, db.SetDiscoveryCursor(ctx, query, cursor))

	require.Error(t, engine.RunDiscovery(ctx))

	got, ok, err := db.GetDiscoveryCursor(ctx, query)
	require.NoError(t, err)
	require.True(t, ok)
	assert.True(t, cursor.Equal(got), "a failed hydration must not move the cursor (got %v)", got)
	avg7d, _, err := db.GetDiscoveryQueryStats(ctx, query, time.Now())
	require.NoError(t, err)
	assert.Zero(t, avg7d, "nothing was stored, so no yield is recorded")

	// The next run searches the same range again and stores the candidate.
	m.fetchErr = nil
	m.queries, m.cursors = nil, nil
	require.NoError(t, engine.RunDiscovery(ctx))
	wantSince := cursor.Add(-DiscoveryIndexingBuffer).Format("2006-01-02T15:04:05Z")
	require.NotEmpty(t, m.queries)
	assert.Contains(t, m.queries[0], "updated:>"+wantSince)
	_, err = db.GetItem(ctx, "PR_PAGE_1")
	require.NoError(t, err)
}

func TestNextDiscoveryCursor(t *testing.T) {
	cursor := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	searchedAt := cursor.Add(time.Hour)
	candidates := func(updates ...time.Time) github.SearchCandidatesResult {
		res := github.SearchCandidatesResult{Truncated: true}
		for i, u := range updates {
			res.Candidates = append(res.Candidates, github.SearchCandidate{ID: strconv.Itoa(i), UpdatedAt: u})
		}
		return res
	}
	tests := []struct {
		name string
		res  github.SearchCandidatesResult
		want time.Time
	}{
		{
			name: "complete search",
			res:  github.SearchCandidatesResult{Candidates: candidates(cursor.Add(time.Minute)).Candidates},
			want: searchedAt,
		},
		{
			name: "capped search resumes from the newest update",
			res:  candidates(cursor.Add(time.Minute), cursor.Add(3*time.Minute), cursor.Add(2*time.Minute)),
			want: cursor.Add(3 * time.Minute),
		},
		{
			name: "capped search inside the indexing buffer skips the buffer",
			res:  candidates(cursor.Add(-time.Minute), cursor),
			want: cursor.Add(DiscoveryIndexingBuffer),
		},
		{
			name: "capped search without update times resumes from the search time",
			res:  candidates(time.Time{}),
			want: searchedAt,
		},
		{
			name: "never past the search time",
			res:  candidates(searchedAt.Add(time.Minute)),
			want: searchedAt,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := nextDiscoveryCursor(t.Context(), "q", cursor, searchedAt, tc.res)
			assert.True(t, tc.want.Equal(got), "got %v, want %v", got, tc.want)
		})
	}
}
