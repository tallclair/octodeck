package logic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/github"
)

const (
	// DiscoveryMaxSearchPages caps the candidate search pages (100 results each) fetched per
	// tracked query in one discovery run. A query with more matches resumes from the newest
	// update it reached on the next run, which also keeps each search under GitHub's limit of
	// 1000 results per query.
	DiscoveryMaxSearchPages = 5

	// DiscoveryIndexingBuffer is the safety buffer subtracted from the discovery cursor time
	// when injecting the updated:> filter to account for GitHub search indexing latency.
	DiscoveryIndexingBuffer = 2 * time.Minute

	// DiscoveryPreFlightWindow is the time window evaluated during pre-flight query checks.
	DiscoveryPreFlightWindow = 48 * time.Hour

	// DiscoveryPreFlightWindowDays is the duration of DiscoveryPreFlightWindow expressed in days.
	DiscoveryPreFlightWindowDays = 2.0

	// DiscoveryPreFlightMaxDailyAvg is the daily average threshold above which a pre-flight warning is triggered.
	DiscoveryPreFlightMaxDailyAvg = 50.0

	// Trace type for discovery runs recorded in sync_traces.
	traceTypeDiscovery = "discovery"

	// Trigger source for periodic discovery ticker runs.
	triggerSourceDiscoveryTicker = "discovery_ticker"
)

// sortQualifierRegex matches sort: qualifiers, which BuildDiscoverySearchQuery replaces.
var sortQualifierRegex = regexp.MustCompile(`(?i)(?:^|\s)-?sort:\S*`)

// BuildDiscoverySearchQuery injects an updated:> timestamp filter into baseQuery and orders the
// results oldest update first (replacing any sort: qualifier in baseQuery), so a search that
// stops at the page cap has covered a contiguous range of update times.
func BuildDiscoverySearchQuery(baseQuery string, since time.Time) string {
	base := strings.TrimSpace(sortQualifierRegex.ReplaceAllString(baseQuery, " "))
	return fmt.Sprintf("%s updated:>%s sort:updated-asc", base, since.UTC().Format("2006-01-02T15:04:05Z"))
}

// BuildDiscoveryPreFlightQuery injects a created:> timestamp filter into baseQuery
// for pre-flight volume estimation over the last 48 hours.
func BuildDiscoveryPreFlightQuery(baseQuery string, since time.Time) string {
	return fmt.Sprintf("%s created:>%s", strings.TrimSpace(baseQuery), since.UTC().Format("2006-01-02T15:04:05Z"))
}

// DiscoverySyncPayload represents the structured diagnostic payload stored in sync_traces for discovery runs.
type DiscoverySyncPayload struct {
	QueriesCount        int               `json:"queries_count"`
	CandidatesFound     int               `json:"candidates_found"`
	KnownSkippedCount   int               `json:"known_skipped_count"`
	UniqueNewCount      int               `json:"unique_new_count"`
	HydratedCount       int               `json:"hydrated_count"`
	HydratedIDs         []string          `json:"hydrated_ids,omitempty"`
	MissingIDs          []string          `json:"missing_ids,omitempty"`
	AutoSubscribedCount int               `json:"auto_subscribed_count,omitempty"`
	AutoSubscribedIDs   []string          `json:"auto_subscribed_ids,omitempty"`
	AutoSubscribeErrors map[string]string `json:"auto_subscribe_errors,omitempty"`
	QueryErrors         map[string]string `json:"query_errors,omitempty"`
	// TruncatedQueries are the queries whose search stopped at the page cap; they resume from
	// the newest update reached on the next run.
	TruncatedQueries []string `json:"truncated_queries,omitempty"`
	// HydrationFailures maps candidates that failed to hydrate with a per-item error (other than
	// not found) to the error. Their queries' cursors stay below them so they are retried, up
	// to discoveryMaxHydrationAttempts runs.
	HydrationFailures map[string]string `json:"hydration_failures,omitempty"`
	// AbandonedIDs are the failed candidates that ran out of attempts and were passed over.
	AbandonedIDs []string `json:"abandoned_ids,omitempty"`
	Error        *string  `json:"error,omitempty"`
}

