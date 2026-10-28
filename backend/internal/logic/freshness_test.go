package logic

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/api"
	graphql "github.com/cli/shurcooL-graphql"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/github"
)

// freshnessGitHub is a fake GitHub for the freshness sweep. SearchCandidates returns results in
// pages of pageSize (all on one page if pageSize is 0); ItemsFetch hydrates each requested ID
// as a PR with its search update time and state (OPEN unless set in states), unless fetchErr is
// set or the ID is forbidden.
type freshnessGitHub struct {
	mu        sync.Mutex
	results   []github.SearchCandidate
	pageSize  int
	states    map[string]string
	fetchErr  error
	forbidden map[string]bool
	// blockSearch makes searches wait for their context to end.
	blockSearch bool
	// searchErr makes searches fail.
	searchErr error

	queries  []string
	hydrated []string
}

func (f *freshnessGitHub) query(ctx context.Context, name string, q any, vars map[string]any) error {
	if f.blockSearch && name == "SearchCandidates" {
		<-ctx.Done()
		return ctx.Err()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	switch name {
	case "SearchCandidates":
		if c, ok := vars["cursor"].(*graphql.String); !ok || c == nil {
			// Record each search once, at its first page.
			f.queries = append(f.queries, fmt.Sprint(vars["query"]))
		}
		if f.searchErr != nil {
			return f.searchErr
		}
		return f.search(q, vars)
	case "ItemsFetch":
		return f.fetch(q, vars)
	}
	return nil
}

func (f *freshnessGitHub) search(q any, vars map[string]any) error {
	page := 0
	if c, ok := vars["cursor"].(*graphql.String); ok && c != nil {
		_, _ = fmt.Sscanf(string(*c), "c%d", &page)
	}
	size := f.pageSize
	if size == 0 {
		size = max(len(f.results), 1)
	}
	start := min(page*size, len(f.results))
	end := min(start+size, len(f.results))
	nodes := make([]any, 0, end-start)
	for _, c := range f.results[start:end] {
		nodes = append(nodes, map[string]any{
			"__typename":  "PullRequest",
			"pullRequest": map[string]any{"id": c.ID, "updatedAt": c.UpdatedAt.Format(time.RFC3339)},
		})
	}
	b, _ := json.Marshal(map[string]any{"search": map[string]any{
		"nodes":    nodes,
		"pageInfo": map[string]any{"hasNextPage": end < len(f.results), "endCursor": fmt.Sprintf("c%d", page+1)},
	}})
	return json.Unmarshal(b, q)
}

func (f *freshnessGitHub) fetch(q any, vars map[string]any) error {
	if f.fetchErr != nil {
		return f.fetchErr
	}
	ids, _ := vars["ids"].([]string)
	f.hydrated = append(f.hydrated, ids...)
	nodes := make([]any, 0, len(ids))
	var errs []api.GraphQLErrorItem
	for i, id := range ids {
		if f.forbidden[id] {
			nodes = append(nodes, nil)
			errs = append(errs, api.GraphQLErrorItem{
				Type: "FORBIDDEN", Path: []any{"nodes", float64(i)}, Message: "SAML enforcement",
			})
			continue
		}
		node := mockPullRequestNode(id, "kubernetes/kubernetes", int32(100+i))
		pr, _ := node["pullRequest"].(map[string]any)
		for _, c := range f.results {
			if c.ID == id {
				pr["updatedAt"] = c.UpdatedAt.Format(time.RFC3339)
			}
		}
		if s, ok := f.states[id]; ok {
			pr["state"] = s
		}
		nodes = append(nodes, node)
	}
	b, _ := json.Marshal(map[string]any{"nodes": nodes})
	if err := json.Unmarshal(b, q); err != nil {
		return err
	}
	if len(errs) > 0 {
		return &api.GraphQLError{Errors: errs}
	}
	return nil
}

func (f *freshnessGitHub) snapshot() (queries, hydrated []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.queries), slices.Clone(f.hydrated)
}

func (f *freshnessGitHub) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.queries, f.hydrated = nil, nil
}

func newFreshnessEngine(t *testing.T, f *freshnessGitHub) (*SyncEngine, *database.DB) {
	t.Helper()
	db := setupTestDB(t)
	t.Cleanup(func() { require.NoError(t, db.Close()) })
	ghClient := &github.Client{GraphQLClient: &mockGraphQLClient{queryFunc: f.query}, CurrentUser: "testuser"}
	cfg := config.NewForTest(octodeckv1.Config_builder{KnownBots: []string{}}.Build())
	return NewSyncEngine(db, ghClient, cfg), db
}

