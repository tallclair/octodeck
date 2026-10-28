package logic

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/github"
)

// The freshness sweep catches changes to stored items that produce no GitHub notification,
// typically the user's own actions taken outside the browser (gh CLI, another device), such as
// closing a PR or marking it ready for review. It searches for the user's items updated since
// its cursor and re-fetches the stored ones that GitHub reports as newer than the stored copy.
// Items that aren't stored are left to discovery.
const (
	// FreshnessSweepInterval is how often the freshness sweep runs in the background.
	FreshnessSweepInterval = 5 * time.Minute

	// FreshnessSweepMinGap is how soon after any sweep started an on-demand sweep is a no-op.
	FreshnessSweepMinGap = time.Minute

	// FreshnessSweepCatchUp is how far back the first sweep looks: a one-time catch-up of items
	// that went stale before the sweep existed.
	FreshnessSweepCatchUp = 30 * 24 * time.Hour

	// FreshnessSweepQuery is the base search of the freshness sweep: every issue and pull request
	// the user is involved in, open or not, so that closes and merges are caught too.
	FreshnessSweepQuery = "involves:@me"

	// KeyFreshnessSweepCursor is the metadata key for the freshness sweep cursor (RFC3339Nano):
	// the GitHub update time up to which stored items are known to be fresh.
	KeyFreshnessSweepCursor = "freshness_sweep_cursor"

	// KeyFreshnessHydrationFailures is the metadata key for the JSON map of items the freshness
	// sweep failed to re-fetch to the number of consecutive runs they failed.
	KeyFreshnessHydrationFailures = "freshness_hydration_failures"

	// Trace type for freshness sweeps recorded in sync_traces.
	traceTypeFreshnessSweep = "freshness_sweep"

	// Trigger sources of freshness sweeps.
	triggerSourceFreshnessTicker = "freshness_ticker"
	triggerSourceAPI             = "api"
)

// FreshnessSweepPayload is the diagnostic payload stored in sync_traces for freshness sweeps.
type FreshnessSweepPayload struct {
	// CandidatesFound is how many items the search matched.
	CandidatesFound int `json:"candidates_found"`
	// UnknownSkippedCount is how many matches aren't stored (left to discovery).
	UnknownSkippedCount int `json:"unknown_skipped_count"`
	// UnchangedSkippedCount is how many stored matches are no newer than the stored copy.
	UnchangedSkippedCount int `json:"unchanged_skipped_count"`
	// StaleIDs are the stored matches that GitHub reports as newer, which were re-fetched.
	StaleIDs []string `json:"stale_ids,omitempty"`
	// RefetchedCount is how many stale items were re-fetched and stored.
	RefetchedCount int `json:"refetched_count"`
	// MissingIDs are stale items GitHub reported as gone.
	MissingIDs []string `json:"missing_ids,omitempty"`
	// HydrationFailures maps stale items that failed to re-fetch with a per-item error to the
	// error. The cursor stays below them so they are retried, up to discoveryMaxHydrationAttempts
	// runs.
	HydrationFailures map[string]string `json:"hydration_failures,omitempty"`
	// AbandonedIDs are the failed items that ran out of attempts and were passed over.
	AbandonedIDs []string `json:"abandoned_ids,omitempty"`
	// Truncated reports that the search stopped at the page cap; the next run resumes from the
	// newest update reached.
	Truncated bool `json:"truncated,omitempty"`
	// Cursor is the cursor after the run.
	Cursor string  `json:"cursor,omitempty"`
	Error  *string `json:"error,omitempty"`
}

// RunFreshnessSweep runs a scheduled freshness sweep. It counts toward the on-demand rate limit.
// It is skipped while another sweep (typically an on-demand one) is running, so it never blocks
// the event loop behind it; that sweep covers the same range.
func (s *SyncEngine) RunFreshnessSweep(ctx context.Context) error {
	if !s.freshnessMu.TryLock() {
		slog.DebugContext(ctx, "Freshness sweep already running; skipping the scheduled sweep")
		return nil
	}
	defer s.freshnessMu.Unlock()

	s.freshnessStateMu.Lock()
	s.lastFreshnessSweepAt = s.now()
	s.freshnessStateMu.Unlock()

	return s.runFreshnessSweep(ctx, triggerSourceFreshnessTicker)
}

