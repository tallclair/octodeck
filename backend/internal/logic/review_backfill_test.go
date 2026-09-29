package logic

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	graphql "github.com/cli/shurcooL-graphql"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/github"
)

const (
	queryFetchReviews        = "FetchReviews"
	queryFetchReviewComments = "FetchReviewComments"
)

// reviewTestTime returns the submission time of test review idx (one minute apart).
func reviewTestTime(idx int) time.Time {
	return time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC).Add(time.Duration(idx) * time.Minute)
}

func reviewTestURL(idx int) string {
	return fmt.Sprintf("https://github.com/owner/repo/pull/1#pullrequestreview-%d", idx)
}

// testReviews builds review protos PRR_<start> .. PRR_<start+count-1> in chronological order.
func testReviews(start, count int, withID bool) []*octodeckv1.Review {
	out := make([]*octodeckv1.Review, 0, count)
	for i := range count {
		idx := start + i
		id := ""
		if withID {
			id = fmt.Sprintf("PRR_%d", idx)
		}
		out = append(out, octodeckv1.Review_builder{
			Id:          config.Ptr(id),
			Url:         config.Ptr(reviewTestURL(idx)),
			SubmittedAt: timestamppb.New(reviewTestTime(idx)),
			State:       config.Ptr("COMMENTED"),
			Body:        config.Ptr(fmt.Sprintf("Review %d", idx)),
			Author:      octodeckv1.User_builder{Login: config.Ptr("reviewer")}.Build(),
		}.Build())
	}
	return out
}

// gqlReviewNodes builds raw GraphQL review nodes PRR_<start> .. PRR_<end> in chronological order.
func gqlReviewNodes(start, end int) []map[string]any {
	nodes := make([]map[string]any, 0, end-start+1)
	for idx := start; idx <= end; idx++ {
		nodes = append(nodes, map[string]any{
			"id":          fmt.Sprintf("PRR_%d", idx),
			"url":         reviewTestURL(idx),
			"state":       "COMMENTED",
			"body":        fmt.Sprintf("Review %d", idx),
			"submittedAt": reviewTestTime(idx).Format(time.RFC3339),
			"author":      map[string]any{"login": "reviewer"},
		})
	}
	return nodes
}

// testReviewComments builds n review comment protos: PRRC_1 is a thread root and the rest reply to it.
func testReviewComments(n int) []*octodeckv1.ReviewComment {
	out := make([]*octodeckv1.ReviewComment, 0, n)
	for i := 1; i <= n; i++ {
		replyTo := ""
		if i > 1 {
			replyTo = "PRRC_1"
		}
		out = append(out, octodeckv1.ReviewComment_builder{
			Id:        config.Ptr(fmt.Sprintf("PRRC_%d", i)),
			Body:      config.Ptr(fmt.Sprintf("Comment %d", i)),
			ReplyToId: config.Ptr(replyTo),
		}.Build())
	}
	return out
}

// gqlReviewCommentNodes is the raw GraphQL equivalent of testReviewComments.
func gqlReviewCommentNodes(n int) []map[string]any {
	nodes := make([]map[string]any, 0, n)
	for i := 1; i <= n; i++ {
		node := map[string]any{
			"id":        fmt.Sprintf("PRRC_%d", i),
			"body":      fmt.Sprintf("Comment %d", i),
			"createdAt": reviewTestTime(i).Format(time.RFC3339),
			"author":    map[string]any{"login": "reviewer"},
		}
		if i > 1 {
			node["replyTo"] = map[string]any{"id": "PRRC_1"}
		}
		nodes = append(nodes, node)
	}
	return nodes
}

// fetchReviewsResponse builds a FetchReviews response, nesting the fields under "pullRequest"
// the way shurcooL/graphql decodes the "... on PullRequest" inline fragment.
func fetchReviewsResponse(nodes []map[string]any, hasPreviousPage bool, startCursor string) map[string]any {
	return map[string]any{
		"node": map[string]any{
			"__typename": "PullRequest",
			"pullRequest": map[string]any{
				"reviews": map[string]any{
					"pageInfo": map[string]any{"hasPreviousPage": hasPreviousPage, "startCursor": startCursor},
					"nodes":    nodes,
				},
			},
		},
	}
}

// fetchReviewCommentsResponse builds a single-page FetchReviewComments response, nesting the
// fields under "pullRequestReview" to match the "... on PullRequestReview" inline fragment.
func fetchReviewCommentsResponse(nodes []map[string]any) map[string]any {
	return map[string]any{
		"node": map[string]any{
			"__typename": "PullRequestReview",
			"pullRequestReview": map[string]any{
				"author": map[string]any{"login": "reviewer"},
				"comments": map[string]any{
					"pageInfo": map[string]any{"hasNextPage": false, "endCursor": ""},
					"nodes":    nodes,
				},
			},
		},
	}
}

func decodeGraphQLResponse(t *testing.T, resp map[string]any, q any) error {
	t.Helper()
	raw, err := json.Marshal(resp)
	require.NoError(t, err)
	return json.Unmarshal(raw, q)
}