// storeFreshnessItem stores an open PR last updated on GitHub at updatedAt.
func storeFreshnessItem(t *testing.T, db *database.DB, id string, updatedAt time.Time) {
	t.Helper()
	item := octodeckv1.Item_builder{
		Id:           config.Ptr(id),
		Repo:         config.Ptr("kubernetes/kubernetes"),
		Number:       config.Ptr(int32(1)),
		Type:         config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:        config.Ptr("Title for " + id),
		State:        config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		UpdatedAt:    timestamppb.New(updatedAt),
		LastSyncedAt: timestamppb.New(updatedAt),
	}.Build()
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{item}))
}

func setFreshnessCursor(t *testing.T, db *database.DB, cursor time.Time) {
	t.Helper()
	require.NoError(t, db.SetMetadata(t.Context(), KeyFreshnessSweepCursor, cursor.Format(time.RFC3339Nano)))
}

func freshnessCursor(t *testing.T, db *database.DB) time.Time {
	t.Helper()
	raw, err := db.GetMetadata(t.Context(), KeyFreshnessSweepCursor)
	require.NoError(t, err)
	c, err := time.Parse(time.RFC3339Nano, raw)
	require.NoError(t, err)
	return c
}

func latestFreshnessTrace(t *testing.T, db *database.DB) (*database.SyncTrace, FreshnessSweepPayload) {
	t.Helper()
	traces, err := db.GetSyncTraces(t.Context(), 100, traceTypeFreshnessSweep)
	require.NoError(t, err)
	require.NotEmpty(t, traces)
	// Traces created within the same second tie on created_at; IDs end in a nanosecond stamp.
	latest := slices.MaxFunc(traces, func(a, b *database.SyncTrace) int { return strings.Compare(a.ID, b.ID) })
	raw, err := database.DecompressPayload(latest.RawPayloadCompressed)
	require.NoError(t, err)
	var p FreshnessSweepPayload
	require.NoError(t, json.Unmarshal(raw, &p))
	return latest, p
}

var updatedQualifier = regexp.MustCompile(`updated:>(\S+)`)

// searchSince returns the time in the updated:> qualifier of a search query.
func searchSince(t *testing.T, query string) time.Time {
	t.Helper()
	m := updatedQualifier.FindStringSubmatch(query)
	require.Len(t, m, 2, "query %q has no updated:> qualifier", query)
	since, err := time.Parse(time.RFC3339, m[1])
	require.NoError(t, err)
	return since
}

func TestFreshnessSweep_RefetchesOnlyStoredItemsUpdatedOnGitHub(t *testing.T) {
	base := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	f := &freshnessGitHub{
		results: []github.SearchCandidate{
			{ID: "PR_CHANGED", UpdatedAt: base.Add(time.Hour)},
			{ID: "PR_UNCHANGED", UpdatedAt: base},
			{ID: "PR_UNKNOWN", UpdatedAt: base.Add(time.Hour)},
		},
		states: map[string]string{"PR_CHANGED": "CLOSED"},
	}
	engine, db := newFreshnessEngine(t, f)
	ctx := t.Context()
	storeFreshnessItem(t, db, "PR_CHANGED", base)
	storeFreshnessItem(t, db, "PR_UNCHANGED", base)
	setFreshnessCursor(t, db, base.Add(-time.Hour))

	require.NoError(t, engine.RunFreshnessSweep(ctx))

	queries, hydrated := f.snapshot()
	require.Len(t, queries, 1)
	assert.Contains(t, queries[0], "involves:@me")
	assert.Contains(t, queries[0], "sort:updated-asc")
	assert.NotContains(t, queries[0], "is:open", "closed and merged items must be found too")
	assert.Equal(t, []string{"PR_CHANGED"}, hydrated, "only stored items newer on GitHub are re-fetched")

	changed, err := db.GetItem(ctx, "PR_CHANGED")
	require.NoError(t, err)
	assert.Equal(t, octodeckv1.ItemState_ITEM_STATE_CLOSED, changed.GetState())
	assert.True(t, base.Add(time.Hour).Equal(changed.GetUpdatedAt().AsTime()))
	_, err = db.GetItem(ctx, "PR_UNKNOWN")
	require.Error(t, err, "unknown items are left to discovery")

	trace, p := latestFreshnessTrace(t, db)
	assert.Equal(t, triggerSourceFreshnessTicker, trace.TriggerSource)
	assert.Equal(t, queries[0], trace.QueryString)
	assert.Empty(t, trace.ErrorMessage)
	assert.Equal(t, 3, p.CandidatesFound)
	assert.Equal(t, 1, p.UnknownSkippedCount)
	assert.Equal(t, 1, p.UnchangedSkippedCount)
	assert.Equal(t, []string{"PR_CHANGED"}, p.StaleIDs)
	assert.Equal(t, 1, p.RefetchedCount)

	// The refreshed copy now matches GitHub, so the next sweep re-fetches nothing.
	f.reset()
	require.NoError(t, engine.RunFreshnessSweep(ctx))
	_, hydrated = f.snapshot()
	assert.Empty(t, hydrated)
}

