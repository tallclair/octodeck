package logic

import (
	"context"
	"log/slog"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/github"
)

// maxReviewBackfillsPerSync bounds how many PRs may run a review backfill (FetchReviews) within
// a single sync cycle. Each backfill can issue many paged queries, so this keeps a cold start
// (or the first sync after an upgrade) from bursting requests for every PR at once. Items over
// budget are marked pending and backfilled on a later sync cycle.
const maxReviewBackfillsPerSync = 10

// reviewBackfillBudget tracks the review backfills attempted within a single sync cycle.
type reviewBackfillBudget struct {
	remaining int
	performed int
	failed    int
	deferred  int
	// visited holds the IDs of items whose reviews were evaluated this cycle, so the
	// end-of-cycle sweep of pending backfills does not revisit them.
	visited map[string]struct{}
}

func newReviewBackfillBudget(limit int) *reviewBackfillBudget {
	return &reviewBackfillBudget{remaining: limit, visited: make(map[string]struct{})}
}

// take consumes one backfill from the budget, returning false (and recording a deferral) if
// the budget is exhausted.
func (b *reviewBackfillBudget) take() bool {
	if b.remaining <= 0 {
		b.deferred++
		return false
	}
	b.remaining--
	b.performed++
	return true
}

func (b *reviewBackfillBudget) markVisited(itemID string) {
	b.visited[itemID] = struct{}{}
}

func (b *reviewBackfillBudget) logSummary(ctx context.Context) {
	if b.performed == 0 && b.deferred == 0 {
		return
	}
	slog.InfoContext(ctx, "Review backfill summary",
		"performed", b.performed, "failed", b.failed, "deferred", b.deferred)
}

// pendingReviewBackfillSweepInterval is the minimum time between end-of-cycle sweeps of pending
// review backfills, independent of the sync interval, so items whose backfill keeps being
// deferred or failing are not re-hydrated every cycle.
const pendingReviewBackfillSweepInterval = 15 * time.Minute

// resumePendingReviewBackfills spends the cycle's remaining backfill budget on items that still
// have a pending review backfill but were not processed this cycle (e.g. quiet PRs deferred
// during a cold start that no notification re-hydrates). It re-hydrates them and runs them
// through the normal processing path, returning how many items it processed. It is called once
// at the end of a sync cycle (with s.mu held), never recursively, and at most once per
// pendingReviewBackfillSweepInterval; errors are logged rather than failing the cycle.
func (s *SyncEngine) resumePendingReviewBackfills(ctx context.Context, budget *reviewBackfillBudget) int {
	if s.gh == nil || s.db == nil || budget.remaining <= 0 {
		return 0
	}
	now := time.Now()
	lastSweep := s.lastPendingReviewSweepAt
	if !lastSweep.IsZero() && now.Sub(lastSweep) < pendingReviewBackfillSweepInterval {
		return 0
	}
	s.lastPendingReviewSweepAt = now

	// Over-fetch by the number of visited items so that skipping them still leaves enough.
	candidates, err := s.db.GetPendingReviewBackfills(ctx, budget.remaining+len(budget.visited))
	if err != nil {
		slog.WarnContext(ctx, "Failed to query items with pending review backfill", "error", err)
		return 0
	}
	ids := s.selectPendingReviewBackfills(ctx, candidates, budget)
	if len(ids) == 0 {
		return 0
	}

	slog.InfoContext(ctx, "Resuming pending review backfills", "count", len(ids))
	fetched, paging, missing, err := s.gh.FetchItemsByIDs(ctx, ids)
	if err != nil {
		slog.WarnContext(ctx, "Failed to hydrate items with pending review backfill", "error", err)
		return 0
	}
	for _, id := range missing {
		s.recordPendingBackfillSyncError(ctx, id)
	}
	// Repos were filtered when selecting candidates.
	if err := s.processItemsWithBudget(ctx, fetched, paging, false, budget); err != nil {
		slog.WarnContext(ctx, "Failed to process items with pending review backfill", "error", err)
		return 0
	}
	return len(fetched)
}

