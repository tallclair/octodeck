package logic

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
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

// backfillTestNow anchors the notification timestamps used by the backfill tests.
func backfillTestNow() time.Time {
	return time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC)
}

// fakeNotificationsAPI serves GET /notifications for the sync engine's HTTP client. Each request
// is answered by respond, which gets the parsed query (since, before, page) and the
// If-Modified-Since header and returns the response. Requests are recorded.
type fakeNotificationsAPI struct {
	mu       sync.Mutex
	requests []notificationRequest
	respond  func(r notificationRequest) *http.Response
}

type notificationRequest struct {
	since, before   string
	page            int
	ifModifiedSince string
	url             *url.URL
}

func (f *fakeNotificationsAPI) Do(req *http.Request) (*http.Response, error) {
	if req.URL.Path != "/notifications" {
		return nil, fmt.Errorf("unexpected HTTP request: %s", req.URL)
	}
	q := req.URL.Query()
	page := 1
	if p := q.Get("page"); p != "" {
		page, _ = strconv.Atoi(p)
	}
	r := notificationRequest{
		since:           q.Get("since"),
		before:          q.Get("before"),
		page:            page,
		ifModifiedSince: req.Header.Get("If-Modified-Since"),
		url:             req.URL,
	}
	f.mu.Lock()
	f.requests = append(f.requests, r)
	f.mu.Unlock()
	return f.respond(r), nil
}

func (f *fakeNotificationsAPI) recorded() []notificationRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]notificationRequest(nil), f.requests...)
}

// notificationsPage builds a 200 response with the given threads. If more is set, it links to
// the next page of the same query.
func notificationsPage(r notificationRequest, threads []github.NotificationThread, more bool) *http.Response {
	if threads == nil {
		threads = []github.NotificationThread{}
	}
	body, _ := json.Marshal(threads)
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(bytes.NewReader(body)),
	}
	resp.Header.Set("Last-Modified", "Fri, 14 Aug 2026 12:00:00 GMT")
	if more {
		next := *r.url
		q := next.Query()
		q.Set("page", strconv.Itoa(r.page+1))
		next.RawQuery = q.Encode()
		resp.Header.Set("Link", fmt.Sprintf(`<%s>; rel="next"`, next.String()))
	}
	return resp
}

func statusResponse(code int) *http.Response {
	return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(nil))}
}

// releaseThreads returns n threads about releases (a subject type the sync engine counts but
// does not hydrate), updated one second apart going back from newest.
func releaseThreads(n int, newest time.Time, idPrefix string) []github.NotificationThread {
	threads := make([]github.NotificationThread, n)
	for i := range threads {
		threads[i] = github.NotificationThread{
			ID:        fmt.Sprintf("%s-%d", idPrefix, i),
			Unread:    true,
			Reason:    "subscribed",
			UpdatedAt: newest.Add(-time.Duration(i) * time.Second).Format(time.RFC3339),
			Subject: github.NotificationSubject{
				Title: "Release", Type: "Release", URL: "https://api.github.com/repos/o/r/releases/1",
			},
			Repository: github.NotificationRepo{FullName: "o/r"},
		}
	}
	return threads
}

// cappedPages answers every page with 50 release threads and a next link, so a fetch only stops
// at the safety cap. Page p (1-based) holds the threads p*50-50 .. p*50-1 seconds before newest.
func cappedPages(r notificationRequest, newest time.Time) *http.Response {
	const perPage = 50
	start := newest.Add(-time.Duration((r.page-1)*perPage) * time.Second)
	return notificationsPage(r, releaseThreads(perPage, start, fmt.Sprintf("p%d", r.page)), true)
}

func newBackfillTestEngine(
	t *testing.T, api *fakeNotificationsAPI, gql *mockGraphQLClient,
) (*SyncEngine, *database.DB) {
	t.Helper()
	db := setupTestDB(t)
	t.Cleanup(func() { require.NoError(t, db.Close()) })
	if gql == nil {
		gql = &mockGraphQLClient{}
	}
	ghClient := &github.Client{GraphQLClient: gql, HTTPClient: api, CurrentUser: "testuser"}
	cfg := config.NewForTest(octodeckv1.Config_builder{KnownBots: []string{}}.Build())
	return NewSyncEngine(db, ghClient, cfg), db
}