func TestFreshnessSweep_FirstRunCatchesUpThirtyDays(t *testing.T) {
	f := &freshnessGitHub{}
	engine, db := newFreshnessEngine(t, f)
	ctx := t.Context()

	before := time.Now().UTC().Truncate(time.Second)
	require.NoError(t, engine.RunFreshnessSweep(ctx))
	after := time.Now().UTC()

	queries, _ := f.snapshot()
	require.Len(t, queries, 1)
	since := searchSince(t, queries[0])
	lo := before.Add(-FreshnessSweepCatchUp - DiscoveryIndexingBuffer)
	hi := after.Add(-FreshnessSweepCatchUp - DiscoveryIndexingBuffer)
	assert.False(t, since.Before(lo) || since.After(hi), "since %v, want within [%v, %v]", since, lo, hi)

	// A complete search moves the cursor to the search time; the next run starts there.
	cursor := freshnessCursor(t, db)
	assert.False(t, cursor.Before(before) || cursor.After(after), "cursor %v", cursor)
	f.reset()
	require.NoError(t, engine.RunFreshnessSweep(ctx))
	queries, _ = f.snapshot()
	require.Len(t, queries, 1)
	want := cursor.Add(-DiscoveryIndexingBuffer).Truncate(time.Second)
	assert.True(t, want.Equal(searchSince(t, queries[0])), "since %v, want %v", searchSince(t, queries[0]), want)
}

func TestFreshnessSweep_ResumesFromNewestUpdateWhenTruncated(t *testing.T) {
	cursor := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	f := &freshnessGitHub{pageSize: 1}
	for i := range DiscoveryMaxSearchPages + 2 {
		f.results = append(f.results, github.SearchCandidate{
			ID: fmt.Sprintf("PR_%d", i), UpdatedAt: cursor.Add(time.Duration(i+1) * time.Minute),
		})
	}
	engine, db := newFreshnessEngine(t, f)
	setFreshnessCursor(t, db, cursor)

	require.NoError(t, engine.RunFreshnessSweep(t.Context()))

	newest := cursor.Add(DiscoveryMaxSearchPages * time.Minute)
	got := freshnessCursor(t, db)
	assert.True(t, newest.Equal(got), "cursor %v, want the newest update reached %v", got, newest)
	_, p := latestFreshnessTrace(t, db)
	assert.True(t, p.Truncated)
	assert.Equal(t, DiscoveryMaxSearchPages, p.CandidatesFound)
}

func TestFreshnessSweep_FailedRefetchKeepsCursor(t *testing.T) {
	cursor := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	f := &freshnessGitHub{
		results:  []github.SearchCandidate{{ID: "PR_A", UpdatedAt: cursor.Add(time.Minute)}},
		fetchErr: errors.New("boom"),
	}
	engine, db := newFreshnessEngine(t, f)
	ctx := t.Context()
	storeFreshnessItem(t, db, "PR_A", cursor.Add(-time.Hour))
	setFreshnessCursor(t, db, cursor)

	require.Error(t, engine.RunFreshnessSweep(ctx))
	assert.True(t, cursor.Equal(freshnessCursor(t, db)), "a failed re-fetch must not move the cursor")
	trace, _ := latestFreshnessTrace(t, db)
	assert.Contains(t, trace.ErrorMessage, "boom")

	// The next run searches the same range again and stores the item.
	f.fetchErr = nil
	f.reset()
	require.NoError(t, engine.RunFreshnessSweep(ctx))
	queries, hydrated := f.snapshot()
	require.Len(t, queries, 1)
	assert.True(t, cursor.Add(-DiscoveryIndexingBuffer).Equal(searchSince(t, queries[0])))
	assert.Equal(t, []string{"PR_A"}, hydrated)
	assert.True(t, freshnessCursor(t, db).After(cursor))
}