func newTestPR(id string, reviews []*octodeckv1.Review) *octodeckv1.Item {
	return octodeckv1.Item_builder{
		Id:        config.Ptr(id),
		Repo:      config.Ptr("owner/repo"),
		Number:    config.Ptr(int32(1)),
		Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:     config.Ptr("Test PR"),
		State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		UpdatedAt: timestamppb.New(reviewTestTime(0)),
		Author:    octodeckv1.User_builder{Login: config.Ptr("author")}.Build(),
		Reviews:   reviews,
		Local:     octodeckv1.ItemLocalState_builder{}.Build(),
	}.Build()
}

// olderReviewsPaging is the hydration paging of a PR whose hydrated reviews page GitHub reports
// has older reviews before it (pageInfo.hasPreviousPage).
func olderReviewsPaging() github.HydrationPaging {
	return github.HydrationPaging{ReviewsHasPreviousPage: true}
}

// pagingWithOlderReviews returns hydration paging that marks every item as having older reviews.
func pagingWithOlderReviews(items ...*octodeckv1.Item) github.HydrationPagingByID {
	paging := make(github.HydrationPagingByID, len(items))
	for _, item := range items {
		paging[item.GetId()] = olderReviewsPaging()
	}
	return paging
}

func reviewIDs(reviews []*octodeckv1.Review) []string {
	ids := make([]string, 0, len(reviews))
	for _, r := range reviews {
		ids = append(ids, r.GetId())
	}
	return ids
}

func expectedReviewIDs(start, end int) []string {
	ids := make([]string, 0, end-start+1)
	for idx := start; idx <= end; idx++ {
		ids = append(ids, fmt.Sprintf("PRR_%d", idx))
	}
	return ids
}

func TestHandleReviewGapResolution(t *testing.T) {
	t.Run("backfills missing reviews when more than a page of new reviews arrived", func(t *testing.T) {
		var cursors []any
		mockGQL := &mockGraphQLClient{
			queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
				require.Equal(t, queryFetchReviews, name)
				cursors = append(cursors, vars["cursor"])
				// Newest page: PRR_2 (stored) through PRR_15.
				return decodeGraphQLResponse(t, fetchReviewsResponse(gqlReviewNodes(2, 15), true, "c_start"), q)
			},
		}

		engine := &SyncEngine{gh: &github.Client{GraphQLClient: mockGQL}}
		stored := testReviews(1, 2, true) // PRR_1, PRR_2
		// Hydration returned the last 10 reviews: PRR_6 .. PRR_15.
		item := newTestPR("PR_gap_1", testReviews(6, 10, true))

		engine.handleReviewGapResolution(t.Context(), stored, item, olderReviewsPaging(), newReviewBackfillBudget(1))
		require.Len(t, cursors, 1, "paging should stop at the stored PRR_2")
		assert.Nil(t, cursors[0], "FetchReviews should start at the newest review")
		assert.Equal(t, expectedReviewIDs(1, 15), reviewIDs(item.GetReviews()))
		assert.False(t, item.GetLocal().HasReviewBackfillBefore())
	})

	t.Run("backfills when older reviews exist even if the page is short", func(t *testing.T) {
		// A pending (draft) review dropped from the hydrated page leaves fewer than a page of
		// submitted reviews, but hasPreviousPage still reports older ones.
		var calls int
		mockGQL := &mockGraphQLClient{
			queryFunc: func(_ context.Context, name string, q any, _ map[string]any) error {
				require.Equal(t, queryFetchReviews, name)
				calls++
				return decodeGraphQLResponse(t, fetchReviewsResponse(gqlReviewNodes(2, 12), true, "c_start"), q)
			},
		}

		engine := &SyncEngine{gh: &github.Client{GraphQLClient: mockGQL}}
		item := newTestPR("PR_short_page", testReviews(4, 9, true))

		engine.handleReviewGapResolution(t.Context(), testReviews(1, 2, true), item, olderReviewsPaging(),
			newReviewBackfillBudget(1))
		assert.Equal(t, 1, calls)
		assert.Equal(t, expectedReviewIDs(1, 12), reviewIDs(item.GetReviews()))
	})

	t.Run("backfills from scratch for legacy stored reviews lacking id", func(t *testing.T) {
		mockGQL := &mockGraphQLClient{
			queryFunc: func(_ context.Context, name string, q any, _ map[string]any) error {
				require.Equal(t, queryFetchReviews, name)
				return decodeGraphQLResponse(t, fetchReviewsResponse(gqlReviewNodes(1, 12), false, ""), q)
			},
		}

		engine := &SyncEngine{gh: &github.Client{GraphQLClient: mockGQL}}
		item := newTestPR("PR_legacy", testReviews(3, 10, true))

		engine.handleReviewGapResolution(t.Context(), testReviews(1, 3, false), item, olderReviewsPaging(),
			newReviewBackfillBudget(1))
		assert.Equal(t, expectedReviewIDs(1, 12), reviewIDs(item.GetReviews()),
			"legacy reviews should be matched by URL and upgraded with IDs without duplication")
	})

	t.Run("does not backfill when the page reaches the first review or is already connected", func(t *testing.T) {
		mockGQL := &mockGraphQLClient{
			queryFunc: func(_ context.Context, name string, _ any, _ map[string]any) error {
				return fmt.Errorf("unexpected query %s", name)
			},
		}
		engine := &SyncEngine{gh: &github.Client{GraphQLClient: mockGQL}}

		// A full page without hasPreviousPage covers the PR's entire review history.
		complete := newTestPR("PR_complete", testReviews(1, 10, true))
		engine.handleReviewGapResolution(t.Context(), nil, complete, github.HydrationPaging{},
			newReviewBackfillBudget(1))
		assert.Equal(t, expectedReviewIDs(1, 10), reviewIDs(complete.GetReviews()))

		connected := newTestPR("PR_connected", testReviews(5, 10, true))
		engine.handleReviewGapResolution(t.Context(), testReviews(1, 5, true), connected, olderReviewsPaging(),
			newReviewBackfillBudget(1))
		assert.Equal(t, expectedReviewIDs(1, 14), reviewIDs(connected.GetReviews()))
	})
}

