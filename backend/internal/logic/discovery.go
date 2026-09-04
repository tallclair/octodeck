package logic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/tallclair/octodeck/backend/internal/database"
)

const (
	// DefaultCandidateSearchLimit is the maximum candidate IDs retrieved per tracked query.
	DefaultCandidateSearchLimit = 100

	// DiscoveryIndexingBuffer is the safety buffer subtracted from the discovery cursor time
	// when injecting the updated:> filter to account for GitHub search indexing latency.
	DiscoveryIndexingBuffer = 2 * time.Minute

	// Trace type for discovery runs recorded in sync_traces.
	traceTypeDiscovery = "discovery"

	// Trigger source for periodic discovery ticker runs.
	triggerSourceDiscoveryTicker = "discovery_ticker"
)

// BuildDiscoverySearchQuery injects an updated:> timestamp filter into baseQuery.
func BuildDiscoverySearchQuery(baseQuery string, since time.Time) string {
	return fmt.Sprintf("%s updated:>%s", strings.TrimSpace(baseQuery), since.UTC().Format("2006-01-02T15:04:05Z"))
}

// DiscoverySyncPayload represents the structured diagnostic payload stored in sync_traces for discovery runs.
type DiscoverySyncPayload struct {
	QueriesCount      int               `json:"queries_count"`
	CandidatesFound   int               `json:"candidates_found"`
	KnownSkippedCount int               `json:"known_skipped_count"`
	UniqueNewCount    int               `json:"unique_new_count"`
	HydratedCount     int               `json:"hydrated_count"`
	HydratedIDs       []string          `json:"hydrated_ids,omitempty"`
	MissingIDs        []string          `json:"missing_ids,omitempty"`
	QueryErrors       map[string]string `json:"query_errors,omitempty"`
	Error             *string           `json:"error,omitempty"`
}

type candidateCollectionResult struct {
	candidatesFound int
	toHydrate       []string
	queryErrors     map[string]string
	queryErrList    []error
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

	if s.getCurrentUser() == "" {
		if err := s.fetchCurrentUser(ctx); err != nil {
			runErr = fmt.Errorf("failed to fetch current user for discovery: %w", err)
			return runErr
		}
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

	if len(candidates.queryErrList) > 0 && candidates.candidatesFound == 0 && uniqueNewCount == 0 {
		runErr = errors.Join(candidates.queryErrList...)
		return runErr
	}

	if err := ctx.Err(); err != nil {
		runErr = err
		return runErr
	}

	if uniqueNewCount > 0 {
		itemsPersisted, runErr = s.hydrateAndPersistDiscoveredItems(ctx, candidates.toHydrate, &payload)
		if runErr != nil {
			return runErr
		}
	} else {
		slog.DebugContext(ctx, "No new candidate items to hydrate, all candidates previously discovered",
			"candidates_found", candidates.candidatesFound, "known_skipped", knownSkipped)
	}

	if len(candidates.queryErrList) > 0 {
		runErr = errors.Join(candidates.queryErrList...)
	}

	return runErr
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
		queryErrors: make(map[string]string),
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

		ids, searchErr := s.gh.SearchCandidateIDs(ctx, effectiveQuery, DefaultCandidateSearchLimit)
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

		s.advanceDiscoveryCursor(ctx, q, searchStartTime)
		res.candidatesFound += len(ids)
		newIDs := filterNewCandidateIDs(ids, knownIDs, seenInRun)
		res.toHydrate = append(res.toHydrate, newIDs...)
	}

	return res, nil
}

func (s *SyncEngine) hydrateAndPersistDiscoveredItems(
	ctx context.Context,
	candidateIDs []string,
	payload *DiscoverySyncPayload,
) (int, error) {
	slog.InfoContext(ctx, "Hydrating newly discovered items", "new_count", len(candidateIDs))
	foundItems, missingIDs, fetchErr := s.gh.FetchItemsByIDs(ctx, candidateIDs)
	if fetchErr != nil {
		return 0, fmt.Errorf("failed to hydrate candidate items: %w", fetchErr)
	}

	payload.HydratedCount = len(foundItems)
	payload.MissingIDs = missingIDs
	for _, item := range foundItems {
		if item != nil {
			payload.HydratedIDs = append(payload.HydratedIDs, item.GetId())
		}
	}

	if len(foundItems) == 0 {
		return 0, nil
	}

	itemsToProcess := foundItems
	if excluded := s.cfg.GetExcludedRepos(); len(excluded) > 0 {
		itemsToProcess = FilterItemsByRepo(itemsToProcess, nil, excluded)
	}

	if err := s.processItemsDirect(ctx, itemsToProcess, false); err != nil {
		return 0, fmt.Errorf("failed to process discovered items: %w", err)
	}

	return len(itemsToProcess), nil
}