// RefreshRecentItems starts an on-demand freshness sweep in the background (detached from ctx's
// cancellation, so it completes after the caller returns) and reports whether it started. It is
// a no-op while a sweep is running or within FreshnessSweepMinGap of the start of the previous
// one. A sweep it starts resets the background sweep timer.
func (s *SyncEngine) RefreshRecentItems(ctx context.Context) bool {
	_, started := s.startOnDemandFreshnessSweep(ctx)
	return started
}

// startOnDemandFreshnessSweep is RefreshRecentItems, also returning a channel that receives
// the sweep's result (nil if it didn't start).
func (s *SyncEngine) startOnDemandFreshnessSweep(ctx context.Context) (<-chan error, bool) {
	if !s.claimOnDemandFreshnessSweep() {
		return nil, false
	}
	done := make(chan error, 1)
	sweepCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), config.SyncHeartbeatTimeout)
	// Detached from the request, but still stopped with the engine.
	go func() {
		select {
		case <-s.stopCh:
			cancel()
		case <-sweepCtx.Done():
		}
	}()
	go func() {
		defer cancel()
		defer s.freshnessMu.Unlock()
		err := s.runFreshnessSweep(sweepCtx, triggerSourceAPI)
		if err != nil {
			slog.ErrorContext(sweepCtx, "On-demand freshness sweep failed", "error", err)
		}
		done <- err
	}()
	return done, true
}

// claimOnDemandFreshnessSweep acquires freshnessMu for an on-demand sweep, unless a sweep is
// running or one started within FreshnessSweepMinGap. On success it records the start and
// resets the background timer; the caller must release freshnessMu when the sweep is done.
func (s *SyncEngine) claimOnDemandFreshnessSweep() bool {
	// A running sweep is a sweep within the gap: don't queue another behind it.
	if !s.freshnessMu.TryLock() {
		return false
	}
	s.freshnessStateMu.Lock()
	defer s.freshnessStateMu.Unlock()
	now := s.now()
	if !s.lastFreshnessSweepAt.IsZero() && now.Sub(s.lastFreshnessSweepAt) < FreshnessSweepMinGap {
		s.freshnessMu.Unlock()
		return false
	}
	s.lastFreshnessSweepAt = now
	if s.tickerFreshness != nil {
		s.tickerFreshness.Reset(FreshnessSweepInterval)
	}
	return true
}

// runFreshnessSweep searches for the user's items updated since the cursor, re-fetches the
// stored ones GitHub reports as newer than the stored copy, and advances the cursor. The caller
// holds freshnessMu.
func (s *SyncEngine) runFreshnessSweep(ctx context.Context, triggerSource string) error {
	startTime := time.Now()
	var runErr error
	var since time.Time
	var effectiveQuery string
	payload := FreshnessSweepPayload{}

	defer func() {
		if runErr != nil {
			errStr := runErr.Error()
			payload.Error = &errStr
		}
		var payloadBytes []byte
		if pb, mErr := json.Marshal(payload); mErr == nil {
			payloadBytes, _ = database.CompressPayload(pb)
		}
		s.saveTrace(ctx, traceParams{
			traceType:            traceTypeFreshnessSweep,
			triggerSource:        triggerSource,
			queryString:          effectiveQuery,
			since:                since,
			startTime:            startTime,
			pagesCount:           1,
			itemsFetched:         len(payload.StaleIDs),
			itemsPersisted:       payload.RefetchedCount,
			syncErr:              runErr,
			rawPayloadCompressed: payloadBytes,
		})
	}()

	if runErr = s.ensureCurrentUser(ctx); runErr != nil {
		runErr = fmt.Errorf("freshness sweep: %w", runErr)
		return runErr
	}

	searchedAt := time.Now().UTC()
	cursor := s.loadFreshnessCursor(ctx, searchedAt)
	since = cursor.Add(-DiscoveryIndexingBuffer)
	effectiveQuery = BuildDiscoverySearchQuery(FreshnessSweepQuery, since)

	found, err := s.gh.SearchCandidates(ctx, effectiveQuery, DiscoveryMaxSearchPages)
	if err != nil {
		runErr = fmt.Errorf("freshness sweep search failed: %w", err)
		return runErr
	}
	payload.CandidatesFound = len(found.Candidates)
	payload.Truncated = found.Truncated

	stored, err := s.db.GetItemUpdatedTimes(ctx)
	if err != nil {
		runErr = err
		return runErr
	}
	payload.StaleIDs = staleFreshnessCandidates(found.Candidates, stored, &payload)

	var failed map[string]string
	if len(payload.StaleIDs) > 0 {
		if failed, runErr = s.refetchStaleItems(ctx, payload.StaleIDs, &payload); runErr != nil {
			// Nothing was stored, so the cursor stays: the next run searches the same range.
			return runErr
		}
	}

	retry, abandoned := s.trackHydrationFailures(ctx, KeyFreshnessHydrationFailures, failed)
	if len(failed) > 0 {
		payload.HydrationFailures = failed
		payload.AbandonedIDs = abandoned
	}
	progress := discoveryQueryProgress{
		query:      FreshnessSweepQuery,
		searchedAt: searchedAt,
		candidates: found.Candidates,
		prevCursor: cursor,
		cursor:     nextDiscoveryCursor(ctx, FreshnessSweepQuery, cursor, searchedAt, found),
	}
	next := progress.cursorWithRetries(retry)
	payload.Cursor = next.Format(time.RFC3339Nano)
	if err := s.db.SetMetadata(ctx, KeyFreshnessSweepCursor, next.Format(time.RFC3339Nano)); err != nil {
		// The items are stored; the next run just searches the same range again.
		slog.WarnContext(ctx, "Failed to advance freshness sweep cursor", "error", err)
	}
	return nil
}