func TestHandleReviewGapResolution_BackfillCap(t *testing.T) {
	page := 0
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, _ map[string]any) error {
			require.Equal(t, queryFetchReviews, name)
			page++
			endIdx := 600 - (page-1)*50
			startIdx := endIdx - 49
			resp := fetchReviewsResponse(gqlReviewNodes(startIdx, endIdx), true, fmt.Sprintf("cursor_%d", startIdx))
			return decodeGraphQLResponse(t, resp, q)
		},
	}

	engine := &SyncEngine{gh: &github.Client{GraphQLClient: mockGQL}}
	item := newTestPR("PR_600_cap", testReviews(591, 10, true))

	engine.handleReviewGapResolution(t.Context(), nil, item, olderReviewsPaging(), newReviewBackfillBudget(1))
	require.Len(t, item.GetReviews(), github.MaxReviewBackfill)
	assert.Equal(t, "PRR_101", item.GetReviews()[0].GetId())
	assert.Equal(t, "PRR_600", item.GetReviews()[github.MaxReviewBackfill-1].GetId())
}

func TestHandleReviewGapResolution_NewItem(t *testing.T) {
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, _ map[string]any) error {
			switch name {
			case queryFetchReviews:
				nodes := gqlReviewNodes(1, 12)
				nodes[0]["comments"] = map[string]any{
					"totalCount": 2,
					"pageInfo":   map[string]any{"hasNextPage": true, "endCursor": "c_page1"},
					"nodes":      gqlReviewCommentNodes(1),
				}
				return decodeGraphQLResponse(t, fetchReviewsResponse(nodes, false, ""), q)
			case queryFetchReviewComments:
				return decodeGraphQLResponse(t, fetchReviewCommentsResponse(gqlReviewCommentNodes(2)[1:]), q)
			default:
				return fmt.Errorf("unexpected query %s", name)
			}
		},
	}

	engine := &SyncEngine{gh: &github.Client{GraphQLClient: mockGQL}}
	item := newTestPR("PR_new_item", testReviews(3, 10, true))

	engine.handleReviewGapResolution(t.Context(), nil, item, olderReviewsPaging(), newReviewBackfillBudget(1))
	require.Len(t, item.GetReviews(), 12)
	first := item.GetReviews()[0]
	assert.Equal(t, "PRR_1", first.GetId())
	require.Len(t, first.GetComments(), 2)
	assert.Equal(t, "PRRC_1", first.GetComments()[0].GetId())
	assert.Equal(t, "PRRC_2", first.GetComments()[1].GetId())
	assert.Equal(t, "PRRC_1", first.GetComments()[1].GetReplyToId())
	assert.Equal(t, int32(1), first.GetReplyCount())
}

