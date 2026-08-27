package logic

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/github"
)

const (
	// KeyLastIncSync is the metadata key for the last incremental sync timestamp.
	KeyLastIncSync = "last_incremental_sync"
	// KeyLastNotificationSync is the metadata key for the last notifications check timestamp (RFC3339).
	KeyLastNotificationSync = "last_notification_sync"
	// KeyLastNotificationModified is the metadata key for the HTTP Last-Modified header string.
	KeyLastNotificationModified = "last_notification_modified"
	// KeyLastSuccessfulSync is the metadata key for the last successful sync timestamp.
	KeyLastSuccessfulSync = "last_successful_sync"
	// KeyLastUpdateReceived is the metadata key for the last update received timestamp.
	KeyLastUpdateReceived = "last_update_received"
	// KeyLastSyncDurationMs is the metadata key for the last sync duration in milliseconds.
	KeyLastSyncDurationMs = "last_sync_duration_ms"
	// KeyLastSyncFailed is the metadata key for whether the last sync attempt failed.
	KeyLastSyncFailed = "last_sync_failed"
	// KeyLastError is the metadata key for the error message of the last sync failure.
	KeyLastError              = "last_error"
	gapThreshold              = 20
	dbSaveTimeout             = 5 * time.Second
	traceTypeNotificationSync = "notification_sync"
	triggerSourceTicker       = "ticker"
)

// NotificationSyncPayload represents the structured diagnostic payload stored in sync_traces for notification runs.
type NotificationSyncPayload struct {
	HTTPStatus          int               `json:"http_status"`
	LastModified        string            `json:"last_modified"`
	NotificationsCount  int               `json:"notifications_count"`
	ReasonsBreakdown    map[string]int    `json:"reasons_breakdown"`
	UnsupportedTypes    map[string]int    `json:"unsupported_types"`
	FilteredByRepoCount int               `json:"filtered_by_repo_count"`
	HydratedItems       []string          `json:"hydrated_items"`
	HydrationErrors     map[string]string `json:"hydration_errors"`
	Error               *string           `json:"error"`
}

// SyncEngine manages the synchronization of data from GitHub to the local database.
type SyncEngine struct {
	db     *database.DB
	gh     *github.Client
	cfg    *config.Config
	stopCh chan struct{}
	mu     sync.Mutex

	currentUser string

	tickerInc *time.Ticker

	// Sync Status metrics
	lastSuccessfulSyncAt time.Time
	lastSyncAttemptAt    time.Time
	lastUpdateReceivedAt time.Time
	lastSyncDurationMs   int64
	lastSyncFailed       bool
	lastErrorMessage     string
	failedAttemptsCount  int32
	isSyncing            bool
	statusLoaded         bool
}

// NewSyncEngine creates a new SyncEngine instance.
func NewSyncEngine(db *database.DB, gh *github.Client, cfg *config.Config) *SyncEngine {
	s := &SyncEngine{
		db:     db,
		gh:     gh,
		cfg:    cfg,
		stopCh: make(chan struct{}),
	}
	s.mu.Lock()
	s.loadPersistedStatus(context.Background())
	s.mu.Unlock()
	return s
}

func (s *SyncEngine) parseTimeMetadata(ctx context.Context, key string) (time.Time, bool) {
	if val, err := s.db.GetMetadata(ctx, key); err == nil && val != "" {
		if t, err := time.Parse(time.RFC3339, val); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func (s *SyncEngine) loadFailedStatus(ctx context.Context) {
	if s.lastSyncFailed {
		return
	}
	val, err := s.db.GetMetadata(ctx, KeyLastSyncFailed)
	if err == nil && val == "true" {
		s.lastSyncFailed = true
		if errVal, err := s.db.GetMetadata(ctx, KeyLastError); err == nil {
			s.lastErrorMessage = errVal
		}
	}
}

func (s *SyncEngine) loadDurationStatus(ctx context.Context) {
	if s.lastSyncDurationMs != 0 {
		return
	}
	val, err := s.db.GetMetadata(ctx, KeyLastSyncDurationMs)
	if err == nil && val != "" {
		if d, parseErr := strconv.ParseInt(val, 10, 64); parseErr == nil {
			s.lastSyncDurationMs = d
		}
	}
}

func (s *SyncEngine) loadPersistedStatus(ctx context.Context) {
	if s.db == nil || s.statusLoaded {
		return
	}
	s.statusLoaded = true

	if s.lastSuccessfulSyncAt.IsZero() {
		if t, ok := s.parseTimeMetadata(ctx, KeyLastSuccessfulSync); ok {
			s.lastSuccessfulSyncAt = t
		}
	}
	if s.lastUpdateReceivedAt.IsZero() {
		if t, ok := s.parseTimeMetadata(ctx, KeyLastUpdateReceived); ok {
			s.lastUpdateReceivedAt = t
		}
	}
	s.loadFailedStatus(ctx)
	s.loadDurationStatus(ctx)
}

func (s *SyncEngine) recordSyncStart() {
	s.isSyncing = true
	s.lastSyncAttemptAt = time.Now()
}

func (s *SyncEngine) recordSyncFailure(dbCtx context.Context, err error) {
	s.lastSyncFailed = true
	s.lastErrorMessage = err.Error()
	s.failedAttemptsCount++
	if s.db == nil {
		return
	}
	if setErr := s.db.SetMetadata(dbCtx, KeyLastSyncFailed, "true"); setErr != nil {
		slog.ErrorContext(dbCtx, "Failed to persist last_sync_failed metadata", "error", setErr)
	}
	if setErr := s.db.SetMetadata(dbCtx, KeyLastError, err.Error()); setErr != nil {
		slog.ErrorContext(dbCtx, "Failed to persist last_error metadata", "error", setErr)
	}
}

func (s *SyncEngine) recordSyncSuccess(dbCtx context.Context, itemsProcessed int) {
	now := time.Now()
	s.lastSyncFailed = false
	s.lastErrorMessage = ""
	s.failedAttemptsCount = 0
	s.lastSuccessfulSyncAt = now
	if s.db != nil {
		_ = s.db.SetMetadata(dbCtx, KeyLastSyncFailed, "false")
		_ = s.db.SetMetadata(dbCtx, KeyLastError, "")
		if err := s.db.SetMetadata(dbCtx, KeyLastSuccessfulSync, now.Format(time.RFC3339)); err != nil {
			slog.ErrorContext(dbCtx, "Failed to persist last_successful_sync metadata", "error", err)
		}
	}
	if itemsProcessed > 0 {
		s.lastUpdateReceivedAt = now
		if s.db != nil {
			if err := s.db.SetMetadata(dbCtx, KeyLastUpdateReceived, now.Format(time.RFC3339)); err != nil {
				slog.ErrorContext(dbCtx, "Failed to persist last_update_received metadata", "error", err)
			}
		}
	}
}

func (s *SyncEngine) recordSyncFinish(ctx context.Context, err error, itemsProcessed int) {
	s.isSyncing = false
	if !s.lastSyncAttemptAt.IsZero() {
		s.lastSyncDurationMs = time.Since(s.lastSyncAttemptAt).Milliseconds()
	}
	dbCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), dbSaveTimeout)
	defer cancel()

	if s.db != nil && s.lastSyncDurationMs > 0 {
		_ = s.db.SetMetadata(dbCtx, KeyLastSyncDurationMs, strconv.FormatInt(s.lastSyncDurationMs, 10))
	}

	if err != nil {
		s.recordSyncFailure(dbCtx, err)
	} else {
		s.recordSyncSuccess(dbCtx, itemsProcessed)
	}
}

