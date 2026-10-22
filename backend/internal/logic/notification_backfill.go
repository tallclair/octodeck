package logic

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/tallclair/octodeck/backend/internal/github"
)

// KeyNotificationBackfillWindow is the metadata key for the pending notification backfill
// window (a JSON-encoded NotificationBackfillWindow), or empty when there is none.
const KeyNotificationBackfillWindow = "notification_backfill_window"

// notificationBackfillBoundaryOverlap widens the upper bound of a backfill window past the oldest
// thread a capped fetch returned. GitHub timestamps have one-second resolution, so threads that
// share the oldest fetched second may straddle the page where pagination stopped; re-fetching
// that second is harmless because reconciliation is idempotent.
const notificationBackfillBoundaryOverlap = time.Second

// NotificationBackfillWindow is a range of notification thread update times that a capped
// GET /notifications run did not fetch. GitHub returns threads newest first, so when a run hits
// the safety cap, the threads it missed are the oldest ones: those updated after Since and
// before Before. Later runs drain the window from the newest end (using GitHub's before
// parameter), shrinking Before until a run fetches everything left in it.
type NotificationBackfillWindow struct {
	Since  time.Time `json:"since"`
	Before time.Time `json:"before"`
}

// errCorruptBackfillWindow marks a stored backfill window that can't be parsed.
var errCorruptBackfillWindow = errors.New("corrupt notification backfill window")

// loadNotificationBackfillWindow returns the pending backfill window, and false if there is none.
// An unparseable window is reported as an error wrapping errCorruptBackfillWindow.
func (s *SyncEngine) loadNotificationBackfillWindow(ctx context.Context) (NotificationBackfillWindow, bool, error) {
	raw, err := s.db.GetMetadata(ctx, KeyNotificationBackfillWindow)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && raw == "") {
		return NotificationBackfillWindow{}, false, nil
	}
	if err != nil {
		return NotificationBackfillWindow{}, false, fmt.Errorf("failed to read notification backfill window: %w", err)
	}
	var w NotificationBackfillWindow
	if err := json.Unmarshal([]byte(raw), &w); err != nil {
		return NotificationBackfillWindow{}, false, fmt.Errorf("%w %q: %w", errCorruptBackfillWindow, raw, err)
	}
	return w, true, nil
}

// storeNotificationBackfillWindow persists w, or clears the pending window if w is nil.
func (s *SyncEngine) storeNotificationBackfillWindow(ctx context.Context, w *NotificationBackfillWindow) error {
	value := ""
	if w != nil {
		b, err := json.Marshal(w)
		if err != nil {
			return fmt.Errorf("failed to encode notification backfill window: %w", err)
		}
		value = string(b)
	}
	if err := s.db.SetMetadata(ctx, KeyNotificationBackfillWindow, value); err != nil {
		return fmt.Errorf("failed to store notification backfill window: %w", err)
	}
	return nil
}

// recordNotificationGap adds the range a capped fetch left unfetched, [since, before), to the
// pending backfill window. An existing window is widened to cover both ranges, which may
// re-fetch threads in between; that is redundant but never loses any. An unreadable existing
// window's range is unknown, so it is replaced by everything before before: every run fetched
// all threads newer than its own gap, so nothing newer can be missing.
func (s *SyncEngine) recordNotificationGap(ctx context.Context, since, before time.Time) error {
	gap := NotificationBackfillWindow{Since: since.UTC(), Before: before.UTC()}
	existing, ok, err := s.loadNotificationBackfillWindow(ctx)
	switch {
	case errors.Is(err, errCorruptBackfillWindow):
		slog.ErrorContext(ctx, "Replacing an unreadable notification backfill window", "error", err)
		gap.Since = time.Time{}
	case err != nil:
		// The window can't be read, so it can't be merged; fail and let the caller keep its
		// cursor where it is.
		return err
	case ok:
		if existing.Since.Before(gap.Since) {
			gap.Since = existing.Since
		}
		if existing.Before.After(gap.Before) {
			gap.Before = existing.Before
		}
	}
	slog.WarnContext(ctx, "Notification fetch hit the safety cap; recording a backfill window",
		"since", gap.Since, "before", gap.Before)
	return s.storeNotificationBackfillWindow(ctx, &gap)
}