func TestHandleReviewGapResolution_CommentCompletion(t *testing.T) {
	const totalComments = 25

	reviewWithComments := func(loaded, total int) *octodeckv1.Review {
		r := testReviews(1, 1, true)[0]
		r.SetComments(testReviewComments(loaded))
		r.SetCommentCount(int32(total))
		return r
	}

	newEngine := func(t *testing.T, fetchCalls *int) *SyncEngine {
		t.Helper()
		mockGQL := &mockGraphQLClient{
			queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
				require.Equal(t, queryFetchReviewComments, name)
				assert.Equal(t, "PRR_1", fmt.Sprint(vars["reviewId"]))
				*fetchCalls++
				return decodeGraphQLResponse(t, fetchReviewCommentsResponse(gqlReviewCommentNodes(totalComments)), q)
			},
		}
		return &SyncEngine{gh: &github.Client{GraphQLClient: mockGQL}}
	}

	tests := []struct {
		name          string
		stored        []*octodeckv1.Review
		hydratedTotal int
		wantFetch     bool
	}{
		{
			name:          "stored copy already complete",
			stored:        []*octodeckv1.Review{reviewWithComments(totalComments, totalComments)},
			hydratedTotal: totalComments,
			wantFetch:     false,
		},
		{
			name:          "stored copy incomplete",
			stored:        []*octodeckv1.Review{reviewWithComments(10, totalComments)},
			hydratedTotal: totalComments,
			wantFetch:     true,
		},
		{
			name:          "newly seen review",
			stored:        nil,
			hydratedTotal: totalComments,
			wantFetch:     true,
		},
		{
			name:          "new comments since stored copy was completed",
			stored:        []*octodeckv1.Review{reviewWithComments(totalComments-1, totalComments-1)},
			hydratedTotal: totalComments,
			wantFetch:     true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var fetchCalls int
			engine := newEngine(t, &fetchCalls)
			item := newTestPR("PR_comments", []*octodeckv1.Review{reviewWithComments(10, tc.hydratedTotal)})

			engine.handleReviewGapResolution(t.Context(), tc.stored, item, github.HydrationPaging{},
				newReviewBackfillBudget(1))

			if tc.wantFetch {
				assert.Equal(t, 1, fetchCalls)
			} else {
				assert.Zero(t, fetchCalls, "comments should not be re-paged when the stored review is complete")
			}
			require.Len(t, item.GetReviews(), 1)
			merged := item.GetReviews()[0]
			assert.Len(t, merged.GetComments(), totalComments)
			assert.Equal(t, int32(1), merged.GetNewThreadsCount())
			assert.Equal(t, int32(totalComments-1), merged.GetReplyCount())
		})
	}
}

func TestProcessItems_ReviewBackfillRetriesAfterFailure(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	const prID = "PR_retry"
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{newTestPR(prID, testReviews(1, 2, true))}))

	failBackfill := true
	var fetchCalls int
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, _ map[string]any) error {
			require.Equal(t, queryFetchReviews, name)
			fetchCalls++
			if failBackfill {
				return errors.New("transient GitHub failure")
			}
			// Newest page covers PRR_2 .. PRR_16. PRR_6 .. PRR_15 were stored by the first
			// (failed) sync but must not stop the backfill, since they sit above the gap.
			return decodeGraphQLResponse(t, fetchReviewsResponse(gqlReviewNodes(2, 16), true, "c_start"), q)
		},
	}
	engine := NewSyncEngine(db, &github.Client{GraphQLClient: mockGQL},
		config.NewForTest(octodeckv1.Config_builder{}.Build()))

	// Sync 1: hydration returns PRR_6 .. PRR_15 (gap: PRR_3 .. PRR_5) and the backfill fails.
	hydrated := newTestPR(prID, testReviews(6, 10, true))
	require.NoError(t, engine.processItems(t.Context(), []*octodeckv1.Item{hydrated}, pagingWithOlderReviews(hydrated)))
	assert.Equal(t, 1, fetchCalls)

	saved, err := db.GetItem(t.Context(), prID)
	require.NoError(t, err)
	assert.Equal(t, append(expectedReviewIDs(1, 2), expectedReviewIDs(6, 15)...), reviewIDs(saved.GetReviews()))
	require.True(t, saved.GetLocal().HasReviewBackfillBefore(), "failed backfill should leave a pending marker")
	assert.Equal(t, reviewTestTime(6), saved.GetLocal().GetReviewBackfillBefore().AsTime())

	// Sync 2: one new review (PRR_16). The oldest hydrated review (PRR_7) is already stored, so
	// only the pending marker triggers the retry.
	failBackfill = false
	hydrated = newTestPR(prID, testReviews(7, 10, true))
	require.NoError(t, engine.processItems(t.Context(), []*octodeckv1.Item{hydrated}, pagingWithOlderReviews(hydrated)))
	assert.Equal(t, 2, fetchCalls)

	saved, err = db.GetItem(t.Context(), prID)
	require.NoError(t, err)
	assert.Equal(t, expectedReviewIDs(1, 16), reviewIDs(saved.GetReviews()))
	assert.False(t, saved.GetLocal().HasReviewBackfillBefore(), "successful backfill should clear the pending marker")
}