// selectPendingReviewBackfills picks up to budget.remaining candidates that were not visited
// this cycle. Candidates in repos that are no longer synced (excluded or not watched) have their
// marker cleared without being fetched: they will not be refreshed, so a backfill for them
// would be wasted.
func (s *SyncEngine) selectPendingReviewBackfills(
	ctx context.Context,
	candidates []database.PendingReviewBackfill,
	budget *reviewBackfillBudget,
) []string {
	watched := s.cfg.GetWatchedRepos()
	excluded := s.cfg.GetExcludedRepos()
	var ids []string
	for _, c := range candidates {
		if len(ids) == budget.remaining {
			break
		}
		if _, seen := budget.visited[c.ID]; seen {
			continue
		}
		if !MatchesFilter(c.Repo, watched, excluded) {
			s.updatePendingItem(ctx, c.ID, "Clearing pending review backfill for item in a filtered repo",
				func(local *octodeckv1.ItemLocalState) { local.ClearReviewBackfillBefore() })
			continue
		}
		ids = append(ids, c.ID)
	}
	return ids
}

// recordPendingBackfillSyncError records a sync error on a pending item that GitHub returned as
// null, following the convention for missing hydrated items. The pending marker is kept, since
// a null can be transient and dropping it would lose the gap boundary, but the sync error
// removes the item from the sweep until a successful re-hydration clears it: the next
// notification for the item, a manual refetch, or the garbage collection stale refresh (open
// items not synced for config.DefaultStaleItemAge). Closed items only recover via a notification
// before they are pruned.
func (s *SyncEngine) recordPendingBackfillSyncError(ctx context.Context, id string) {
	s.updatePendingItem(ctx, id, "Item with pending review backfill not found on GitHub",
		func(local *octodeckv1.ItemLocalState) { local.SetSyncError(errItemNotFoundOnGitHub) })
}

func (s *SyncEngine) updatePendingItem(
	ctx context.Context,
	id, msg string,
	update func(local *octodeckv1.ItemLocalState),
) {
	slog.InfoContext(ctx, msg, "id", id)
	_, err := s.db.UpdateItem(ctx, id, func(item *octodeckv1.Item) error {
		if item.GetLocal() == nil {
			item.SetLocal(octodeckv1.ItemLocalState_builder{}.Build())
		}
		update(item.GetLocal())
		return nil
	})
	if err != nil {
		slog.WarnContext(ctx, "Failed to update item with pending review backfill", "id", id, "error", err)
	}
}

// handleReviewGapResolution merges the freshly hydrated reviews on item with storedReviews,
// backfilling older reviews that the hydration page did not cover and paging in the remaining
// comments of reviews whose first comment page is incomplete.
//
// paging is the item's hydration paging state (zero value if unknown). A backfill is needed
// when the hydration query reports older reviews and the oldest hydrated
// review is not already stored, or when a previous backfill is still pending
// (ItemLocalState.review_backfill_before). If the backfill cannot run (budget exhausted) or
// fails, the pending marker is set to the oldest hydrated review's submission time so that
// later syncs retry it; it is cleared once a backfill succeeds. item.GetLocal() must be non-nil.
func (s *SyncEngine) handleReviewGapResolution(
	ctx context.Context,
	storedReviews []*octodeckv1.Review,
	item *octodeckv1.Item,
	paging github.HydrationPaging,
	budget *reviewBackfillBudget,
) {
	budget.markVisited(item.GetId())
	hydrated := item.GetReviews()
	local := item.GetLocal()
	pendingBefore := local.GetReviewBackfillBefore()

	fresh := hydrated
	if s.gh != nil && needsReviewBackfill(storedReviews, hydrated, paging.ReviewsHasPreviousPage, pendingBefore) {
		if backfilled, ok := s.backfillReviews(ctx, item.GetId(), storedReviews, pendingBefore, budget); ok {
			// Backfilled reviews were fetched after hydration and have fully paged comments,
			// so they win over the overlapping hydrated copies.
			fresh = mergeReviews(hydrated, backfilled)
			local.ClearReviewBackfillBefore()
		} else if pendingBefore == nil {
			// Keep an already-pending (older) boundary: the gap still begins below it.
			local.SetReviewBackfillBefore(oldestReviewSubmittedAt(hydrated))
		}
	}

	s.completeReviewComments(ctx, storedReviews, fresh, paging.ReviewCommentsEndCursors)
	item.SetReviews(mergeReviews(storedReviews, fresh))
}

// needsReviewBackfill reports whether older reviews may be missing between the stored history
// and the hydrated page.
func needsReviewBackfill(
	stored, hydrated []*octodeckv1.Review,
	hasPreviousPage bool,
	pendingBefore *timestamppb.Timestamp,
) bool {
	if pendingBefore != nil {
		return true
	}
	if !hasPreviousPage {
		// The hydrated page reaches the PR's first review.
		return false
	}
	oldest := oldestReview(hydrated)
	if oldest == nil {
		// Older reviews exist but none on the page were usable (e.g. all pending drafts).
		return true
	}
	if oldest.GetId() == "" {
		return false
	}
	for _, r := range stored {
		if r.GetId() == oldest.GetId() {
			return false
		}
	}
	return true
}