func TestFreshnessSweep_SearchFailureKeepsCursor(t *testing.T) {
	for _, stored := range []bool{true, false} {
		t.Run(fmt.Sprintf("stored cursor %v", stored), func(t *testing.T) {
			cursor := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
			f := &freshnessGitHub{
				results:   []github.SearchCandidate{{ID: "PR_A", UpdatedAt: cursor.Add(time.Minute)}},
				searchErr: errors.New("search unavailable"),
			}
			engine, db := newFreshnessEngine(t, f)
			ctx := t.Context()
			storeFreshnessItem(t, db, "PR_A", cursor.Add(-time.Hour))
			if stored {
				setFreshnessCursor(t, db, cursor)
			}

			err := engine.RunFreshnessSweep(ctx)
			require.ErrorContains(t, err, "search unavailable")

			queries, hydrated := f.snapshot()
			assert.Len(t, queries, 1)
			assert.Empty(t, hydrated, "nothing is re-fetched without search results")
			if stored {
				assert.True(t, cursor.Equal(freshnessCursor(t, db)), "a failed search must not move the cursor")
			} else {
				_, err := db.GetMetadata(ctx, KeyFreshnessSweepCursor)
				require.ErrorIs(t, err, sql.ErrNoRows, "no seed is persisted, so the next run catches up again")
			}
			trace, _ := latestFreshnessTrace(t, db)
			assert.Contains(t, trace.ErrorMessage, "search unavailable")
		})
	}
}

func TestFreshnessSweep_UnknownCurrentUserFailsBeforeSearching(t *testing.T) {
	cursor := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	f := &freshnessGitHub{}
	engine, db := newFreshnessEngine(t, f)
	engine.gh.CurrentUser = ""
	engine.gh.RestClient = &mockRESTClient{doFunc: func(context.Context, string, string, io.Reader, any) error {
		return errors.New("github unreachable")
	}}
	setFreshnessCursor(t, db, cursor)

	err := engine.RunFreshnessSweep(t.Context())
	require.ErrorContains(t, err, "github unreachable")

	queries, _ := f.snapshot()
	assert.Empty(t, queries, "the sweep stops before searching")
	assert.True(t, cursor.Equal(freshnessCursor(t, db)))
	trace, _ := latestFreshnessTrace(t, db)
	assert.Contains(t, trace.ErrorMessage, "github unreachable")
}

func TestRunFreshnessSweep_SkippedWhileSweepRunning(t *testing.T) {
	f := &freshnessGitHub{}
	engine, db := newFreshnessEngine(t, f)
	engine.freshnessMu.Lock()
	finished := make(chan error, 1)
	go func() { finished <- engine.RunFreshnessSweep(t.Context()) }()
	select {
	case err := <-finished:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("a scheduled sweep must not wait behind a running sweep")
	}
	engine.freshnessMu.Unlock()

	queries, _ := f.snapshot()
	assert.Empty(t, queries)
	traces, err := db.GetSyncTraces(t.Context(), 10, traceTypeFreshnessSweep)
	require.NoError(t, err)
	assert.Empty(t, traces, "a skipped sweep records no trace")
}

func TestFreshnessSweep_RetriesItemsThatFailToRefetch(t *testing.T) {
	cursor := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	failedAt := cursor.Add(time.Minute)
	f := &freshnessGitHub{
		results: []github.SearchCandidate{
			{ID: "PR_FORBIDDEN", UpdatedAt: failedAt},
			{ID: "PR_OK", UpdatedAt: cursor.Add(2 * time.Minute)},
		},
		forbidden: map[string]bool{"PR_FORBIDDEN": true},
	}
	engine, db := newFreshnessEngine(t, f)
	ctx := t.Context()
	storeFreshnessItem(t, db, "PR_FORBIDDEN", cursor.Add(-time.Hour))
	storeFreshnessItem(t, db, "PR_OK", cursor.Add(-time.Hour))
	setFreshnessCursor(t, db, cursor)

	// The cursor is held at the failed item for discoveryMaxHydrationAttempts runs.
	for attempt := 1; attempt <= discoveryMaxHydrationAttempts; attempt++ {
		require.NoError(t, engine.RunFreshnessSweep(ctx))
		assert.True(t, failedAt.Equal(freshnessCursor(t, db)), "attempt %d: cursor %v", attempt, freshnessCursor(t, db))
		_, p := latestFreshnessTrace(t, db)
		assert.Contains(t, p.HydrationFailures, "PR_FORBIDDEN")
		assert.Empty(t, p.AbandonedIDs)
	}
	ok, err := db.GetItem(ctx, "PR_OK")
	require.NoError(t, err)
	assert.True(t, cursor.Add(2*time.Minute).Equal(ok.GetUpdatedAt().AsTime()), "other items are still stored")

	// Then it is passed over and the cursor moves on.
	require.NoError(t, engine.RunFreshnessSweep(ctx))
	_, p := latestFreshnessTrace(t, db)
	assert.Equal(t, []string{"PR_FORBIDDEN"}, p.AbandonedIDs)
	assert.True(t, freshnessCursor(t, db).After(failedAt))
}