// GetStatus returns the current sync status.
func (s *SyncEngine) GetStatus() *octodeckv1.SyncStatus {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.loadPersistedStatus(context.Background())

	var rate24h, rate7d, rate30d float64
	if s.db != nil {
		rate24h, rate7d, rate30d, _ = s.db.GetNotificationRates(context.Background(), time.Now())
	}

	builder := octodeckv1.SyncStatus_builder{
		IsSyncing:            config.Ptr(s.isSyncing),
		LastSyncFailed:       config.Ptr(s.lastSyncFailed),
		LastErrorMessage:     config.Ptr(s.lastErrorMessage),
		FailedAttemptsCount:  config.Ptr(s.failedAttemptsCount),
		NotificationRate_24H: config.Ptr(rate24h),
		NotificationRate_7D:  config.Ptr(rate7d),
		NotificationRate_30D: config.Ptr(rate30d),
		LastSyncDurationMs:   config.Ptr(s.lastSyncDurationMs),
	}

	if !s.lastSuccessfulSyncAt.IsZero() {
		builder.LastSuccessfulSyncAt = timestamppb.New(s.lastSuccessfulSyncAt)
	}
	if !s.lastSyncAttemptAt.IsZero() {
		builder.LastSyncAttemptAt = timestamppb.New(s.lastSyncAttemptAt)
	}
	if !s.lastUpdateReceivedAt.IsZero() {
		builder.LastUpdateReceivedAt = timestamppb.New(s.lastUpdateReceivedAt)
	}

	return builder.Build()
}

// Start begins the background synchronization processes.
func (s *SyncEngine) Start(ctx context.Context) {
	s.mu.Lock()
	s.loadPersistedStatus(ctx)
	s.mu.Unlock()
	// Initial user fetch
	fetchCtx, cancel := context.WithTimeout(ctx, 1*time.Minute)
	if err := s.fetchCurrentUser(fetchCtx); err != nil {
		slog.ErrorContext(ctx, "Failed to fetch current user, sync engine will retry later", "error", err)
	}
	cancel()

	// Initial Population (Backfill)
	// Trigger: Backend startup IF the issues table is empty.
	isPopulated, err := s.db.IsPopulated(ctx)
	if err != nil {
		slog.ErrorContext(ctx, "Failed to check if DB is populated", "error", err)
	} else if !isPopulated {
		go func() {
			slog.InfoContext(ctx, "DB empty, running initial inventory sync (Backfill)...")
			if err := s.RunInventorySync(ctx); err != nil {
				slog.ErrorContext(ctx, "Initial inventory sync failed", "error", err)
			}
		}()
	}

	s.tickerInc = time.NewTicker(s.cfg.GetSyncInterval())
	tickerGC := time.NewTicker(config.DefaultGCInterval)

	go func() {
		for {
			select {
			case <-ctx.Done():
				s.tickerInc.Stop()
				tickerGC.Stop()
				return
			case <-s.stopCh:
				s.tickerInc.Stop()
				tickerGC.Stop()
				return
			case <-s.tickerInc.C:
				syncCtx, cancel := context.WithTimeout(ctx, config.SyncHeartbeatTimeout)
				if err := s.RunIncrementalSync(syncCtx); err != nil {
					slog.ErrorContext(syncCtx, "Heartbeat sync failed", "error", err)
				}
				cancel()
			case <-tickerGC.C:
				gcCtx, cancel := context.WithTimeout(ctx, config.SyncGCTimeout)
				if err := s.RunGarbageCollection(gcCtx); err != nil {
					slog.ErrorContext(gcCtx, "Garbage collection failed", "error", err)
				}
				cancel()
			}
		}
	}()
}

// ResetTicker resets the background sync ticker to match the current polling interval configuration.
func (s *SyncEngine) ResetTicker() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.tickerInc != nil {
		s.tickerInc.Reset(s.cfg.GetSyncInterval())
	}
}

// Stop terminates the background synchronization processes.
func (s *SyncEngine) Stop() {
	close(s.stopCh)
}

func (s *SyncEngine) fetchCurrentUser(ctx context.Context) error {
	login, ok, err := s.gh.CheckAuth(ctx)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("not authenticated")
	}
	s.currentUser = login
	return nil
}

// ForceSync triggers an immediate incremental sync.
func (s *SyncEngine) ForceSync(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.runIncrementalSync(ctx, "force_sync"); err != nil {
		return err
	}

	if s.tickerInc != nil {
		s.tickerInc.Reset(s.cfg.GetSyncInterval())
	}
	return nil
}