func setNotificationCursor(t *testing.T, db *database.DB, ts time.Time) {
	t.Helper()
	require.NoError(t, db.SetMetadata(t.Context(), KeyLastNotificationSync, ts.Format(time.RFC3339)))
}

func requireBackfillWindow(t *testing.T, engine *SyncEngine) NotificationBackfillWindow {
	t.Helper()
	w, ok, err := engine.loadNotificationBackfillWindow(t.Context())
	require.NoError(t, err)
	require.True(t, ok, "expected a pending backfill window")
	return w
}

func requireNoBackfillWindow(t *testing.T, engine *SyncEngine) {
	t.Helper()
	w, ok, err := engine.loadNotificationBackfillWindow(t.Context())
	require.NoError(t, err)
	require.False(t, ok, "expected no pending backfill window, got %+v", w)
}

func latestNotificationPayload(t *testing.T, db *database.DB) NotificationSyncPayload {
	t.Helper()
	traces, err := db.GetSyncTraces(t.Context(), 1, traceTypeNotificationSync)
	require.NoError(t, err)
	require.Len(t, traces, 1)
	raw, err := database.DecompressPayload(traces[0].RawPayloadCompressed)
	require.NoError(t, err)
	var p NotificationSyncPayload
	require.NoError(t, json.Unmarshal(raw, &p))
	return p
}

func TestIncrementalSync_CappedFetchRecordsBackfillWindow(t *testing.T) {
	lastSync := backfillTestNow().Add(-6 * time.Hour)
	newest := backfillTestNow().Add(-time.Minute)

	api := &fakeNotificationsAPI{}
	api.respond = func(r notificationRequest) *http.Response {
		if r.before != "" {
			// Fail the drain so the recorded window stays observable.
			return statusResponse(http.StatusBadGateway)
		}
		return cappedPages(r, newest)
	}
	engine, db := newBackfillTestEngine(t, api, nil)
	ctx := t.Context()
	setNotificationCursor(t, db, lastSync)
	require.NoError(t, db.SetMetadata(ctx, KeyLastNotificationModified, "Thu, 13 Aug 2026 00:00:00 GMT"))

	require.NoError(t, engine.RunIncrementalSync(ctx), "a failed drain must not fail the sync")

	reqs := api.recorded()
	require.Len(t, reqs, 21, "20 capped pages plus one drain attempt")
	since := lastSync.Add(-notificationCursorOverlap)
	assert.Equal(t, since.Format(time.RFC3339), reqs[0].since)
	assert.Equal(t, "Thu, 13 Aug 2026 00:00:00 GMT", reqs[0].ifModifiedSince)

	// The 1000th (oldest) fetched thread was updated 999 seconds before the newest one.
	oldest := newest.Add(-999 * time.Second)
	w := requireBackfillWindow(t, engine)
	assert.True(t, since.Equal(w.Since), "window starts at the fetch's since: %v", w.Since)
	assert.True(t, oldest.Add(time.Second).Equal(w.Before),
		"window ends just past the oldest fetched thread: %v", w.Before)

	// The drain asked for exactly the window, without a conditional header.
	drain := reqs[20]
	assert.Equal(t, w.Since.Format(time.RFC3339), drain.since)
	assert.Equal(t, w.Before.Format(time.RFC3339), drain.before)
	assert.Empty(t, drain.ifModifiedSince)

	// The cursor and Last-Modified advance: everything newer than the window was fetched.
	cursor, err := db.GetMetadata(ctx, KeyLastNotificationSync)
	require.NoError(t, err)
	assert.NotEqual(t, lastSync.Format(time.RFC3339), cursor)
	lastMod, err := db.GetMetadata(ctx, KeyLastNotificationModified)
	require.NoError(t, err)
	assert.Equal(t, "Fri, 14 Aug 2026 12:00:00 GMT", lastMod)

	p := latestNotificationPayload(t, db)
	assert.True(t, p.Truncated)
	assert.Equal(t, 1000, p.NotificationsCount)
	assert.NotEmpty(t, p.BackfillError)
	require.NotNil(t, p.BackfillRemaining)
	assert.True(t, w.Before.Equal(p.BackfillRemaining.Before))
}