// discoveryQueryProgress is the outcome of one tracked query's search, applied (cursor advanced
// and yield recorded) only once the run's candidates are stored.
type discoveryQueryProgress struct {
	query      string
	searchedAt time.Time
	// candidates are everything the search matched.
	candidates []github.SearchCandidate
	// newIDs are the matched IDs that were not yet stored and first seen by this query.
	newIDs []string
	// prevCursor is the query's cursor before the search.
	prevCursor time.Time
	// cursor is the next discovery cursor for the query if every candidate is stored.
	cursor time.Time
}

type candidateCollectionResult struct {
	candidatesFound  int
	toHydrate        []string
	autoSubscribeIDs map[string]struct{}
	queryErrors      map[string]string
	queryErrList     []error
	progress         []discoveryQueryProgress
	truncatedQueries []string
}

// RunDiscovery executes the discovery engine pipeline across all configured tracked_queries.
// It searches candidate Issue and PullRequest node IDs, deduplicates against existing SQLite
// records in memory with zero API overhead, hydrates new candidates with full details and
// viewerSubscription state, persists them with initial snapshot state, and records a sync trace.
func (s *SyncEngine) RunDiscovery(ctx context.Context) error {
	s.discoveryMu.Lock()
	defer s.discoveryMu.Unlock()

	return s.runDiscovery(ctx, triggerSourceDiscoveryTicker)
}

// runDiscovery contains the core discovery logic with configurable triggerSource.
func (s *SyncEngine) runDiscovery(ctx context.Context, triggerSource string) error {
	queries := s.cfg.GetTrackedQueries()
	if len(queries) == 0 {
		slog.DebugContext(ctx, "No tracked queries configured, skipping discovery")
		return nil
	}

	startTime := time.Now()
	var runErr error
	var uniqueNewCount int
	var itemsPersisted int
	var payloadBytes []byte

	defer func() {
		s.saveTrace(ctx, traceParams{
			traceType:            traceTypeDiscovery,
			triggerSource:        triggerSource,
			queryString:          strings.Join(queries, " ; "),
			startTime:            startTime,
			pagesCount:           len(queries),
			itemsFetched:         uniqueNewCount,
			itemsPersisted:       itemsPersisted,
			syncErr:              runErr,
			rawPayloadCompressed: payloadBytes,
		})
	}()

	if err := s.ensureCurrentUser(ctx); err != nil {
		runErr = fmt.Errorf("discovery: %w", err)
		return runErr
	}

	knownIDs, err := s.db.GetAllItemIDs(ctx)
	if err != nil {
		runErr = fmt.Errorf("failed to get known item IDs from database: %w", err)
		return runErr
	}

	candidates, err := s.collectDiscoveryCandidates(ctx, queries, knownIDs)
	if err != nil {
		runErr = err
		return runErr
	}

	uniqueNewCount = len(candidates.toHydrate)
	knownSkipped := candidates.candidatesFound - uniqueNewCount

	payload := DiscoverySyncPayload{
		QueriesCount:      len(queries),
		CandidatesFound:   candidates.candidatesFound,
		KnownSkippedCount: knownSkipped,
		UniqueNewCount:    uniqueNewCount,
		HydratedIDs:       make([]string, 0),
		MissingIDs:        make([]string, 0),
		QueryErrors:       candidates.queryErrors,
		TruncatedQueries:  candidates.truncatedQueries,
	}

	defer func() {
		if runErr != nil {
			errStr := runErr.Error()
			payload.Error = &errStr
		}
		if pb, mErr := json.Marshal(payload); mErr == nil {
			payloadBytes, _ = database.CompressPayload(pb)
		}
	}()

	if err := ctx.Err(); err != nil {
		runErr = err
		return runErr
	}

	var failed map[string]string
	if uniqueNewCount > 0 {
		itemsPersisted, failed, runErr = s.hydrateAndPersistDiscoveredItems(
			ctx,
			candidates.toHydrate,
			candidates.autoSubscribeIDs,
			&payload,
		)
		if runErr != nil {
			// Nothing found this run was stored, so no query's cursor moves: the next run
			// searches the same range again.
			return runErr
		}
	} else {
		slog.DebugContext(ctx, "No new candidate items to hydrate, all candidates previously discovered",
			"candidates_found", candidates.candidatesFound, "known_skipped", knownSkipped)
	}

	// Every other candidate is stored (or was already known), so each successful query can
	// move past what it found, except candidates that failed to hydrate and may be retried.
	retry, abandoned := s.trackDiscoveryHydrationFailures(ctx, failed)
	if len(failed) > 0 {
		payload.HydrationFailures = failed
		payload.AbandonedIDs = abandoned
	}
	s.applyDiscoveryProgress(ctx, candidates.progress, failed, retry)

	if len(candidates.queryErrList) > 0 {
		runErr = errors.Join(candidates.queryErrList...)
	}

	return runErr
}