func TestProcessItems_ReviewBackfillBudget(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	const extraItems = 2
	itemCount := maxReviewBackfillsPerSync + extraItems

	backfilled := make(map[string]int)
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			require.Equal(t, queryFetchReviews, name)
			backfilled[fmt.Sprint(vars["prId"])]++
			return decodeGraphQLResponse(t, fetchReviewsResponse(gqlReviewNodes(1, 12), false, ""), q)
		},
	}
	engine := NewSyncEngine(db, &github.Client{GraphQLClient: mockGQL},
		config.NewForTest(octodeckv1.Config_builder{}.Build()))

	hydrate := func() []*octodeckv1.Item {
		items := make([]*octodeckv1.Item, 0, itemCount)
		for i := range itemCount {
			items = append(items, newTestPR(fmt.Sprintf("PR_budget_%d", i), testReviews(3, 10, true)))
		}
		return items
	}

	// Cycle 1: only maxReviewBackfillsPerSync items are backfilled; the rest are deferred.
	items := hydrate()
	require.NoError(t, engine.processItems(t.Context(), items, pagingWithOlderReviews(items...)))
	assert.Len(t, backfilled, maxReviewBackfillsPerSync)

	var deferred []string
	for i := range itemCount {
		id := fmt.Sprintf("PR_budget_%d", i)
		saved, err := db.GetItem(t.Context(), id)
		require.NoError(t, err)
		if backfilled[id] > 0 {
			assert.Len(t, saved.GetReviews(), 12)
			assert.False(t, saved.GetLocal().HasReviewBackfillBefore())
		} else {
			deferred = append(deferred, id)
			assert.Len(t, saved.GetReviews(), 10)
			require.True(t, saved.GetLocal().HasReviewBackfillBefore(), "deferred item should be marked pending")
			assert.Equal(t, reviewTestTime(3), saved.GetLocal().GetReviewBackfillBefore().AsTime())
		}
	}
	require.Len(t, deferred, extraItems)

	// Cycle 2: the deferred items are backfilled; completed items are not backfilled again.
	items = hydrate()
	require.NoError(t, engine.processItems(t.Context(), items, pagingWithOlderReviews(items...)))
	assert.Len(t, backfilled, itemCount)
	for id, calls := range backfilled {
		assert.Equal(t, 1, calls, "item %s should be backfilled exactly once", id)
	}
	for _, id := range deferred {
		saved, err := db.GetItem(t.Context(), id)
		require.NoError(t, err)
		assert.Len(t, saved.GetReviews(), 12)
		assert.False(t, saved.GetLocal().HasReviewBackfillBefore())
	}
}

// itemsFetchPRNode builds a hydrated PullRequest node as returned by the ItemsFetch query.
func itemsFetchPRNode(id string, reviewNodes []map[string]any, hasPreviousPage bool) map[string]any {
	return map[string]any{
		"__typename": "PullRequest",
		"pullRequest": map[string]any{
			"id":         id,
			"repository": map[string]any{"nameWithOwner": "owner/repo"},
			"number":     1,
			"state":      "OPEN",
			"updatedAt":  reviewTestTime(0).Format(time.RFC3339),
			"title":      "Test PR",
			"url":        "https://github.com/owner/repo/pull/1",
			"author":     map[string]any{"login": "author"},
			"reviews": map[string]any{
				"pageInfo": map[string]any{"hasPreviousPage": hasPreviousPage},
				"nodes":    reviewNodes,
			},
		},
	}
}

// cursorVar returns the "cursor" variable of a paged query, or "" when paging from the start.
func cursorVar(t *testing.T, vars map[string]any) string {
	t.Helper()
	c, ok := vars["cursor"].(*graphql.String)
	require.True(t, ok, "cursor variable should be a *graphql.String")
	if c == nil {
		return ""
	}
	return string(*c)
}

// fakeReviewGitHub serves the GraphQL queries used by sync cycles in review backfill tests.
// ItemsFetch returns each PR in hydrated with reviews PRR_<first> .. PRR_<last> and
// hasPreviousPage set; other IDs are returned as null. FetchReviews pages PRR_2 .. PRR_<last>
// (stopping at a stored PRR_2) unless the PR is listed in failReviews. InventorySearch returns
// no items.
type fakeReviewGitHub struct {
	t             *testing.T
	hydrated      map[string][2]int
	failReviews   map[string]bool
	hydratedIDs   [][]string
	reviewFetches map[string]int
}

func newFakeReviewGitHub(t *testing.T) *fakeReviewGitHub {
	t.Helper()
	return &fakeReviewGitHub{
		t:             t,
		hydrated:      make(map[string][2]int),
		failReviews:   make(map[string]bool),
		reviewFetches: make(map[string]int),
	}
}

func (f *fakeReviewGitHub) query(_ context.Context, name string, q any, vars map[string]any) error {
	switch name {
	case "ItemsFetch":
		ids, ok := vars["ids"].([]string)
		require.True(f.t, ok)
		f.hydratedIDs = append(f.hydratedIDs, ids)
		nodes := make([]any, 0, len(ids))
		for _, id := range ids {
			if r, ok := f.hydrated[id]; ok {
				nodes = append(nodes, itemsFetchPRNode(id, gqlReviewNodes(r[0], r[1]), true))
			} else {
				nodes = append(nodes, nil)
			}
		}
		return decodeGraphQLResponse(f.t, map[string]any{"nodes": nodes}, q)
	case queryFetchReviews:
		id := fmt.Sprint(vars["prId"])
		f.reviewFetches[id]++
		if f.failReviews[id] {
			return errors.New("transient GitHub failure")
		}
		resp := fetchReviewsResponse(gqlReviewNodes(2, f.hydrated[id][1]), true, "c_start")
		return decodeGraphQLResponse(f.t, resp, q)
	case inventoryQueryName:
		return decodeGraphQLResponse(f.t, map[string]any{
			"search": map[string]any{"nodes": []any{}, "pageInfo": map[string]any{"hasNextPage": false}},
		}, q)
	default:
		return fmt.Errorf("unexpected query %s", name)
	}
}