func TestIncrementalSync_DrainsBackfillWindowAfterNotModified(t *testing.T) {
	windowSince := backfillTestNow().Add(-48 * time.Hour)
	windowBefore := backfillTestNow().Add(-24 * time.Hour)
	gapUpdatedAt := windowBefore.Add(-time.Hour).Format(time.RFC3339)

	api := &fakeNotificationsAPI{}
	api.respond = func(r notificationRequest) *http.Response {
		if r.before == "" {
			return statusResponse(http.StatusNotModified)
		}
		thread := github.NotificationThread{
			ID: "gap-thread", Unread: true, Reason: "mention", UpdatedAt: gapUpdatedAt,
			Subject: github.NotificationSubject{
				Title: "Issue in the gap", Type: "Issue", URL: "https://api.github.com/repos/o/r/issues/7",
			},
			Repository: github.NotificationRepo{FullName: "o/r"},
		}
		return notificationsPage(r, []github.NotificationThread{thread}, false)
	}
	var hydrated []string
	gql := &mockGraphQLClient{queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
		if name != "ItemsFetch" {
			return nil
		}
		ids, _ := vars["ids"].([]string)
		hydrated = append(hydrated, ids...)
		b, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{
			"__typename": "Issue",
			"issue": map[string]any{
				"id": "ISSUE_7", "repository": map[string]any{"nameWithOwner": "o/r"}, "number": 7,
				"state": "OPEN", "title": "Updated in the gap", "url": "https://github.com/o/r/issues/7",
				"updatedAt": gapUpdatedAt,
				"author":    map[string]any{"login": "someone"},
				"comments":  map[string]any{"nodes": []any{}},
				"assignees": map[string]any{"nodes": []any{}},
			},
		}}})
		return json.Unmarshal(b, q)
	}}
	engine, db := newBackfillTestEngine(t, api, gql)
	ctx := t.Context()

	// The item is already stored, so the thread resolves to it without a node ID lookup.
	require.NoError(t, db.SaveItems(ctx, []*octodeckv1.Item{octodeckv1.Item_builder{
		Id: config.Ptr("ISSUE_7"), Repo: config.Ptr("o/r"), Number: config.Ptr(int32(7)),
		Type:  config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		State: config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		Title: config.Ptr("Stale title"), UpdatedAt: timestamppb.New(windowSince),
	}.Build()}))
	setNotificationCursor(t, db, backfillTestNow().Add(-time.Hour))
	require.NoError(t, db.SetMetadata(ctx, KeyLastNotificationModified, "Fri, 14 Aug 2026 11:00:00 GMT"))
	require.NoError(t, engine.storeNotificationBackfillWindow(ctx,
		&NotificationBackfillWindow{Since: windowSince, Before: windowBefore}))

	require.NoError(t, engine.RunIncrementalSync(ctx))

	reqs := api.recorded()
	require.Len(t, reqs, 2)
	assert.Empty(t, reqs[0].before, "the main fetch is unchanged by a pending window")
	assert.Equal(t, windowSince.Format(time.RFC3339), reqs[1].since)
	assert.Equal(t, windowBefore.Format(time.RFC3339), reqs[1].before)

	assert.Equal(t, []string{"ISSUE_7"}, hydrated)
	item, err := db.GetItem(ctx, "ISSUE_7")
	require.NoError(t, err)
	assert.Equal(t, "Updated in the gap", item.GetTitle())

	requireNoBackfillWindow(t, engine)

	p := latestNotificationPayload(t, db)
	assert.Equal(t, http.StatusNotModified, p.HTTPStatus)
	assert.Equal(t, 1, p.BackfillThreads)
	assert.Nil(t, p.BackfillRemaining)
	assert.Empty(t, p.BackfillError)
}