// applyDiscoveryProgress advances each searched query's discovery cursor and records its yield.
// failed are the candidates that failed to hydrate this run (not counted in the yield); a query
// whose candidates include one in retry keeps its cursor below that candidate.
func (s *SyncEngine) applyDiscoveryProgress(
	ctx context.Context,
	progress []discoveryQueryProgress,
	failed map[string]string,
	retry map[string]struct{},
) {
	for _, p := range progress {
		s.advanceDiscoveryCursor(ctx, p.query, p.cursorWithRetries(retry))
		newCount := 0
		for _, id := range p.newIDs {
			if _, bad := failed[id]; !bad {
				newCount++
			}
		}
		s.recordDiscoveryQueryYield(ctx, p.query, p.searchedAt, newCount)
	}
}

// cursorWithRetries returns the query's next cursor, held at the update time of the earliest
// candidate in retry (or at the previous cursor if that time is unknown), so the next run's
// search (which starts the indexing buffer before the cursor) finds it again. The cursor never
// moves backwards.
func (p discoveryQueryProgress) cursorWithRetries(retry map[string]struct{}) time.Time {
	next := p.cursor
	for _, c := range p.candidates {
		if _, ok := retry[c.ID]; !ok {
			continue
		}
		if c.UpdatedAt.IsZero() {
			return p.prevCursor
		}
		if c.UpdatedAt.Before(next) {
			next = c.UpdatedAt
		}
	}
	if next.Before(p.prevCursor) {
		return p.prevCursor
	}
	return next
}

// nextDiscoveryCursor returns the cursor a query moves to after a search that started at
// searchedAt from cursor. A complete search moves it to searchedAt. A search stopped at the page
// cap (results oldest update first) moves it to the newest update reached, so the next run
// resumes there; it always moves forward, past the indexing buffer if need be, so a query whose
// capped results all fall inside the buffer can't stall.
func nextDiscoveryCursor(
	ctx context.Context,
	q string,
	cursor, searchedAt time.Time,
	res github.SearchCandidatesResult,
) time.Time {
	if !res.Truncated {
		return searchedAt
	}
	var newest time.Time
	for _, c := range res.Candidates {
		if c.UpdatedAt.After(newest) {
			newest = c.UpdatedAt
		}
	}
	if newest.IsZero() {
		slog.WarnContext(ctx, "Capped discovery search returned no update times; resuming from the search time",
			"query", q)
		return searchedAt
	}
	if !newest.After(cursor) {
		slog.WarnContext(ctx, "Capped discovery search made no progress past the cursor; skipping the indexing buffer",
			"query", q, "cursor", cursor, "newest", newest)
		newest = newest.Add(DiscoveryIndexingBuffer)
	}
	if newest.After(searchedAt) {
		return searchedAt
	}
	return newest
}