// sweptIDs returns every ID hydrated via ItemsFetch.
func (f *fakeReviewGitHub) sweptIDs() []string {
	var ids []string
	for _, batch := range f.hydratedIDs {
		ids = append(ids, batch...)
	}
	return ids
}

// newNotModifiedEngine returns an engine backed by fake whose notification fetches always
// return HTTP 304, so a sync cycle hydrates nothing from notifications.
func newNotModifiedEngine(t *testing.T, db *database.DB, fake *fakeReviewGitHub, cfg *octodeckv1.Config) *SyncEngine {
	t.Helper()
	mockHTTP := &mockHTTPClient{
		doFunc: func(_ *http.Request) (*http.Response, error) {
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
	ghClient := &github.Client{
		RestClient:    mockREST,
		GraphQLClient: &mockGraphQLClient{queryFunc: fake.query},
		HTTPClient:    mockHTTP,
	}
	return NewSyncEngine(db, ghClient, config.NewForTest(cfg))
}

// savePendingPR stores a PR with reviews PRR_1, PRR_2 whose review backfill is pending below
// PRR_6, as left by a deferred backfill.
func savePendingPR(t *testing.T, db *database.DB, id, repo string) {
	t.Helper()
	item := newTestPR(id, testReviews(1, 2, true))
	item.SetRepo(repo)
	item.GetLocal().SetReviewBackfillBefore(timestamppb.New(reviewTestTime(6)))
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{item}))
}

func pendingMarker(t *testing.T, db *database.DB, id string) (bool, string) {
	t.Helper()
	saved, err := db.GetItem(t.Context(), id)
	require.NoError(t, err)
	return saved.GetLocal().HasReviewBackfillBefore(), saved.GetLocal().GetSyncError()
}

func TestSyncCycle_ResumesPendingReviewBackfill(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	const (
		quietID    = "PR_quiet"
		goneID     = "PR_gone"
		excludedID = "PR_excluded"
		laterID    = "PR_later"
	)
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{newTestPR(quietID, testReviews(1, 2, true))}))
	// Pending items that GitHub no longer returns, and that live in an excluded repo.
	savePendingPR(t, db, goneID, "owner/repo")
	savePendingPR(t, db, excludedID, "excluded/repo")

	fake := newFakeReviewGitHub(t)
	fake.hydrated[quietID] = [2]int{7, 16}
	fake.hydrated[excludedID] = [2]int{7, 16}
	fake.hydrated[laterID] = [2]int{7, 16}
	engine := newNotModifiedEngine(t, db, fake,
		octodeckv1.Config_builder{ExcludedRepos: []string{"excluded/repo"}}.Build())

	// Cycle 1: the item is hydrated with a gap (PRR_3 .. PRR_5) while the budget is exhausted,
	// so the backfill is deferred.
	hydrated := newTestPR(quietID, testReviews(6, 10, true))
	require.NoError(t, engine.processItemsWithBudget(t.Context(), []*octodeckv1.Item{hydrated},
		pagingWithOlderReviews(hydrated), true, newReviewBackfillBudget(0)))
	assert.Empty(t, fake.reviewFetches)
	pending, _ := pendingMarker(t, db, quietID)
	require.True(t, pending, "deferred item should be marked pending")

	// Cycle 2: no notifications re-hydrate the quiet PR, yet the end-of-cycle sweep backfills it.
	require.NoError(t, engine.ForceSync(t.Context()))
	require.Len(t, fake.hydratedIDs, 1)
	assert.ElementsMatch(t, []string{quietID, goneID}, fake.hydratedIDs[0],
		"items in excluded repos should not be hydrated")
	assert.Equal(t, map[string]int{quietID: 1}, fake.reviewFetches)

	saved, err := db.GetItem(t.Context(), quietID)
	require.NoError(t, err)
	assert.Equal(t, expectedReviewIDs(1, 16), reviewIDs(saved.GetReviews()))
	assert.False(t, saved.GetLocal().HasReviewBackfillBefore())

	// A null from GitHub records a sync error but keeps the gap boundary.
	pending, syncErr := pendingMarker(t, db, goneID)
	assert.True(t, pending)
	assert.Equal(t, errItemNotFoundOnGitHub, syncErr)
	// A pending item in an excluded repo is cleared without being fetched.
	pending, _ = pendingMarker(t, db, excludedID)
	assert.False(t, pending)

	// Sweep work is reported in the cycle's trace even though notifications returned 304.
	traces, err := db.GetSyncTraces(t.Context(), 10, traceTypeNotificationSync)
	require.NoError(t, err)
	require.Len(t, traces, 1)
	assert.Equal(t, int64(1), traces[0].ItemsFetched)

	// Cycle 3: a newly pending item is not swept within the sweep interval.
	savePendingPR(t, db, laterID, "owner/repo")
	require.NoError(t, engine.ForceSync(t.Context()))
	assert.Len(t, fake.hydratedIDs, 1, "the sweep should be throttled")

	// Cycle 4: once the interval has elapsed, only the new item is swept; the item with a sync
	// error waits for a successful re-hydration.
	engine.lastPendingReviewSweepAt = time.Now().Add(-pendingReviewBackfillSweepInterval)
	require.NoError(t, engine.ForceSync(t.Context()))
	require.Len(t, fake.hydratedIDs, 2)
	assert.Equal(t, []string{laterID}, fake.hydratedIDs[1])
	pending, _ = pendingMarker(t, db, laterID)
	assert.False(t, pending)
}