func (s *SyncEngine) fetchItemFromGitHub(
	ctx context.Context,
	id string,
	existing *octodeckv1.Item,
) ([]*octodeckv1.Item, error) {
	if existing != nil {
		fetched, missing, err := s.gh.FetchItems(ctx, []*octodeckv1.Item{existing})
		if err != nil {
			return nil, fmt.Errorf("failed to fetch item from GitHub: %w", err)
		}
		if len(missing) > 0 {
			return nil, errors.New("item was not found on GitHub")
		}
		return fetched, nil
	}

	if repo, number, ok := database.ParseRepoAndNumber(id); ok {
		item, err := s.gh.FetchItemByRepoAndNumber(ctx, repo, number)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch item %s from GitHub: %w", id, err)
		}
		if item != nil {
			return []*octodeckv1.Item{item}, nil
		}
		return nil, errors.New("no item returned from GitHub")
	}

	fetched, missing, err := s.gh.FetchItemsByIDs(ctx, []string{id})
	if err != nil {
		return nil, fmt.Errorf("failed to fetch item %s from GitHub: %w", id, err)
	}
	if len(missing) > 0 || len(fetched) == 0 {
		return nil, errors.New("item was not found on GitHub")
	}
	return fetched, nil
}

// RefetchItem fetches a single item directly from GitHub, recalculates state, and updates the database.
// If the item is not already in the database, it is fetched on-demand from GitHub and imported.
func (s *SyncEngine) RefetchItem(ctx context.Context, id string) (*octodeckv1.Item, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	startTime := time.Now()
	var refetchErr error
	var fetchedCount int
	defer func() {
		s.saveTrace(ctx, traceParams{
			traceType:      "refetch",
			triggerSource:  "api",
			queryString:    id,
			startTime:      startTime,
			pagesCount:     1,
			itemsFetched:   fetchedCount,
			itemsPersisted: fetchedCount,
			syncErr:        refetchErr,
		})
	}()

	if s.currentUser == "" {
		if refetchErr = s.fetchCurrentUser(ctx); refetchErr != nil {
			return nil, refetchErr
		}
	}

	existingItem, _ := s.db.GetItem(ctx, id)
	var fetched []*octodeckv1.Item
	fetched, refetchErr = s.fetchItemFromGitHub(ctx, id, existingItem)
	if refetchErr != nil {
		return nil, refetchErr
	}
	if len(fetched) == 0 {
		refetchErr = errors.New("no item returned from GitHub")
		return nil, refetchErr
	}
	fetchedCount = len(fetched)

	if refetchErr = s.processItemsDirect(ctx, fetched, false); refetchErr != nil {
		return nil, fmt.Errorf("failed to process refetched item: %w", refetchErr)
	}

	return s.db.GetItem(ctx, fetched[0].GetId())
}

// BackfillItems fetches all items currently stored in the database from GitHub and updates them with full details.
func (s *SyncEngine) BackfillItems(ctx context.Context) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	startTime := time.Now()
	var backfillErr error
	var fetchedCount int
	defer func() {
		s.saveTrace(ctx, traceParams{
			traceType:      "backfill",
			triggerSource:  "cli",
			startTime:      startTime,
			pagesCount:     1,
			itemsFetched:   fetchedCount,
			itemsPersisted: fetchedCount,
			syncErr:        backfillErr,
		})
	}()

	if s.currentUser == "" {
		if backfillErr = s.fetchCurrentUser(ctx); backfillErr != nil {
			return 0, backfillErr
		}
	}

	var items []*octodeckv1.Item
	items, backfillErr = s.db.GetItems(ctx, nil)
	if backfillErr != nil {
		return 0, fmt.Errorf("failed to fetch items from database: %w", backfillErr)
	}

	if len(items) == 0 {
		return 0, nil
	}

	slog.InfoContext(ctx, "Backfilling items from GitHub", "count", len(items))

	var fetched []*octodeckv1.Item
	var missing []string
	fetched, missing, backfillErr = s.gh.FetchItems(ctx, items)
	if backfillErr != nil {
		return 0, fmt.Errorf("failed to fetch items from GitHub: %w", backfillErr)
	}
	fetchedCount = len(fetched)

	if backfillErr = s.processItems(ctx, fetched); backfillErr != nil {
		return 0, fmt.Errorf("failed to process backfilled items: %w", backfillErr)
	}

	if len(missing) > 0 {
		slog.WarnContext(ctx, "Items not found on GitHub during backfill", "count", len(missing))
		for _, missingID := range missing {
			if existing, err := s.db.GetItem(ctx, missingID); err == nil && existing != nil {
				if existing.GetLocal() == nil {
					existing.SetLocal(octodeckv1.ItemLocalState_builder{}.Build())
				}
				existing.GetLocal().SetSyncError("Item not found on GitHub (404/deleted)")
				_ = s.db.SaveItems(ctx, []*octodeckv1.Item{existing})
			}
		}
	}

	return len(fetched), nil
}

func (s *SyncEngine) fetchInventoryNotifications(
	ctx context.Context,
	startTime time.Time,
) ([]*octodeckv1.Item, string) {
	threads, nLastMod, _, notifErr := s.gh.FetchNotifications(ctx, time.Time{}, "")
	if notifErr != nil {
		slog.WarnContext(ctx, "Failed to fetch notifications during inventory sync", "error", notifErr)
		return nil, ""
	}
	if len(threads) == 0 {
		return nil, nLastMod
	}
	if s.db != nil {
		_ = s.db.RecordNotificationCount(ctx, startTime, len(threads))
	}
	notifItems, _, notifProcErr := s.processNotificationThreads(ctx, threads)
	if notifProcErr != nil {
		slog.WarnContext(ctx, "Failed to process notification threads during inventory sync", "error", notifProcErr)
	}
	return notifItems, nLastMod
}

func (s *SyncEngine) combineAndSaveInventoryItems(
	ctx context.Context,
	inventoryItems []*octodeckv1.Item,
	notifItems []*octodeckv1.Item,
	startTime time.Time,
	notifLastModified string,
) (int, error) {
	combinedMap := make(map[string]*octodeckv1.Item)
	for _, item := range inventoryItems {
		if item != nil && item.GetId() != "" {
			combinedMap[item.GetId()] = item
		}
	}
	for _, item := range notifItems {
		if item != nil && item.GetId() != "" {
			combinedMap[item.GetId()] = item
		}
	}

	var allItems []*octodeckv1.Item
	for _, item := range combinedMap {
		allItems = append(allItems, item)
	}

	if err := s.processItems(ctx, allItems); err != nil {
		return 0, err
	}

	nowStr := startTime.UTC().Format(time.RFC3339)
	_ = s.db.SetMetadata(ctx, KeyLastIncSync, nowStr)
	_ = s.db.SetMetadata(ctx, KeyLastNotificationSync, nowStr)
	if notifLastModified != "" {
		_ = s.db.SetMetadata(ctx, KeyLastNotificationModified, notifLastModified)
	}
	return len(allItems), nil
}