func (s *SyncEngine) getOrSeedDiscoveryCursor(ctx context.Context, q string, now time.Time) time.Time {
	if s.db == nil {
		return now
	}
	c, exists, err := s.db.GetDiscoveryCursor(ctx, q)
	if err != nil {
		slog.WarnContext(ctx, "Failed to get discovery cursor from db", "query", q, "error", err)
	}
	if exists {
		return c
	}
	// Query is newly tracked: seed cursor to current time so no historical backfill occurs.
	if setErr := s.db.SetDiscoveryCursor(ctx, q, now); setErr != nil {
		slog.WarnContext(ctx, "Failed to seed discovery cursor", "query", q, "error", setErr)
	}
	return now
}

func (s *SyncEngine) advanceDiscoveryCursor(ctx context.Context, q string, t time.Time) {
	if s.db == nil {
		return
	}
	if err := s.db.SetDiscoveryCursor(ctx, q, t); err != nil {
		slog.WarnContext(ctx, "Failed to advance discovery cursor", "query", q, "error", err)
	}
}

func filterNewCandidateIDs(ids []string, knownIDs, seenInRun map[string]struct{}) []string {
	var newIDs []string
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, exists := knownIDs[id]; exists {
			continue
		}
		if _, exists := seenInRun[id]; exists {
			continue
		}
		seenInRun[id] = struct{}{}
		newIDs = append(newIDs, id)
	}
	return newIDs
}

func (s *SyncEngine) collectDiscoveryCandidates(
	ctx context.Context,
	queries []string,
	knownIDs map[string]struct{},
) (candidateCollectionResult, error) {
	res := candidateCollectionResult{
		autoSubscribeIDs: make(map[string]struct{}),
		queryErrors:      make(map[string]string),
	}
	seenInRun := make(map[string]struct{})

	for _, q := range queries {
		if err := ctx.Err(); err != nil {
			return res, err
		}

		searchStartTime := time.Now().UTC()
		cursor := s.getOrSeedDiscoveryCursor(ctx, q, searchStartTime)
		since := cursor.Add(-DiscoveryIndexingBuffer)
		effectiveQuery := BuildDiscoverySearchQuery(q, since)

		found, searchErr := s.gh.SearchCandidates(ctx, effectiveQuery, DiscoveryMaxSearchPages)
		if searchErr != nil {
			slog.WarnContext(
				ctx,
				"Candidate search failed for query",
				"query", q,
				"effectiveQuery", effectiveQuery,
				"error", searchErr,
			)
			res.queryErrors[q] = searchErr.Error()
			res.queryErrList = append(res.queryErrList, fmt.Errorf("query %q: %w", q, searchErr))
			continue
		}
		if found.Truncated {
			res.truncatedQueries = append(res.truncatedQueries, q)
		}

		ids := make([]string, 0, len(found.Candidates))
		for _, c := range found.Candidates {
			ids = append(ids, c.ID)
		}
		res.candidatesFound += len(ids)
		if s.cfg != nil && s.cfg.IsQueryAutoSubscribe(q) {
			addUnknownIDs(res.autoSubscribeIDs, ids, knownIDs)
		}
		newIDs := filterNewCandidateIDs(ids, knownIDs, seenInRun)
		res.progress = append(res.progress, discoveryQueryProgress{
			query:      q,
			searchedAt: searchStartTime,
			candidates: found.Candidates,
			newIDs:     newIDs,
			prevCursor: cursor,
			cursor:     nextDiscoveryCursor(ctx, q, cursor, searchStartTime, found),
		})
		res.toHydrate = append(res.toHydrate, newIDs...)
	}

	return res, nil
}

// addUnknownIDs adds the non-empty IDs in ids that are not in knownIDs to set.
func addUnknownIDs(set map[string]struct{}, ids []string, knownIDs map[string]struct{}) {
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, isKnown := knownIDs[id]; !isKnown {
			set[id] = struct{}{}
		}
	}
}

func (s *SyncEngine) recordDiscoveryQueryYield(ctx context.Context, q string, t time.Time, count int) {
	if s.db == nil {
		return
	}
	if err := s.db.RecordDiscoveryQueryCount(ctx, q, t, count); err != nil {
		slog.WarnContext(ctx, "Failed to record discovery query count", "query", q, "error", err)
	}
}