func TestResumePendingReviewBackfills_SharesCycleBudget(t *testing.T) {
	const (
		backfilledID = "PR_main_ok"
		failedID     = "PR_main_failed"
	)
	// runMainBatch processes backfilledID (backfill succeeds) and failedID (backfill fails, so
	// it stays pending) against budget, as the notification batch of a sync cycle would.
	runMainBatch := func(t *testing.T, db *database.DB, engine *SyncEngine, fake *fakeReviewGitHub,
		budget *reviewBackfillBudget, ids ...string) {
		t.Helper()
		items := make([]*octodeckv1.Item, 0, len(ids))
		for _, id := range ids {
			require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{newTestPR(id, testReviews(1, 2, true))}))
			fake.hydrated[id] = [2]int{6, 15}
			items = append(items, newTestPR(id, testReviews(6, 10, true)))
		}
		require.NoError(t, engine.processItemsWithBudget(t.Context(), items, pagingWithOlderReviews(items...),
			true, budget))
		fake.hydratedIDs = nil
	}

	t.Run("items processed earlier in the cycle are not swept", func(t *testing.T) {
		db := setupTestDB(t)
		defer func() { require.NoError(t, db.Close()) }()
		fake := newFakeReviewGitHub(t)
		fake.failReviews[failedID] = true
		engine := newNotModifiedEngine(t, db, fake, octodeckv1.Config_builder{}.Build())
		savePendingPR(t, db, "PR_pending", "owner/repo")
		fake.hydrated["PR_pending"] = [2]int{7, 16}

		budget := newReviewBackfillBudget(4)
		runMainBatch(t, db, engine, fake, budget, backfilledID, failedID)
		require.Equal(t, 2, budget.remaining)
		pending, _ := pendingMarker(t, db, failedID)
		require.True(t, pending)

		// The budget would allow sweeping the failed item too, but it was visited this cycle.
		assert.Equal(t, 1, engine.resumePendingReviewBackfills(t.Context(), budget))
		assert.Equal(t, []string{"PR_pending"}, fake.sweptIDs())
		assert.Equal(t, 1, fake.reviewFetches[failedID])
	})

	t.Run("the sweep only spends what the main batch left", func(t *testing.T) {
		db := setupTestDB(t)
		defer func() { require.NoError(t, db.Close()) }()
		fake := newFakeReviewGitHub(t)
		engine := newNotModifiedEngine(t, db, fake, octodeckv1.Config_builder{}.Build())
		pendingIDs := []string{"PR_pending_1", "PR_pending_2", "PR_pending_3"}
		for _, id := range pendingIDs {
			savePendingPR(t, db, id, "owner/repo")
			fake.hydrated[id] = [2]int{7, 16}
		}

		budget := newReviewBackfillBudget(3)
		runMainBatch(t, db, engine, fake, budget, backfilledID)
		require.Equal(t, 2, budget.remaining)

		assert.Equal(t, 2, engine.resumePendingReviewBackfills(t.Context(), budget))
		swept := fake.sweptIDs()
		assert.Len(t, swept, 2)
		assert.Subset(t, pendingIDs, swept)
		assert.Zero(t, budget.remaining)
		var stillPending int
		for _, id := range pendingIDs {
			if pending, _ := pendingMarker(t, db, id); pending {
				stillPending++
			}
		}
		assert.Equal(t, 1, stillPending)
	})
}

func TestRunInventorySync_ResumesPendingReviewBackfill(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	const pendingID = "PR_pending"
	savePendingPR(t, db, pendingID, "owner/repo")
	fake := newFakeReviewGitHub(t)
	fake.hydrated[pendingID] = [2]int{7, 16}
	engine := newNotModifiedEngine(t, db, fake, octodeckv1.Config_builder{}.Build())

	require.NoError(t, engine.RunInventorySync(t.Context()))

	assert.Equal(t, []string{pendingID}, fake.sweptIDs())
	saved, err := db.GetItem(t.Context(), pendingID)
	require.NoError(t, err)
	assert.Equal(t, expectedReviewIDs(1, 16), reviewIDs(saved.GetReviews()))
	assert.False(t, saved.GetLocal().HasReviewBackfillBefore())

	traces, err := db.GetSyncTraces(t.Context(), 10, "inventory")
	require.NoError(t, err)
	require.Len(t, traces, 1)
	assert.Equal(t, int64(1), traces[0].ItemsFetched)
}