// backfillReviews runs FetchReviews for prID if the budget allows, returning ok=false if it was
// deferred or failed.
func (s *SyncEngine) backfillReviews(
	ctx context.Context,
	prID string,
	stored []*octodeckv1.Review,
	pendingBefore *timestamppb.Timestamp,
	budget *reviewBackfillBudget,
) ([]*octodeckv1.Review, bool) {
	if !budget.take() {
		slog.InfoContext(ctx, "Deferring review backfill to a later sync (per-sync budget exhausted)", "id", prID)
		return nil, false
	}

	slog.InfoContext(ctx, "Review gap detected, fetching missing reviews", "id", prID)
	known := knownReviewIDs(stored, pendingBefore)
	reviews, err := s.gh.FetchReviews(ctx, prID, func(reviewID string) bool {
		return known[reviewID]
	})
	if err != nil {
		budget.failed++
		slog.ErrorContext(ctx, "Failed to fetch missing reviews for gap resolution", "id", prID, "error", err)
		return nil, false
	}
	return reviews, true
}

// knownReviewIDs returns the IDs of stored reviews that form contiguous history, at which a
// backfill can stop. While a backfill is pending, stored reviews at or after the pending
// boundary may be preceded by a gap, so only strictly older reviews count as known.
func knownReviewIDs(stored []*octodeckv1.Review, pendingBefore *timestamppb.Timestamp) map[string]bool {
	known := make(map[string]bool, len(stored))
	for _, r := range stored {
		if r.GetId() == "" {
			continue
		}
		if pendingBefore != nil && !r.GetSubmittedAt().AsTime().Before(pendingBefore.AsTime()) {
			continue
		}
		known[r.GetId()] = true
	}
	return known
}

// completeReviewComments pages the remaining comments of fresh reviews whose loaded comments
// are incomplete, unless the stored copy of that review is already complete for the same
// comment count (mergeReviews then preserves the stored comments). Paging resumes after the
// hydrated first page when its end cursor is known. A review paged to exhaustion records the
// count it was paged at (comments_paged_total), so it is not re-paged while GitHub's count is
// unchanged, even if that count exceeds what paging returns.
func (s *SyncEngine) completeReviewComments(
	ctx context.Context,
	stored, fresh []*octodeckv1.Review,
	endCursors map[string]string,
) {
	if s.gh == nil {
		return
	}
	storedByID := make(map[string]*octodeckv1.Review, len(stored))
	for _, r := range stored {
		if r.GetId() != "" {
			storedByID[r.GetId()] = r
		}
	}

	for _, r := range fresh {
		if r.GetId() == "" || github.ReviewCommentsComplete(r) {
			continue
		}
		if prev, ok := storedByID[r.GetId()]; ok && github.ReviewCommentsCompleteFor(prev, r.GetCommentCount()) {
			continue
		}

		cursor, resume := endCursors[r.GetId()]
		comments, err := s.gh.FetchReviewComments(ctx, r.GetId(), cursor)
		if err != nil {
			slog.WarnContext(ctx, "Failed to fetch remaining review comments", "review_id", r.GetId(), "error", err)
			continue
		}
		if resume {
			comments = append(r.GetComments(), comments...)
		}
		r.SetComments(comments)
		r.SetCommentsPagedTotal(r.GetCommentCount())
		github.RecountReviewThreads(r)
	}
}

func oldestReview(reviews []*octodeckv1.Review) *octodeckv1.Review {
	var oldest *octodeckv1.Review
	for _, r := range reviews {
		if oldest == nil || r.GetSubmittedAt().AsTime().Before(oldest.GetSubmittedAt().AsTime()) {
			oldest = r
		}
	}
	return oldest
}

func oldestReviewSubmittedAt(reviews []*octodeckv1.Review) *timestamppb.Timestamp {
	if oldest := oldestReview(reviews); oldest != nil && oldest.GetSubmittedAt() != nil {
		return oldest.GetSubmittedAt()
	}
	// No usable boundary: fall back to the epoch so every stored review is treated as
	// potentially gapped and the retry pages back to the start of the PR.
	return timestamppb.New(time.Unix(0, 0))
}