func TestRefreshRecentItems_RateLimitedToOncePerMinute(t *testing.T) {
	f := &freshnessGitHub{}
	engine, db := newFreshnessEngine(t, f)
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	engine.clock = func() time.Time { return now }

	done, started := engine.startOnDemandFreshnessSweep(t.Context())
	require.True(t, started)
	require.NoError(t, <-done)
	trace, _ := latestFreshnessTrace(t, db)
	assert.Equal(t, triggerSourceAPI, trace.TriggerSource)

	now = now.Add(FreshnessSweepMinGap - time.Second)
	assert.False(t, engine.RefreshRecentItems(t.Context()), "within a minute of the previous sweep")

	now = now.Add(2 * time.Second)
	done, started = engine.startOnDemandFreshnessSweep(t.Context())
	require.True(t, started, "a minute after the previous sweep")
	require.NoError(t, <-done)

	// Scheduled sweeps count too.
	now = now.Add(time.Hour)
	require.NoError(t, engine.RunFreshnessSweep(t.Context()))
	now = now.Add(time.Second)
	assert.False(t, engine.RefreshRecentItems(t.Context()), "within a minute of a scheduled sweep")

	queries, _ := f.snapshot()
	assert.Len(t, queries, 3)
}

func TestRefreshRecentItems_NoOpWhileSweepRunning(t *testing.T) {
	engine, _ := newFreshnessEngine(t, &freshnessGitHub{})
	engine.freshnessMu.Lock()
	assert.False(t, engine.RefreshRecentItems(t.Context()))
	engine.freshnessMu.Unlock()
	engine.freshnessStateMu.Lock()
	defer engine.freshnessStateMu.Unlock()
	assert.True(t, engine.lastFreshnessSweepAt.IsZero(), "a skipped request doesn't count as a sweep")
}

func TestRefreshRecentItems_ResetsSweepTimer(t *testing.T) {
	engine, _ := newFreshnessEngine(t, &freshnessGitHub{})
	const fastTick = 20 * time.Millisecond
	ticker := time.NewTicker(fastTick)
	t.Cleanup(ticker.Stop)
	engine.tickerFreshness = ticker

	done, started := engine.startOnDemandFreshnessSweep(t.Context())
	require.True(t, started)
	require.NoError(t, <-done)
	// Drop a tick delivered before the reset.
	select {
	case <-ticker.C:
	default:
	}
	select {
	case <-ticker.C:
		t.Fatal("the background sweep timer should be reset to FreshnessSweepInterval")
	case <-time.After(10 * fastTick):
	}
}

func TestRefreshRecentItems_OutlivesRequestContext(t *testing.T) {
	f := &freshnessGitHub{}
	engine, db := newFreshnessEngine(t, f)
	ctx, cancel := context.WithCancel(t.Context())
	done, started := engine.startOnDemandFreshnessSweep(ctx)
	cancel()
	require.True(t, started)
	require.NoError(t, <-done)
	trace, _ := latestFreshnessTrace(t, db)
	assert.Empty(t, trace.ErrorMessage)
}

func TestRefreshRecentItems_StoppedWithEngine(t *testing.T) {
	engine, _ := newFreshnessEngine(t, &freshnessGitHub{blockSearch: true})
	done, started := engine.startOnDemandFreshnessSweep(t.Context())
	require.True(t, started)
	engine.Stop()
	select {
	case err := <-done:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(5 * time.Second):
		t.Fatal("stopping the engine should cancel an on-demand sweep")
	}
}