func TestIncrementalSync_CappedDrainShrinksBackfillWindow(t *testing.T) {
	windowSince := backfillTestNow().Add(-72 * time.Hour)
	windowBefore := backfillTestNow().Add(-24 * time.Hour)
	drainNewest := windowBefore.Add(-time.Minute)

	api := &fakeNotificationsAPI{}
	api.respond = func(r notificationRequest) *http.Response {
		if r.before == "" {
			return statusResponse(http.StatusNotModified)
		}
		return cappedPages(r, drainNewest)
	}
	engine, db := newBackfillTestEngine(t, api, nil)
	ctx := t.Context()
	setNotificationCursor(t, db, backfillTestNow().Add(-time.Hour))
	require.NoError(t, engine.storeNotificationBackfillWindow(ctx,
		&NotificationBackfillWindow{Since: windowSince, Before: windowBefore}))

	require.NoError(t, engine.RunIncrementalSync(ctx))

	w := requireBackfillWindow(t, engine)
	assert.True(t, windowSince.Equal(w.Since), "the lower bound is kept: %v", w.Since)
	wantBefore := drainNewest.Add(-999 * time.Second).Add(time.Second)
	assert.True(t, wantBefore.Equal(w.Before), "the window shrinks to below the drained threads: %v", w.Before)

	p := latestNotificationPayload(t, db)
	assert.Equal(t, 1000, p.BackfillThreads)
	require.NotNil(t, p.BackfillRemaining)
	assert.True(t, wantBefore.Equal(p.BackfillRemaining.Before))
}

func TestDrainNotificationBackfill_NoProgress(t *testing.T) {
	windowSince := backfillTestNow().Add(-72 * time.Hour)
	windowBefore := backfillTestNow().Add(-24 * time.Hour)

	tests := []struct {
		name string
		// updatedAt is the updated_at of every drained thread ("" for a missing timestamp).
		updatedAt  string
		wantBefore time.Time // zero means the window is dropped
	}{
		{
			name:       "threads share the second below the upper bound",
			updatedAt:  windowBefore.Add(-time.Second).Format(time.RFC3339),
			wantBefore: windowBefore.Add(-time.Second),
		},
		{
			name:      "threads lack timestamps",
			updatedAt: "",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			api := &fakeNotificationsAPI{}
			api.respond = func(r notificationRequest) *http.Response {
				threads := releaseThreads(50, windowBefore, "same")
				for i := range threads {
					threads[i].UpdatedAt = tc.updatedAt
				}
				return notificationsPage(r, threads, true)
			}
			engine, _ := newBackfillTestEngine(t, api, nil)
			ctx := t.Context()
			require.NoError(t, engine.storeNotificationBackfillWindow(ctx,
				&NotificationBackfillWindow{Since: windowSince, Before: windowBefore}))

			_, err := engine.drainNotificationBackfill(ctx, newReviewBackfillBudget(0))
			require.NoError(t, err)

			if tc.wantBefore.IsZero() {
				requireNoBackfillWindow(t, engine)
				return
			}
			w := requireBackfillWindow(t, engine)
			assert.True(t, tc.wantBefore.Equal(w.Before), "got %v", w.Before)
		})
	}
}

func TestRecordNotificationGap_MergesWithPendingWindow(t *testing.T) {
	engine, _ := newBackfillTestEngine(t, &fakeNotificationsAPI{}, nil)
	ctx := t.Context()
	t1 := backfillTestNow().Add(-10 * time.Hour)
	t2 := backfillTestNow().Add(-8 * time.Hour)
	t3 := backfillTestNow().Add(-3 * time.Hour)
	t4 := backfillTestNow().Add(-2 * time.Hour)

	require.NoError(t, engine.recordNotificationGap(ctx, t1, t2))
	require.NoError(t, engine.recordNotificationGap(ctx, t3, t4))

	w := requireBackfillWindow(t, engine)
	assert.True(t, t1.Equal(w.Since), "got %v", w.Since)
	assert.True(t, t4.Equal(w.Before), "got %v", w.Before)
}

func TestForceSync_ReachesBackToPreviousCursor(t *testing.T) {
	api := &fakeNotificationsAPI{}
	api.respond = func(r notificationRequest) *http.Response {
		return notificationsPage(r, nil, false)
	}
	engine, db := newBackfillTestEngine(t, api, nil)
	ctx := t.Context()
	lastSync := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Second)
	setNotificationCursor(t, db, lastSync)
	require.NoError(t, db.SetMetadata(ctx, KeyLastNotificationModified, "Fri, 14 Aug 2026 11:00:00 GMT"))

	require.NoError(t, engine.ForceSync(ctx))

	reqs := api.recorded()
	require.NotEmpty(t, reqs)
	assert.Equal(t, lastSync.Add(-notificationCursorOverlap).Format(time.RFC3339), reqs[0].since,
		"a forced sync must not skip threads between the previous cursor and its own window")
	assert.Empty(t, reqs[0].ifModifiedSince, "a forced sync is unconditional")
}