// RunInventorySync performs a full inventory sync (backfill).
// It combines recent notifications (up to 100) with open authored/assigned search.
func (s *SyncEngine) RunInventorySync(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.recordSyncStart()

	var err error
	var itemsProcessed int
	startTime := time.Now()
	defer func() {
		s.recordSyncFinish(ctx, err, itemsProcessed)
		s.saveTrace(ctx, traceParams{
			traceType:      "inventory",
			triggerSource:  "startup",
			queryString:    "is:open (assignee:@me OR author:@me) + notifications",
			startTime:      startTime,
			pagesCount:     1,
			itemsFetched:   itemsProcessed,
			itemsPersisted: itemsProcessed,
			syncErr:        err,
		})
	}()

	if s.currentUser == "" {
		if err = s.fetchCurrentUser(ctx); err != nil {
			return err
		}
	}

	slog.InfoContext(ctx, "Starting Hybrid Inventory Sync (Backfill)")

	inventoryItems, invErr := s.gh.FetchInventory(ctx)
	if invErr != nil {
		err = fmt.Errorf("failed to fetch inventory items: %w", invErr)
		return err
	}

	notifItems, notifLastModified := s.fetchInventoryNotifications(ctx, startTime)
	itemsProcessed, err = s.combineAndSaveInventoryItems(ctx, inventoryItems, notifItems, startTime, notifLastModified)
	if err != nil {
		return err
	}

	slog.InfoContext(ctx, "Finished Hybrid Inventory Sync (Backfill)", "count", itemsProcessed)
	return nil
}

// RunIncrementalSync performs an incremental sync based on notifications.
func (s *SyncEngine) RunIncrementalSync(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runIncrementalSync(ctx, triggerSourceTicker)
}

func (s *SyncEngine) calculateIncrementalSyncSince(
	ctx context.Context,
	startTime time.Time,
	triggerSource string,
) (time.Time, string, bool) {
	lastSync, _ := s.parseTimeMetadata(ctx, KeyLastNotificationSync)
	if lastSync.IsZero() {
		lastSync, _ = s.parseTimeMetadata(ctx, KeyLastIncSync)
	}
	lastModified, _ := s.db.GetMetadata(ctx, KeyLastNotificationModified)

	if triggerSource == "force_sync" {
		return startTime.Add(-15 * time.Minute), "", false
	}
	if !lastSync.IsZero() && time.Since(lastSync) < config.MinSyncInterval && triggerSource == triggerSourceTicker {
		slog.InfoContext(ctx, "Sync requested too soon after last sync, skipping", "last_sync", lastSync)
		return time.Time{}, "", true
	}
	if lastSync.IsZero() {
		lastSync = startTime.Add(-24 * time.Hour)
	}
	return lastSync.Add(-15 * time.Minute), lastModified, false
}

func (s *SyncEngine) handleIncrementalSyncResult(
	ctx context.Context,
	threads []github.NotificationThread,
	statusCode int,
	newLastModified string,
	oldLastModified string,
	startTime time.Time,
) (int, *NotificationSyncPayload, []byte, error) {
	nowStr := startTime.UTC().Format(time.RFC3339)
	if statusCode == http.StatusNotModified {
		slog.InfoContext(ctx, "Notifications not modified (304), sync complete")
		_ = s.db.SetMetadata(ctx, KeyLastNotificationSync, nowStr)
		_ = s.db.SetMetadata(ctx, KeyLastIncSync, nowStr)

		p := NotificationSyncPayload{
			HTTPStatus:          http.StatusNotModified,
			LastModified:        oldLastModified,
			NotificationsCount:  0,
			ReasonsBreakdown:    make(map[string]int),
			UnsupportedTypes:    make(map[string]int),
			FilteredByRepoCount: 0,
			HydratedItems:       make([]string, 0),
			HydrationErrors:     make(map[string]string),
		}
		pb, _ := json.Marshal(p)
		compressed, _ := database.CompressPayload(pb)
		return 0, &p, compressed, nil
	}

	if len(threads) > 0 && s.db != nil {
		_ = s.db.RecordNotificationCount(ctx, startTime, len(threads))
	}

	fetchedItems, payload, err := s.processNotificationThreads(ctx, threads)
	if err != nil {
		return 0, nil, nil, err
	}

	payload.HTTPStatus = statusCode
	if newLastModified != "" {
		payload.LastModified = newLastModified
	} else {
		payload.LastModified = oldLastModified
	}

	var itemsProcessed int
	if len(fetchedItems) > 0 {
		if err := s.processItems(ctx, fetchedItems); err != nil {
			return 0, nil, nil, err
		}
		itemsProcessed = len(fetchedItems)
	}

	if newLastModified != "" {
		_ = s.db.SetMetadata(ctx, KeyLastNotificationModified, newLastModified)
	}
	_ = s.db.SetMetadata(ctx, KeyLastNotificationSync, nowStr)
	_ = s.db.SetMetadata(ctx, KeyLastIncSync, nowStr)

	pb, _ := json.Marshal(payload)
	compressed, _ := database.CompressPayload(pb)
	return itemsProcessed, payload, compressed, nil
}