// staleFreshnessCandidates returns the IDs of the candidates that are stored and that GitHub
// reports as updated after the stored copy, counting the skipped ones in payload. A stored
// candidate without a valid update time is treated as stale.
func staleFreshnessCandidates(
	candidates []github.SearchCandidate,
	stored map[string]time.Time,
	payload *FreshnessSweepPayload,
) []string {
	var stale []string
	for _, c := range candidates {
		storedAt, known := stored[c.ID]
		switch {
		case !known:
			payload.UnknownSkippedCount++
		case c.UpdatedAt.IsZero() || c.UpdatedAt.After(storedAt):
			stale = append(stale, c.ID)
		default:
			payload.UnchangedSkippedCount++
		}
	}
	return stale
}

// refetchStaleItems re-fetches the stale items and stores them through the same path as every
// other sync, returning the items that failed with a per-item error.
func (s *SyncEngine) refetchStaleItems(
	ctx context.Context,
	ids []string,
	payload *FreshnessSweepPayload,
) (map[string]string, error) {
	slog.InfoContext(ctx, "Freshness sweep re-fetching items updated on GitHub", "count", len(ids))
	fetched, err := s.gh.HydrateItemsByIDs(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("failed to re-fetch updated items: %w", err)
	}
	payload.MissingIDs = fetched.Missing

	items := fetched.Items
	// Stored items are refreshed like garbage collection and refetches do: only excluded repos
	// are filtered, so items stored by discovery outside the watched repos stay fresh too.
	if excluded := s.cfg.GetExcludedRepos(); len(excluded) > 0 {
		items = FilterItemsByRepo(items, nil, excluded)
	}
	if err := s.processItemsDirect(ctx, items, fetched.Paging, false); err != nil {
		return nil, fmt.Errorf("failed to process re-fetched items: %w", err)
	}
	payload.RefetchedCount = len(items)
	return fetched.Failed, nil
}

// loadFreshnessCursor returns the stored freshness sweep cursor, or FreshnessSweepCatchUp
// before now if there is none (the first run) or it can't be read.
func (s *SyncEngine) loadFreshnessCursor(ctx context.Context, now time.Time) time.Time {
	seed := now.Add(-FreshnessSweepCatchUp)
	raw, err := s.db.GetMetadata(ctx, KeyFreshnessSweepCursor)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		slog.WarnContext(ctx, "Failed to read freshness sweep cursor; catching up", "error", err)
	}
	if err != nil || raw == "" {
		return seed
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		slog.WarnContext(ctx, "Discarding unreadable freshness sweep cursor", "value", raw, "error", err)
		return seed
	}
	return t
}