// gapUpperBound returns the upper bound of the range a capped fetch left unfetched: just past the
// oldest thread it returned. ok is false if no thread carried a usable timestamp.
func gapUpperBound(res *github.NotificationFetchResult) (time.Time, bool) {
	oldest, ok := res.OldestUpdatedAt()
	if !ok {
		return time.Time{}, false
	}
	return oldest.Add(notificationBackfillBoundaryOverlap), true
}

// notificationBackfillResult summarizes one drain of the backfill window for the sync trace.
type notificationBackfillResult struct {
	threads        int
	itemsProcessed int
	remaining      *NotificationBackfillWindow
}

// drainNotificationBackfill fetches (up to the safety cap) the threads in the pending backfill
// window and processes them like any other notification threads. A complete fetch clears the
// window; a capped one shrinks it to the range still unfetched. It is a no-op without a window.
// The window is only updated after its threads are stored, so a failure leaves it for the next
// run. Called with s.mu held.
func (s *SyncEngine) drainNotificationBackfill(
	ctx context.Context,
	budget *reviewBackfillBudget,
) (notificationBackfillResult, error) {
	stored, ok, err := s.loadNotificationBackfillWindow(ctx)
	if errors.Is(err, errCorruptBackfillWindow) {
		// The unreadable window's range is unknown, but the main fetch has just covered
		// everything newer than the cursor, so draining everything before now recovers it.
		slog.ErrorContext(ctx, "Replacing an unreadable notification backfill window", "error", err)
		stored, ok, err = NotificationBackfillWindow{Before: time.Now().UTC()}, true, nil
	}
	if err != nil || !ok {
		return notificationBackfillResult{}, err
	}
	w := &stored
	if !w.Since.Before(w.Before) {
		slog.WarnContext(ctx, "Dropping empty notification backfill window", "since", w.Since, "before", w.Before)
		return notificationBackfillResult{}, s.storeNotificationBackfillWindow(ctx, nil)
	}

	slog.InfoContext(ctx, "Draining notification backfill window", "since", w.Since, "before", w.Before)
	res, err := s.gh.FetchNotificationThreads(ctx, github.NotificationFetchOptions{Since: w.Since, Before: w.Before})
	if err != nil {
		return notificationBackfillResult{remaining: w}, fmt.Errorf("failed to fetch notification backfill: %w", err)
	}

	result := notificationBackfillResult{threads: len(res.Threads)}
	if len(res.Threads) > 0 {
		_ = s.db.RecordNotificationCount(ctx, time.Now(), len(res.Threads))
		items, paging, _, procErr := s.processNotificationThreads(ctx, res.Threads)
		if procErr != nil {
			result.remaining = w
			return result, fmt.Errorf("failed to process notification backfill: %w", procErr)
		}
		if err := s.processItemsWithBudget(ctx, items, paging, true, budget); err != nil {
			result.remaining = w
			return result, fmt.Errorf("failed to save notification backfill: %w", err)
		}
		result.itemsProcessed = len(items)
	}

	if !res.Truncated {
		slog.InfoContext(ctx, "Notification backfill window drained", "threads", len(res.Threads))
		return result, s.storeNotificationBackfillWindow(ctx, nil)
	}

	next := *w
	if upper, ok := gapUpperBound(&res); ok && upper.Before(w.Before) {
		next.Before = upper
	} else if oldest, ok := res.OldestUpdatedAt(); ok && oldest.Before(w.Before) {
		// More than a capped fetch's worth of threads share the oldest second; drop the boundary
		// overlap so the window still shrinks.
		next.Before = oldest
	} else {
		// No progress is possible (no usable timestamps, or every thread is at the upper
		// bound). Keeping the window would refetch the same threads forever.
		slog.ErrorContext(ctx, "Notification backfill made no progress; dropping the window",
			"since", w.Since, "before", w.Before, "threads", len(res.Threads))
		return result, s.storeNotificationBackfillWindow(ctx, nil)
	}
	result.remaining = &next
	return result, s.storeNotificationBackfillWindow(ctx, &next)
}