func (s *SyncEngine) runIncrementalSync(ctx context.Context, triggerSource string) error {
	s.recordSyncStart()

	var err error
	var itemsProcessed int
	startTime := time.Now()
	var since time.Time
	var payloadBytes []byte

	defer func() {
		s.recordSyncFinish(ctx, err, itemsProcessed)
		s.saveTrace(ctx, traceParams{
			traceType:            traceTypeNotificationSync,
			triggerSource:        triggerSource,
			since:                since,
			startTime:            startTime,
			pagesCount:           1,
			itemsFetched:         itemsProcessed,
			itemsPersisted:       itemsProcessed,
			syncErr:              err,
			rawPayloadCompressed: payloadBytes,
		})
	}()

	if s.currentUser == "" {
		if err = s.fetchCurrentUser(ctx); err != nil {
			return err
		}
	}

	var skip bool
	var lastModified string
	since, lastModified, skip = s.calculateIncrementalSyncSince(ctx, startTime, triggerSource)
	if skip {
		return nil
	}

	threads, newLastModified, statusCode, fetchErr := s.gh.FetchNotifications(ctx, since, lastModified)
	if fetchErr != nil {
		err = fmt.Errorf("failed to fetch notifications: %w", fetchErr)
		return err
	}

	itemsProcessed, _, payloadBytes, err = s.handleIncrementalSyncResult(
		ctx, threads, statusCode, newLastModified, lastModified, startTime,
	)
	return err
}

func (s *SyncEngine) extractNotificationTargets(
	threads []github.NotificationThread,
	payload *NotificationSyncPayload,
) []github.ItemTarget {
	watchedRepos := s.cfg.GetWatchedRepos()
	excludedRepos := s.cfg.GetExcludedRepos()
	var targets []github.ItemTarget
	seenTargets := make(map[github.ItemTarget]bool)

	for _, t := range threads {
		if t.Reason != "" {
			payload.ReasonsBreakdown[t.Reason]++
		}

		owner, repo, number, itemType, err := github.ParseSubjectURL(t.Subject.URL)
		if err != nil || itemType == octodeckv1.ItemType_ITEM_TYPE_UNSPECIFIED {
			typeName := t.Subject.Type
			if typeName == "" {
				typeName = "Unknown"
			}
			payload.UnsupportedTypes[typeName]++
			continue
		}

		repoFullName := fmt.Sprintf("%s/%s", owner, repo)
		if len(FilterRepos([]string{repoFullName}, watchedRepos, excludedRepos)) == 0 {
			payload.FilteredByRepoCount++
			continue
		}

		target := github.ItemTarget{Owner: owner, Repo: repo, Number: number}
		if !seenTargets[target] {
			seenTargets[target] = true
			targets = append(targets, target)
		}
	}
	return targets
}

func (s *SyncEngine) collectNodeIDs(
	ctx context.Context,
	targets []github.ItemTarget,
	payload *NotificationSyncPayload,
) ([]string, []string, error) {
	var nodeIDs []string
	var unresolvable []string
	seenIDs := make(map[string]bool)
	var unknownTargets []github.ItemTarget

	for _, target := range targets {
		existing, err := s.db.GetItem(ctx, target.Key())
		if err == nil && existing != nil && existing.GetId() != "" {
			if !seenIDs[existing.GetId()] {
				seenIDs[existing.GetId()] = true
				nodeIDs = append(nodeIDs, existing.GetId())
			}
		} else {
			unknownTargets = append(unknownTargets, target)
		}
	}

	if len(unknownTargets) == 0 {
		return nodeIDs, nil, nil
	}

	resolvedMap, err := s.gh.ResolveNodeIDs(ctx, unknownTargets)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to resolve node IDs: %w", err)
	}

	for _, target := range unknownTargets {
		id, ok := resolvedMap[target]
		if ok && id != "" {
			if !seenIDs[id] {
				seenIDs[id] = true
				nodeIDs = append(nodeIDs, id)
			}
		} else {
			payload.HydrationErrors[target.Key()] = "Failed to resolve GraphQL Node ID"
			unresolvable = append(unresolvable, target.Key())
		}
	}

	return nodeIDs, unresolvable, nil
}

func (s *SyncEngine) handleMissingHydratedItems(
	ctx context.Context,
	missingIDs []string,
	payload *NotificationSyncPayload,
) {
	now := timestamppb.New(time.Now())
	for _, missingID := range missingIDs {
		errStr := payload.HydrationErrors[missingID]
		if errStr == "" {
			errStr = "Item not found on GitHub (404/deleted)"
			payload.HydrationErrors[missingID] = errStr
		}
		existing, getErr := s.db.GetItem(ctx, missingID)
		if getErr == nil && existing != nil {
			if existing.GetLocal() == nil {
				existing.SetLocal(octodeckv1.ItemLocalState_builder{}.Build())
			}
			existing.GetLocal().SetSyncError(errStr)
			_ = s.db.SaveItems(ctx, []*octodeckv1.Item{existing})
		} else {
			repo := "unknown"
			var number int32 = 0
			if r, n, ok := database.ParseRepoAndNumber(missingID); ok {
				repo = r
				number = n
			}
			stub := octodeckv1.Item_builder{
				Id:           config.Ptr(missingID),
				Repo:         config.Ptr(repo),
				Number:       config.Ptr(number),
				Type:         config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
				Title:        config.Ptr("Notification: " + missingID),
				State:        config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
				UpdatedAt:    now,
				LastSyncedAt: now,
				Local: octodeckv1.ItemLocalState_builder{
					ComputedStatus: config.Ptr(octodeckv1.ItemStatus_ITEM_STATUS_NEW),
					SyncError:      config.Ptr(errStr),
				}.Build(),
			}.Build()
			_ = s.db.SaveItems(ctx, []*octodeckv1.Item{stub})
		}
	}
}

func (s *SyncEngine) processNotificationThreads(
	ctx context.Context,
	threads []github.NotificationThread,
) ([]*octodeckv1.Item, *NotificationSyncPayload, error) {
	payload := &NotificationSyncPayload{
		NotificationsCount: len(threads),
		ReasonsBreakdown:   make(map[string]int),
		UnsupportedTypes:   make(map[string]int),
		HydrationErrors:    make(map[string]string),
		HydratedItems:      make([]string, 0),
	}

	if len(threads) == 0 {
		return nil, payload, nil
	}

	targets := s.extractNotificationTargets(threads, payload)
	if len(targets) == 0 {
		return nil, payload, nil
	}

	nodeIDs, unresolvable, err := s.collectNodeIDs(ctx, targets, payload)
	if err != nil {
		return nil, payload, err
	}

	var fetchedItems []*octodeckv1.Item
	var missingIDs []string
	if len(nodeIDs) > 0 {
		payload.HydratedItems = nodeIDs
		var fetchErr error
		fetchedItems, missingIDs, fetchErr = s.gh.FetchItemsByIDs(ctx, nodeIDs)
		if fetchErr != nil {
			return nil, payload, fmt.Errorf("failed to hydrate items: %w", fetchErr)
		}
	}

	if len(unresolvable) > 0 {
		missingIDs = append(missingIDs, unresolvable...)
	}
	if len(missingIDs) > 0 {
		s.handleMissingHydratedItems(ctx, missingIDs, payload)
	}
	return fetchedItems, payload, nil
}