func TestHandleReviewGapResolution_CommentCompletionResumesFromCursor(t *testing.T) {
	const (
		hydratedComments = 10
		totalComments    = 25
	)
	var cursors []string
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			require.Equal(t, queryFetchReviewComments, name)
			cursors = append(cursors, cursorVar(t, vars))
			remaining := gqlReviewCommentNodes(totalComments)[hydratedComments:]
			return decodeGraphQLResponse(t, fetchReviewCommentsResponse(remaining), q)
		},
	}
	engine := &SyncEngine{gh: &github.Client{GraphQLClient: mockGQL}}

	review := testReviews(1, 1, true)[0]
	review.SetComments(testReviewComments(hydratedComments))
	review.SetCommentCount(totalComments)
	item := newTestPR("PR_cursor", []*octodeckv1.Review{review})
	paging := github.HydrationPaging{ReviewCommentsEndCursors: map[string]string{"PRR_1": "c_hydrated"}}

	engine.handleReviewGapResolution(t.Context(), nil, item, paging, newReviewBackfillBudget(1))

	assert.Equal(t, []string{"c_hydrated"}, cursors, "paging should resume after the hydrated page")
	require.Len(t, item.GetReviews(), 1)
	merged := item.GetReviews()[0]
	require.Len(t, merged.GetComments(), totalComments)
	for i, c := range merged.GetComments() {
		assert.Equal(t, fmt.Sprintf("PRRC_%d", i+1), c.GetId())
	}
	assert.Equal(t, int32(totalComments), merged.GetCommentsPagedTotal())
	assert.Equal(t, int32(totalComments-1), merged.GetReplyCount())
}

func TestProcessItems_CommentCompletionStopsWhenTotalCountExceedsPaged(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	const (
		hydratedComments = 10
		reportedTotal    = 25
		// GitHub's totalCount can include comments that paging never returns.
		pagedComments = reportedTotal - 1
	)
	var fetchCalls int
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, _ map[string]any) error {
			require.Equal(t, queryFetchReviewComments, name)
			fetchCalls++
			remaining := gqlReviewCommentNodes(pagedComments)[hydratedComments:]
			return decodeGraphQLResponse(t, fetchReviewCommentsResponse(remaining), q)
		},
	}
	engine := NewSyncEngine(db, &github.Client{GraphQLClient: mockGQL},
		config.NewForTest(octodeckv1.Config_builder{}.Build()))

	const prID = "PR_mismatch"
	paging := github.HydrationPagingByID{
		prID: {ReviewCommentsEndCursors: map[string]string{"PRR_1": "c_hydrated"}},
	}
	hydrate := func(total int32) []*octodeckv1.Item {
		review := testReviews(1, 1, true)[0]
		review.SetComments(testReviewComments(hydratedComments))
		review.SetCommentCount(total)
		return []*octodeckv1.Item{newTestPR(prID, []*octodeckv1.Review{review})}
	}
	assertStored := func(wantComments int, wantPagedTotal int32) {
		t.Helper()
		saved, err := db.GetItem(t.Context(), prID)
		require.NoError(t, err)
		require.Len(t, saved.GetReviews(), 1)
		assert.Len(t, saved.GetReviews()[0].GetComments(), wantComments)
		assert.Equal(t, wantPagedTotal, saved.GetReviews()[0].GetCommentsPagedTotal())
	}

	// Sync 1: paging is exhausted one comment short of totalCount.
	require.NoError(t, engine.processItems(t.Context(), hydrate(reportedTotal), paging))
	assert.Equal(t, 1, fetchCalls)
	assertStored(pagedComments, reportedTotal)

	// Sync 2: the count is unchanged, so the exhausted review is not re-paged.
	require.NoError(t, engine.processItems(t.Context(), hydrate(reportedTotal), paging))
	assert.Equal(t, 1, fetchCalls, "an exhausted review should not be re-paged while its count is unchanged")
	assertStored(pagedComments, reportedTotal)

	// Sync 3: a new comment changes the count, so the review is paged again.
	require.NoError(t, engine.processItems(t.Context(), hydrate(reportedTotal+1), paging))
	assert.Equal(t, 2, fetchCalls)
	assertStored(pagedComments, reportedTotal+1)
}

func TestBackfillItems_PreservesBackfilledReviewHistory(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	// PRR_1 .. PRR_20 are stored, the older ones having been backfilled earlier.
	const prID = "PR_history"
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{newTestPR(prID, testReviews(1, 20, true))}))
	fake := newFakeReviewGitHub(t)
	fake.hydrated[prID] = [2]int{11, 20}
	engine := newNotModifiedEngine(t, db, fake, octodeckv1.Config_builder{}.Build())

	count, err := engine.BackfillItems(t.Context())
	require.NoError(t, err)
	assert.Equal(t, 1, count)

	saved, err := db.GetItem(t.Context(), prID)
	require.NoError(t, err)
	assert.Equal(t, expectedReviewIDs(1, 20), reviewIDs(saved.GetReviews()),
		"refreshing an item must merge the hydrated page into stored review history")
	assert.Empty(t, fake.reviewFetches, "the hydrated page connects to stored history")
}