// hydrateAndPersistDiscoveredItems hydrates and stores the new candidates, returning how many
// were stored and the candidates that failed to hydrate with a per-item error (ID to error).
func (s *SyncEngine) hydrateAndPersistDiscoveredItems(
	ctx context.Context,
	candidateIDs []string,
	autoSubscribeIDs map[string]struct{},
	payload *DiscoverySyncPayload,
) (int, map[string]string, error) {
	slog.InfoContext(ctx, "Hydrating newly discovered items", "new_count", len(candidateIDs))
	fetched, fetchErr := s.gh.HydrateItemsByIDs(ctx, candidateIDs)
	if fetchErr != nil {
		return 0, nil, fmt.Errorf("failed to hydrate candidate items: %w", fetchErr)
	}
	foundItems := fetched.Items

	payload.HydratedCount = len(foundItems)
	payload.MissingIDs = fetched.Missing
	for _, item := range foundItems {
		if item != nil {
			payload.HydratedIDs = append(payload.HydratedIDs, item.GetId())
		}
	}

	if len(foundItems) == 0 {
		return 0, fetched.Failed, nil
	}

	itemsToProcess := foundItems
	if excluded := s.cfg.GetExcludedRepos(); len(excluded) > 0 {
		itemsToProcess = FilterItemsByRepo(itemsToProcess, nil, excluded)
	}

	s.autoSubscribeDiscoveredItems(ctx, itemsToProcess, autoSubscribeIDs, payload)

	if err := s.processItemsDirect(ctx, itemsToProcess, fetched.Paging, false); err != nil {
		return 0, nil, fmt.Errorf("failed to process discovered items: %w", err)
	}

	return len(itemsToProcess), fetched.Failed, nil
}

func (s *SyncEngine) autoSubscribeDiscoveredItems(
	ctx context.Context,
	items []*octodeckv1.Item,
	autoSubscribeIDs map[string]struct{},
	payload *DiscoverySyncPayload,
) {
	if len(autoSubscribeIDs) == 0 || s.gh == nil {
		return
	}

	for _, item := range items {
		if err := ctx.Err(); err != nil {
			break
		}
		if item == nil {
			continue
		}
		id := item.GetId()
		if _, shouldAutoSub := autoSubscribeIDs[id]; !shouldAutoSub {
			continue
		}
		subState := item.GetViewerSubscription()
		if subState == octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED ||
			subState == octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_IGNORED {
			continue
		}
		if !s.gh.HasNotificationsScope() {
			slog.DebugContext(
				ctx,
				"Skipping auto-subscribe for discovered item due to missing notifications scope",
				"id", id,
			)
			continue
		}

		subErr := s.gh.UpdateSubscription(ctx, id, octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED)
		if subErr == nil {
			item.SetViewerSubscription(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED)
			payload.AutoSubscribedIDs = append(payload.AutoSubscribedIDs, id)
			payload.AutoSubscribedCount++
			continue
		}

		slog.WarnContext(ctx, "Failed to auto-subscribe discovered item on GitHub", "id", id, "error", subErr)
		if payload.AutoSubscribeErrors == nil {
			payload.AutoSubscribeErrors = make(map[string]string)
		}
		payload.AutoSubscribeErrors[id] = subErr.Error()
		if isDiscoveryScopeError(subErr) {
			s.gh.SetNotificationsScope(false)
		}
	}
}

func isDiscoveryScopeError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	hasScopeKeywords := strings.Contains(msg, "scope") ||
		strings.Contains(msg, "permission") ||
		strings.Contains(msg, "forbidden")
	return strings.Contains(msg, "insufficient_scopes") ||
		strings.Contains(msg, "insufficient scope") ||
		strings.Contains(msg, "required scope") ||
		strings.Contains(msg, "resource not accessible by integration") ||
		strings.Contains(msg, "resource not accessible by personal access token") ||
		(strings.Contains(msg, "notifications") && hasScopeKeywords) ||
		strings.Contains(msg, "status 403")
}