// RunGarbageCollection removes old or stale items from the database.
func (s *SyncEngine) RunGarbageCollection(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	startTime := time.Now()
	var gcErr error
	var processedCount int
	defer func() {
		s.saveTrace(ctx, traceParams{
			traceType:      "garbage_collection",
			triggerSource:  "gc_ticker",
			startTime:      startTime,
			pagesCount:     1,
			itemsFetched:   processedCount,
			itemsPersisted: processedCount,
			syncErr:        gcErr,
		})
	}()

	if s.currentUser == "" {
		if gcErr = s.fetchCurrentUser(ctx); gcErr != nil {
			return gcErr
		}
	}

	slog.InfoContext(ctx, "Starting Garbage Collection")

	// Retention Pruning of old traces (24 hours)
	traceCutoff := time.Now().Add(-24 * time.Hour)
	prunedTraces, err := s.db.PruneOldSyncTraces(ctx, traceCutoff)
	if err != nil {
		slog.ErrorContext(ctx, "Failed to prune old sync traces", "error", err)
	} else if prunedTraces > 0 {
		slog.InfoContext(ctx, "Pruned old sync traces", "count", prunedTraces)
	}

	// Retention Pruning of old notification stats (35 days)
	statsCutoff := time.Now().Add(-35 * 24 * time.Hour)
	if s.db != nil {
		if prunedStats, sErr := s.db.PruneOldNotificationStats(ctx, statsCutoff); sErr != nil {
			slog.ErrorContext(ctx, "Failed to prune old notification stats", "error", sErr)
		} else if prunedStats > 0 {
			slog.InfoContext(ctx, "Pruned old notification stats", "count", prunedStats)
		}
	}

	// Retention Pruning of items (90 days)
	pruneCutoff := time.Now().Add(-config.DefaultPruneItemAge)
	prunedCount, err := s.db.PruneOldItems(ctx, pruneCutoff)
	if err != nil {
		slog.ErrorContext(ctx, "Failed to prune old items", "error", err)
	} else if prunedCount > 0 {
		slog.InfoContext(ctx, "Pruned old items", "count", prunedCount)
	}

	staleCutoff := time.Now().Add(-config.DefaultStaleItemAge)
	staleItems, err := s.db.GetStaleItems(ctx, staleCutoff)
	if err != nil {
		gcErr = fmt.Errorf("failed to get stale items: %w", err)
		return gcErr
	}

	if len(staleItems) == 0 {
		slog.InfoContext(ctx, "No stale items found")
		return nil
	}

	slog.InfoContext(ctx, "Found stale items", "count", len(staleItems))

	foundItems, missingIDs, err := s.gh.FetchItems(ctx, staleItems)
	if err != nil {
		gcErr = fmt.Errorf("failed to fetch items for GC: %w", err)
		return gcErr
	}
	processedCount = len(foundItems)

	slog.InfoContext(ctx, "GC results", "found", len(foundItems), "missing", len(missingIDs))

	if err := s.processItems(ctx, foundItems); err != nil {
		slog.ErrorContext(ctx, "Failed to save found items during GC", "error", err)
	}

	if len(missingIDs) > 0 {
		if gcErr = s.handleMissingStaleItems(ctx, missingIDs); gcErr != nil {
			return gcErr
		}
	}

	return nil
}

func (s *SyncEngine) handleMissingStaleItems(ctx context.Context, missingIDs []string) error {
	var toDelete []string
	var toSave []*octodeckv1.Item
	now := timestamppb.New(time.Now())
	for _, missingID := range missingIDs {
		existing, err := s.db.GetItem(ctx, missingID)
		if err == nil && existing != nil {
			loc := existing.GetLocal()
			if loc != nil && (loc.GetStarred() || loc.GetPrivateNotes() != "") {
				loc.SetSyncError("Item not found on GitHub (404/deleted)")
				existing.SetLastSyncedAt(now)
				toSave = append(toSave, existing)
				continue
			}
		}
		toDelete = append(toDelete, missingID)
	}
	if len(toSave) > 0 {
		if err := s.db.SaveItems(ctx, toSave); err != nil {
			slog.ErrorContext(ctx, "Failed to save protected items during GC", "error", err)
		}
	}
	if len(toDelete) > 0 {
		if err := s.db.DeleteItems(ctx, toDelete); err != nil {
			return fmt.Errorf("failed to delete missing items: %w", err)
		}
	}
	return nil
}

type traceParams struct {
	traceType            string
	triggerSource        string
	queryString          string
	reposEvaluated       []string
	since                time.Time
	startTime            time.Time
	pagesCount           int
	itemsFetched         int
	itemsPersisted       int
	syncErr              error
	rawPayloadCompressed []byte
}

func (s *SyncEngine) saveTrace(ctx context.Context, p traceParams) {
	if s.db == nil {
		return
	}

	saveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), dbSaveTimeout)
	defer cancel()

	var sinceStr string
	if !p.since.IsZero() {
		sinceStr = p.since.Format(time.RFC3339)
	}

	var reposJSON string
	if len(p.reposEvaluated) > 0 {
		if b, err := json.Marshal(p.reposEvaluated); err == nil {
			reposJSON = string(b)
		}
	}

	var errStr string
	if p.syncErr != nil {
		errStr = p.syncErr.Error()
	}

	duration := time.Since(p.startTime)
	trace := &database.SyncTrace{
		ID:                   fmt.Sprintf("%s-%d", p.traceType, time.Now().UnixNano()),
		TraceType:            p.traceType,
		TriggerSource:        p.triggerSource,
		QueryString:          p.queryString,
		ReposEvaluated:       reposJSON,
		SinceTimestamp:       sinceStr,
		DurationMs:           duration.Milliseconds(),
		PagesCount:           int64(p.pagesCount),
		ItemsFetched:         int64(p.itemsFetched),
		ItemsPersisted:       int64(p.itemsPersisted),
		ErrorMessage:         errStr,
		RawPayloadCompressed: p.rawPayloadCompressed,
		CreatedAt:            time.Now().UTC().Format(time.RFC3339),
	}

	if err := s.db.SaveSyncTrace(saveCtx, trace); err != nil {
		slog.WarnContext(saveCtx, "Failed to save sync trace", "error", err, "trace_type", p.traceType)
	}
}

func (s *SyncEngine) processItems(ctx context.Context, fetchedItems []*octodeckv1.Item) error {
	return s.processItemsDirect(ctx, fetchedItems, true)
}

func (s *SyncEngine) processItemsDirect(ctx context.Context, fetchedItems []*octodeckv1.Item, filterRepos bool) error {
	if len(fetchedItems) == 0 {
		return nil
	}

	if filterRepos {
		watched := s.cfg.GetWatchedRepos()
		excluded := s.cfg.GetExcludedRepos()
		if len(watched) > 0 || len(excluded) > 0 {
			fetchedItems = FilterItemsByRepo(fetchedItems, watched, excluded)
		}
	}

	if len(fetchedItems) == 0 {
		return nil
	}

	slog.InfoContext(ctx, "Processing fetched items", "count", len(fetchedItems))

	s.discoverBots(fetchedItems)

	var itemsToSave []*octodeckv1.Item
	now := time.Now()

	for _, item := range fetchedItems {
		item.SetLastSyncedAt(timestamppb.New(now))

		existing, err := s.db.GetItem(ctx, item.GetId())
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			slog.ErrorContext(ctx, "Failed to fetch existing item from DB", "id", item.GetId(), "error", err)
			continue // Skip this item to avoid data loss (overwriting local state)
		}
		isNew := errors.Is(err, sql.ErrNoRows)

		if !isNew {
			s.handleGapResolution(ctx, existing, item)
			item.SetReviews(mergeReviews(existing.GetReviews(), item.GetReviews()))
			item.SetStateEvents(mergeStateEvents(existing.GetStateEvents(), item.GetStateEvents()))
			// Merge existing local state
			item.SetLocal(existing.GetLocal())
			if item.GetLocal() != nil {
				item.GetLocal().ClearSyncError()
			}
		} else {
			// Initialize Local if new
			item.SetLocal((&octodeckv1.ItemLocalState_builder{}).Build())
		}

		s.calculateItemState(item)
		itemsToSave = append(itemsToSave, item)
	}

	if len(itemsToSave) > 0 {
		return s.db.SaveItems(ctx, itemsToSave)
	}
	return nil
}

func (s *SyncEngine) handleGapResolution(ctx context.Context, existing, item *octodeckv1.Item) {
	if detectGap(existing.GetComments(), item.GetComments()) {
		slog.InfoContext(ctx, "Comment gap detected, fetching missing history", "id", item.GetId())

		var maxID int64
		for _, c := range existing.GetComments() {
			if getCommentID(c) > maxID {
				maxID = getCommentID(c)
			}
		}

		missingComments, err := s.gh.FetchItemComments(ctx, item.GetId(), maxID)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to fetch missing comments for gap resolution",
				"id", item.GetId(), "error", err)
			// Fallback: merge what we have (best effort)
			item.SetComments(mergeComments(existing.GetComments(), item.GetComments()))
		} else {
			// Merge existing comments with missing backfilled comments and the newly fetched batch
			allComments := mergeComments(existing.GetComments(), missingComments)
			item.SetComments(mergeComments(allComments, item.GetComments()))
		}
	} else {
		// No gap, just merge (deduplicate)
		item.SetComments(mergeComments(existing.GetComments(), item.GetComments()))
	}
}

func (s *SyncEngine) calculateItemState(item *octodeckv1.Item) {
	// Auto-Ack
	if s.cfg.GetAutoAckOwnActivity() {
		statusRes := CalculateStatus(item, s.currentUser, s.cfg.GetKnownBots())
		if statusRes.Status != octodeckv1.ItemStatus_ITEM_STATUS_ACKED {
			if shouldAck, ackTime := ShouldAutoAck(item, s.currentUser, s.cfg.GetKnownBots()); shouldAck {
				slog.Info("Auto-acking item (last action was me)", "id", item.GetId(), "ackTime", ackTime)
				item.GetLocal().SetAckedAt(timestamppb.New(ackTime))
			}
		}
	}
}

func (s *SyncEngine) discoverBots(items []*octodeckv1.Item) {
	if s.cfg == nil {
		return
	}
	botsToAdd := extractBotsFromItems(items, s.cfg.GetKnownBots())
	if len(botsToAdd) > 0 {
		_, _, _ = s.cfg.AddKnownBots(botsToAdd...)
	}
}

func extractBotsFromItems(items []*octodeckv1.Item, known []string) []string {
	var bots []string
	addIfBot := func(u *octodeckv1.User) {
		if u != nil && (u.GetType() == octodeckv1.UserType_USER_TYPE_BOT || IsBot(u.GetLogin(), u.GetType(), known)) {
			bots = append(bots, u.GetLogin())
		}
	}
	for _, item := range items {
		if item == nil {
			continue
		}
		addIfBot(item.GetAuthor())
		extractItemChildBots(item, addIfBot)
	}
	return bots
}

func extractItemChildBots(item *octodeckv1.Item, addIfBot func(*octodeckv1.User)) {
	for _, c := range item.GetComments() {
		if c != nil {
			addIfBot(c.GetAuthor())
		}
	}
	for _, r := range item.GetReviews() {
		if r != nil {
			addIfBot(r.GetAuthor())
		}
	}
	for _, e := range item.GetStateEvents() {
		if e != nil {
			addIfBot(e.GetActor())
		}
	}
}

// getCommentID returns the numeric database ID from the Comment.
func getCommentID(c *octodeckv1.Comment) int64 {
	return c.GetCommentId()
}

// detectGap checks if there is an ID gap between existing comments and new comments.
// Returns true if a gap is detected.
func detectGap(existing []*octodeckv1.Comment, fetched []*octodeckv1.Comment) bool {
	// If we fetched fewer than 20 comments, we have the complete tail, so no gap is possible.
	if len(fetched) < gapThreshold {
		return false
	}
	if len(existing) == 0 {
		return false
	}

	// FetchInventory/FetchRepoUpdates returns the LAST 20 comments.
	// fetched[0] is the oldest of the new batch.
	// Find the newest ID in existing.
	var newestExistingID int64
	for _, c := range existing {
		if getCommentID(c) > newestExistingID {
			newestExistingID = getCommentID(c)
		}
	}

	oldestFetchedID := getCommentID(fetched[0])

	// If the oldest fetched comment ID is strictly greater than our newest existing ID,
	// we missed comments in between.
	return oldestFetchedID > newestExistingID
}

// mergeComments merges two lists of comments, updating existing comments with fetched data and adding new ones.
// It guarantees the output is sorted by ID.
func mergeComments(existing []*octodeckv1.Comment, fetched []*octodeckv1.Comment) []*octodeckv1.Comment {
	if len(existing) == 0 {
		return fetched
	}
	if len(fetched) == 0 {
		return existing
	}

	seen := make(map[int64]int)
	var merged []*octodeckv1.Comment

	for _, c := range existing {
		id := getCommentID(c)
		seen[id] = len(merged)
		merged = append(merged, c)
	}

	for _, c := range fetched {
		id := getCommentID(c)
		if idx, ok := seen[id]; ok {
			// Update in place for edited comments
			merged[idx] = c
		} else {
			seen[id] = len(merged)
			merged = append(merged, c)
		}
	}

	sort.Slice(merged, func(i, j int) bool {
		return getCommentID(merged[i]) < getCommentID(merged[j])
	})

	return merged
}

// mergeReviewComments merges two lists of review comments, updating existing comments
// in place and preserving older ones.
func mergeReviewComments(
	existing []*octodeckv1.ReviewComment,
	fetched []*octodeckv1.ReviewComment,
) []*octodeckv1.ReviewComment {
	if len(existing) == 0 {
		return fetched
	}
	if len(fetched) == 0 {
		return existing
	}

	seen := make(map[string]int)
	var merged []*octodeckv1.ReviewComment

	for _, c := range existing {
		key := c.GetId()
		if key == "" {
			key = c.GetUrl()
		}
		if key != "" {
			seen[key] = len(merged)
		}
		merged = append(merged, c)
	}

	for _, c := range fetched {
		key := c.GetId()
		if key == "" {
			key = c.GetUrl()
		}
		if idx, ok := seen[key]; ok && key != "" {
			// Update in place for edited review comment body
			merged[idx] = c
		} else {
			if key != "" {
				seen[key] = len(merged)
			}
			merged = append(merged, c)
		}
	}

	return merged
}

// mergeReviews merges two lists of reviews, removing duplicates based on URL or (author, submitted_at, state).
// It updates matching reviews and review comments with freshly fetched data and guarantees chronological sorting.
func mergeReviews(existing []*octodeckv1.Review, fetched []*octodeckv1.Review) []*octodeckv1.Review {
	if len(existing) == 0 {
		return fetched
	}
	if len(fetched) == 0 {
		return existing
	}

	reviewKey := func(r *octodeckv1.Review) string {
		if r.GetUrl() != "" {
			return r.GetUrl()
		}
		var sec int64
		if r.GetSubmittedAt() != nil {
			sec = r.GetSubmittedAt().GetSeconds()
		}
		return fmt.Sprintf("%s:%d:%s", r.GetAuthor().GetLogin(), sec, r.GetState())
	}

	seen := make(map[string]int)
	var merged []*octodeckv1.Review

	for _, r := range existing {
		k := reviewKey(r)
		seen[k] = len(merged)
		merged = append(merged, r)
	}

	for _, r := range fetched {
		k := reviewKey(r)
		if idx, ok := seen[k]; ok {
			// If existing review already has comments and fetched also has comments,
			// merge comments preserving older ones while updating edited ones.
			if len(merged[idx].GetComments()) > 0 && len(r.GetComments()) > 0 {
				r.SetComments(mergeReviewComments(merged[idx].GetComments(), r.GetComments()))
			}
			merged[idx] = r
		} else {
			seen[k] = len(merged)
			merged = append(merged, r)
		}
	}

	sort.Slice(merged, func(i, j int) bool {
		var tI, tJ int64
		if merged[i].GetSubmittedAt() != nil {
			tI = merged[i].GetSubmittedAt().GetSeconds()
		}
		if merged[j].GetSubmittedAt() != nil {
			tJ = merged[j].GetSubmittedAt().GetSeconds()
		}
		return tI < tJ
	})

	return merged
}

// mergeStateEvents merges state events from DB with newly fetched state events.
// It deduplicates by (type, actor, created_at) and guarantees chronological sorting.
func mergeStateEvents(existing []*octodeckv1.StateEvent, fetched []*octodeckv1.StateEvent) []*octodeckv1.StateEvent {
	if len(existing) == 0 {
		return fetched
	}
	if len(fetched) == 0 {
		return existing
	}

	eventKey := func(e *octodeckv1.StateEvent) string {
		var sec int64
		if e.GetCreatedAt() != nil {
			sec = e.GetCreatedAt().GetSeconds()
		}
		return fmt.Sprintf("%v:%s:%d", e.GetType(), e.GetActor().GetLogin(), sec)
	}

	seen := make(map[string]int)
	var merged []*octodeckv1.StateEvent

	for _, e := range existing {
		k := eventKey(e)
		seen[k] = len(merged)
		merged = append(merged, e)
	}

	for _, e := range fetched {
		k := eventKey(e)
		if idx, ok := seen[k]; ok {
			merged[idx] = e
		} else {
			seen[k] = len(merged)
			merged = append(merged, e)
		}
	}

	sort.Slice(merged, func(i, j int) bool {
		var tI, tJ int64
		if merged[i].GetCreatedAt() != nil {
			tI = merged[i].GetCreatedAt().GetSeconds()
		}
		if merged[j].GetCreatedAt() != nil {
			tJ = merged[j].GetCreatedAt().GetSeconds()
		}
		return tI < tJ
	})

	return merged
}
