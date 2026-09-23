package database

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

func setupTestDB(t *testing.T) *DB {
	t.Helper()

	db, err := Init(t.Context(), InMemoryDSN)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, db.Close()) })
	return db
}

func TestFilePersistence(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test.db")

	// 1. Init and save data
	db, err := Init(t.Context(), dbPath)
	require.NoError(t, err)

	item := octodeckv1.Item_builder{
		Id:        config.Ptr("persistent"),
		Repo:      config.Ptr("a/b"),
		UpdatedAt: timestamppb.Now(),
	}.Build()
	err = db.SaveItems(t.Context(), []*octodeckv1.Item{item})
	require.NoError(t, err)

	// Close DB
	err = db.Close()
	require.NoError(t, err)

	// 2. Re-open and verify
	db2, err := Init(t.Context(), dbPath)
	require.NoError(t, err)
	defer func() { require.NoError(t, db2.Close()) }()

	got, err := db2.GetItem(t.Context(), "persistent")
	require.NoError(t, err)
	assert.Equal(t, "persistent", got.GetId())
}

func TestSaveAndGetItems(t *testing.T) {
	db := setupTestDB(t)

	// Create test item
	now := time.Now().Truncate(time.Second)
	item := octodeckv1.Item_builder{
		Id:        config.Ptr("owner/repo#1"),
		Repo:      config.Ptr("owner/repo"),
		Number:    config.Ptr(int32(1)),
		Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:     config.Ptr("Test PR"),
		State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		UpdatedAt: timestamppb.New(now),
		Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
		Local: octodeckv1.ItemLocalState_builder{
			ComputedStatus: config.Ptr(octodeckv1.ItemStatus_ITEM_STATUS_NEW),
		}.Build(),
	}.Build()

	// Save item
	err := db.SaveItems(t.Context(), []*octodeckv1.Item{item})
	require.NoError(t, err, "SaveItems failed")

	// Get items
	items, err := db.GetItems(t.Context(), nil)
	require.NoError(t, err, "GetItems failed")

	require.Len(t, items, 1, "Expected 1 item")

	got := items[0]
	assert.Equal(t, item.GetId(), got.GetId(), "ID mismatch")
	assert.Equal(t, item.GetTitle(), got.GetTitle(), "Title mismatch")
	// Protobuf timestamp comparison handles nil checks and seconds/nanos
	assert.True(t, got.GetUpdatedAt().AsTime().Equal(item.GetUpdatedAt().AsTime()), "UpdatedAt mismatch")
	assert.Equal(t, item.GetLocal().GetComputedStatus(), got.GetLocal().GetComputedStatus(), "ComputedStatus mismatch")

	// Test Update (Upsert)
	item.SetTitle("Updated Title")
	item.GetLocal().SetComputedStatus(octodeckv1.ItemStatus_ITEM_STATUS_IDLE)
	item.GetLocal().SetAckedAt(timestamppb.New(time.Now()))
	item.GetLocal().SetPrivateNotes("note")

	// Save item again
	err = db.SaveItems(t.Context(), []*octodeckv1.Item{item})
	require.NoError(t, err, "SaveItems (update) failed")

	items, err = db.GetItems(t.Context(), nil)
	require.NoError(t, err, "GetItems failed")
	got = items[0]

	assert.Equal(t, "Updated Title", got.GetTitle(), "Expected updated title")
	assert.Equal(t,
		octodeckv1.ItemStatus_ITEM_STATUS_IDLE,
		got.GetLocal().GetComputedStatus(),
		"Expected updated status",
	)
	assert.Equal(t, "note", got.GetLocal().GetPrivateNotes(), "Expected private notes")
	assert.NotNil(t, got.GetLocal().GetAckedAt(), "Expected acked_at not nil")
}

func TestGetStaleItems(t *testing.T) {
	db := setupTestDB(t)

	staleTime := time.Now().Add(-31 * 24 * time.Hour)
	freshTime := time.Now()

	staleItem := octodeckv1.Item_builder{
		Id:           config.Ptr("owner/repo#1"),
		Repo:         config.Ptr("owner/repo"),
		State:        config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		LastSyncedAt: timestamppb.New(staleTime),
		UpdatedAt:    timestamppb.New(staleTime), // Needs to be set for constraints
	}.Build()
	freshItem := octodeckv1.Item_builder{
		Id:           config.Ptr("owner/repo#2"),
		Repo:         config.Ptr("owner/repo"),
		State:        config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		LastSyncedAt: timestamppb.New(freshTime),
		UpdatedAt:    timestamppb.New(freshTime),
	}.Build()
	closedStaleItem := octodeckv1.Item_builder{
		Id:           config.Ptr("owner/repo#3"),
		Repo:         config.Ptr("owner/repo"),
		State:        config.Ptr(octodeckv1.ItemState_ITEM_STATE_CLOSED),
		LastSyncedAt: timestamppb.New(staleTime),
		UpdatedAt:    timestamppb.New(staleTime),
	}.Build()

	err := db.SaveItems(t.Context(), []*octodeckv1.Item{staleItem, freshItem, closedStaleItem})
	require.NoError(t, err, "SaveItems failed")

	cutoff := time.Now().Add(-30 * 24 * time.Hour)
	staleItems, err := db.GetStaleItems(t.Context(), cutoff)
	require.NoError(t, err, "GetStaleItems failed")

	require.Len(t, staleItems, 1)
	assert.Equal(t, staleItem.GetId(), staleItems[0].GetId())
}

func TestPruneOldItems(t *testing.T) {
	db := setupTestDB(t)

	now := time.Now()
	oldTime := now.Add(-91 * 24 * time.Hour)
	recentTime := now.Add(-30 * 24 * time.Hour)

	items := []*octodeckv1.Item{
		octodeckv1.Item_builder{
			Id:        config.Ptr("keep/open-old"),
			Repo:      config.Ptr("repo"),
			State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			UpdatedAt: timestamppb.New(oldTime),
		}.Build(),
		octodeckv1.Item_builder{
			Id:        config.Ptr("prune/closed-old"),
			Repo:      config.Ptr("repo"),
			State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_CLOSED),
			UpdatedAt: timestamppb.New(oldTime),
		}.Build(),
		octodeckv1.Item_builder{
			Id:        config.Ptr("prune/merged-old"),
			Repo:      config.Ptr("repo"),
			State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_MERGED),
			UpdatedAt: timestamppb.New(oldTime),
		}.Build(),
		octodeckv1.Item_builder{
			Id:        config.Ptr("keep/closed-recent"),
			Repo:      config.Ptr("repo"),
			State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_CLOSED),
			UpdatedAt: timestamppb.New(recentTime),
		}.Build(),
	}

	err := db.SaveItems(t.Context(), items)
	require.NoError(t, err)

	cutoff := time.Now().Add(-90 * 24 * time.Hour)
	count, err := db.PruneOldItems(t.Context(), cutoff)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)

	remaining, err := db.GetItems(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, remaining, 2)

	ids := make(map[string]bool)
	for _, item := range remaining {
		ids[item.GetId()] = true
	}

	assert.True(t, ids["keep/open-old"])
	assert.True(t, ids["keep/closed-recent"])
}

func TestDeleteItems(t *testing.T) {
	db := setupTestDB(t)

	// Seed items
	items := []*octodeckv1.Item{
		octodeckv1.Item_builder{
			Id:        config.Ptr("1"),
			Repo:      config.Ptr("a/b"),
			Number:    config.Ptr(int32(1)),
			UpdatedAt: timestamppb.Now(),
		}.Build(),
		octodeckv1.Item_builder{
			Id:        config.Ptr("2"),
			Repo:      config.Ptr("a/b"),
			Number:    config.Ptr(int32(2)),
			UpdatedAt: timestamppb.Now(),
		}.Build(),
	}
	err := db.SaveItems(t.Context(), items)
	require.NoError(t, err)

	// Delete one
	err = db.DeleteItems(t.Context(), []string{"1"})
	require.NoError(t, err)

	// Verify
	remaining, err := db.GetItems(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, remaining, 1)
	assert.Equal(t, "2", remaining[0].GetId())
}

func TestGetItem(t *testing.T) {
	db := setupTestDB(t)

	item := octodeckv1.Item_builder{
		Id:        config.Ptr("1"),
		Repo:      config.Ptr("a/b"),
		Number:    config.Ptr(int32(1)),
		Title:     config.Ptr("Test"),
		UpdatedAt: timestamppb.Now(),
	}.Build()
	err := db.SaveItems(t.Context(), []*octodeckv1.Item{item})
	require.NoError(t, err)

	// Get existing by primary key
	got, err := db.GetItem(t.Context(), "1")
	require.NoError(t, err)
	assert.Equal(t, "Test", got.GetTitle())

	// Get existing by repo#number reference
	gotByRef, err := db.GetItem(t.Context(), "a/b#1")
	require.NoError(t, err)
	assert.Equal(t, "Test", gotByRef.GetTitle())
	assert.Equal(t, "1", gotByRef.GetId())

	// Update by repo#number reference
	updated, err := db.UpdateItem(t.Context(), "a/b#1", func(i *octodeckv1.Item) error {
		i.SetTitle("Updated Title")
		return nil
	})
	require.NoError(t, err)
	assert.Equal(t, "Updated Title", updated.GetTitle())

	// Verify persistence
	reloaded, err := db.GetItem(t.Context(), "1")
	require.NoError(t, err)
	assert.Equal(t, "Updated Title", reloaded.GetTitle())

	// Get non-existent
	_, err = db.GetItem(t.Context(), "999")
	require.Error(t, err)
	_, err = db.GetItem(t.Context(), "a/b#999")
	require.Error(t, err)
}

func TestMetadata(t *testing.T) {
	db := setupTestDB(t)

	// Get empty (should error with sql.ErrNoRows or similar)
	_, err := db.GetMetadata(t.Context(), "key")
	require.Error(t, err)

	// Set
	err = db.SetMetadata(t.Context(), "key", "value")
	require.NoError(t, err)

	// Get populated
	val, err := db.GetMetadata(t.Context(), "key")
	require.NoError(t, err)
	assert.Equal(t, "value", val)

	// Update
	err = db.SetMetadata(t.Context(), "key", "value2")
	require.NoError(t, err)

	val, err = db.GetMetadata(t.Context(), "key")
	require.NoError(t, err)
	assert.Equal(t, "value2", val)
}

func TestIsPopulated(t *testing.T) {
	db := setupTestDB(t)

	// Initially empty
	populated, err := db.IsPopulated(t.Context())
	require.NoError(t, err)
	assert.False(t, populated)

	// Add item
	item := octodeckv1.Item_builder{
		Id:        config.Ptr("1"),
		Repo:      config.Ptr("a/b"),
		Number:    config.Ptr(int32(1)),
		UpdatedAt: timestamppb.Now(),
	}.Build()
	err = db.SaveItems(t.Context(), []*octodeckv1.Item{item})
	require.NoError(t, err)

	// Now populated
	populated, err = db.IsPopulated(t.Context())
	require.NoError(t, err)
	assert.True(t, populated)
}

func TestGetDistinctRepos(t *testing.T) {
	db := setupTestDB(t)

	// Initially empty
	repos, err := db.GetDistinctRepos(t.Context())
	require.NoError(t, err)
	assert.Empty(t, repos)

	// Insert items with multiple repos and duplicates
	items := []*octodeckv1.Item{
		octodeckv1.Item_builder{
			Id:        config.Ptr("1"),
			Repo:      config.Ptr("kubernetes/kubernetes"),
			UpdatedAt: timestamppb.Now(),
		}.Build(),
		octodeckv1.Item_builder{
			Id:        config.Ptr("2"),
			Repo:      config.Ptr("kubernetes/enhancements"),
			UpdatedAt: timestamppb.Now(),
		}.Build(),
		octodeckv1.Item_builder{
			Id:        config.Ptr("3"),
			Repo:      config.Ptr("kubernetes/kubernetes"),
			UpdatedAt: timestamppb.Now(),
		}.Build(),
	}
	require.NoError(t, db.SaveItems(t.Context(), items))

	repos, err = db.GetDistinctRepos(t.Context())
	require.NoError(t, err)
	assert.Equal(t, []string{"kubernetes/enhancements", "kubernetes/kubernetes"}, repos)
}

func TestGetItems_Filters(t *testing.T) {
	db := setupTestDB(t)

	items := []*octodeckv1.Item{
		octodeckv1.Item_builder{Id: config.Ptr("1"), Repo: config.Ptr("a/b"), UpdatedAt: timestamppb.Now()}.Build(),
		octodeckv1.Item_builder{Id: config.Ptr("2"), Repo: config.Ptr("c/d"), UpdatedAt: timestamppb.Now()}.Build(),
	}
	err := db.SaveItems(t.Context(), items)
	require.NoError(t, err)

	// No filter
	got, err := db.GetItems(t.Context(), nil)
	require.NoError(t, err)
	assert.Len(t, got, 2)

	// Test with empty filter
	got, err = db.GetItems(t.Context(), &octodeckv1.Filter{})
	require.NoError(t, err)
	assert.Len(t, got, 2)
}

func TestMigrationDownAndUp(t *testing.T) {
	db := setupTestDB(t)
	ctx := t.Context()

	// Verify Down migration drops tables cleanly
	err := goose.DownContext(ctx, db.DB.DB, "migrations")
	require.NoError(t, err)

	// Verify Up migration recreates tables cleanly
	err = goose.UpContext(ctx, db.DB.DB, "migrations")
	require.NoError(t, err)

	// Verify we can perform standard database operations after migration
	item := octodeckv1.Item_builder{
		Id:        config.Ptr("test/pr1"),
		Repo:      config.Ptr("test/repo"),
		UpdatedAt: timestamppb.Now(),
	}.Build()
	err = db.SaveItems(ctx, []*octodeckv1.Item{item})
	require.NoError(t, err)
}

func TestNotificationStats(t *testing.T) {
	db := setupTestDB(t)
	ctx := t.Context()
	now := time.Now()

	// 1. Initially 0
	r24h, r7d, r30d, err := db.GetNotificationRates(ctx, now)
	require.NoError(t, err)
	assert.InDelta(t, 0.0, r24h, 0.0001)
	assert.InDelta(t, 0.0, r7d, 0.0001)
	assert.InDelta(t, 0.0, r30d, 0.0001)

	// 2. Record notifications in current hour
	err = db.RecordNotificationCount(ctx, now, 24)
	require.NoError(t, err)
	err = db.RecordNotificationCount(ctx, now, 24)
	require.NoError(t, err)

	// Record in past 2 days
	err = db.RecordNotificationCount(ctx, now.Add(-48*time.Hour), 100)
	require.NoError(t, err)

	// Record in past 40 days (old)
	err = db.RecordNotificationCount(ctx, now.Add(-40*24*time.Hour), 500)
	require.NoError(t, err)

	r24h, r7d, r30d, err = db.GetNotificationRates(ctx, now)
	require.NoError(t, err)
	assert.InDelta(t, float64(48)/24.0, r24h, 0.0001) // 2.0 / hr
	assert.InDelta(t, float64(148)/(7.0*24.0), r7d, 0.0001)
	assert.InDelta(t, float64(148)/(30.0*24.0), r30d, 0.0001)

	// 3. Prune old stats
	pruned, err := db.PruneOldNotificationStats(ctx, now.Add(-35*24*time.Hour))
	require.NoError(t, err)
	assert.Equal(t, int64(1), pruned)
}

func TestGetDatabaseStats(t *testing.T) {
	db := setupTestDB(t)
	ctx := t.Context()

	// Save mixed items
	items := []*octodeckv1.Item{
		octodeckv1.Item_builder{
			Id:        config.Ptr("org/repo1#1"),
			Repo:      config.Ptr("org/repo1"),
			Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
			State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			UpdatedAt: timestamppb.Now(),
		}.Build(),
		octodeckv1.Item_builder{
			Id:        config.Ptr("org/repo1#2"),
			Repo:      config.Ptr("org/repo1"),
			Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
			State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_CLOSED),
			UpdatedAt: timestamppb.Now(),
			Local: octodeckv1.ItemLocalState_builder{
				AckedAt: timestamppb.Now(),
			}.Build(),
		}.Build(),
		octodeckv1.Item_builder{
			Id:        config.Ptr("org/repo2#1"),
			Repo:      config.Ptr("org/repo2"),
			Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
			State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			UpdatedAt: timestamppb.Now(),
		}.Build(),
	}

	err := db.SaveItems(ctx, items)
	require.NoError(t, err)

	stats, err := db.GetDatabaseStats(ctx, InMemoryDSN)
	require.NoError(t, err)
	assert.Equal(t, int64(3), stats.GetTotalItems())
	assert.Equal(t, int64(2), stats.GetOpenItems())
	assert.Equal(t, int64(1), stats.GetClosedItems())
	assert.Equal(t, int64(2), stats.GetPrItems())
	assert.Equal(t, int64(1), stats.GetIssueItems())
	assert.Equal(t, int64(2), stats.GetUnackedItems())
	assert.Equal(t, int64(1), stats.GetAckedItems())
	assert.Equal(t, int64(2), stats.GetTotalRepos())
}

func TestGetAllItemIDs(t *testing.T) {
	db := setupTestDB(t)
	ctx := t.Context()

	// 1. Verify empty database returns empty map
	ids, err := db.GetAllItemIDs(ctx)
	require.NoError(t, err)
	assert.NotNil(t, ids)
	assert.Empty(t, ids)

	// 2. Insert items and verify IDs
	items := []*octodeckv1.Item{
		octodeckv1.Item_builder{
			Id:        config.Ptr("item_node_1"),
			Repo:      config.Ptr("org/repo1"),
			UpdatedAt: timestamppb.Now(),
		}.Build(),
		octodeckv1.Item_builder{
			Id:        config.Ptr("item_node_2"),
			Repo:      config.Ptr("org/repo2"),
			UpdatedAt: timestamppb.Now(),
		}.Build(),
		octodeckv1.Item_builder{
			Id:        config.Ptr("item_node_3"),
			Repo:      config.Ptr("org/repo1"),
			UpdatedAt: timestamppb.Now(),
		}.Build(),
	}
	err = db.SaveItems(ctx, items)
	require.NoError(t, err)

	ids, err = db.GetAllItemIDs(ctx)
	require.NoError(t, err)
	assert.Len(t, ids, 3)
	assert.Contains(t, ids, "item_node_1")
	assert.Contains(t, ids, "item_node_2")
	assert.Contains(t, ids, "item_node_3")

	// 3. Upsert an existing item - set size should remain 3
	updatedItem := octodeckv1.Item_builder{
		Id:        config.Ptr("item_node_2"),
		Repo:      config.Ptr("org/repo2"),
		Title:     config.Ptr("Updated title"),
		UpdatedAt: timestamppb.Now(),
	}.Build()
	err = db.SaveItems(ctx, []*octodeckv1.Item{updatedItem})
	require.NoError(t, err)

	ids, err = db.GetAllItemIDs(ctx)
	require.NoError(t, err)
	assert.Len(t, ids, 3)

	// 4. Delete an item and verify it is removed from the set
	err = db.DeleteItems(ctx, []string{"item_node_2"})
	require.NoError(t, err)

	ids, err = db.GetAllItemIDs(ctx)
	require.NoError(t, err)
	assert.Len(t, ids, 2)
	assert.Contains(t, ids, "item_node_1")
	assert.NotContains(t, ids, "item_node_2")
	assert.Contains(t, ids, "item_node_3")

	// 5. Context cancellation returns error
	canceledCtx, cancel := context.WithCancel(ctx)
	cancel()
	_, err = db.GetAllItemIDs(canceledCtx)
	require.Error(t, err)
}

func verifyReaderOperation(ctx context.Context, db *DB, op, numItems int) error {
	if op%2 == 0 {
		ids, err := db.GetAllItemIDs(ctx)
		if err != nil {
			return fmt.Errorf("GetAllItemIDs failed: %w", err)
		}
		if len(ids) < numItems {
			return fmt.Errorf("expected at least %d IDs, got %d", numItems, len(ids))
		}
		return nil
	}

	all, err := db.GetItems(ctx, nil)
	if err != nil {
		return fmt.Errorf("GetItems failed: %w", err)
	}
	if len(all) < numItems {
		return fmt.Errorf("expected at least %d items, got %d", numItems, len(all))
	}
	return nil
}

func runConcurrentReader(
	ctx context.Context,
	start <-chan struct{},
	workerID, opsPerWorker, numItems int,
	db *DB,
	recordError func(error),
	wg *sync.WaitGroup,
) {
	defer wg.Done()
	<-start

	for op := range opsPerWorker {
		if err := verifyReaderOperation(ctx, db, op, numItems); err != nil {
			recordError(fmt.Errorf("reader %d op %d: %w", workerID, op, err))
			return
		}
	}
}

func runConcurrentWriter(
	ctx context.Context,
	start <-chan struct{},
	workerID, opsPerWorker, numItems int,
	db *DB,
	recordError func(error),
	wg *sync.WaitGroup,
) {
	defer wg.Done()
	<-start

	for op := range opsPerWorker {
		targetID := fmt.Sprintf("owner/repo#%d", (op%numItems)+1)
		title := fmt.Sprintf("PR updated by writer %d op %d", workerID, op)
		_, err := db.UpdateItem(ctx, targetID, func(i *octodeckv1.Item) error {
			i.SetTitle(title)
			return nil
		})
		if err != nil {
			recordError(fmt.Errorf("writer %d UpdateItem failed: %w", workerID, err))
			return
		}
	}
}

func TestConcurrentQueries_InMemory(t *testing.T) {
	db := setupTestDB(t)
	ctx := t.Context()

	// 1. Seed initial items
	const numItems = 10
	items := make([]*octodeckv1.Item, numItems)
	for i := range numItems {
		id := fmt.Sprintf("owner/repo#%d", i+1)
		items[i] = octodeckv1.Item_builder{
			Id:                 config.Ptr(id),
			Repo:               config.Ptr("owner/repo"),
			Number:             config.Ptr(int32(i + 1)),
			Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
			Title:              config.Ptr(fmt.Sprintf("PR #%d", i+1)),
			State:              config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			ViewerSubscription: config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED),
			UpdatedAt:          timestamppb.Now(),
		}.Build()
	}
	require.NoError(t, db.SaveItems(ctx, items))

	// 2. Launch concurrent reader and writer goroutines
	const (
		numReaders   = 15
		numWriters   = 5
		opsPerWorker = 50
	)

	var (
		wg      sync.WaitGroup
		start   = make(chan struct{})
		errMu   sync.Mutex
		errList []error
	)

	recordError := func(err error) {
		if err != nil {
			errMu.Lock()
			errList = append(errList, err)
			errMu.Unlock()
		}
	}

	for r := range numReaders {
		wg.Add(1)
		go runConcurrentReader(ctx, start, r, opsPerWorker, numItems, db, recordError, &wg)
	}

	for w := range numWriters {
		wg.Add(1)
		go runConcurrentWriter(ctx, start, w, opsPerWorker, numItems, db, recordError, &wg)
	}

	// Burst start all workers simultaneously
	close(start)
	wg.Wait()

	// 3. Verify zero errors occurred and specifically no "no such table: items"
	const connMsg = "in-memory SQLite connection pool must not open unmigrated secondary connections"
	for _, err := range errList {
		assert.NotContains(t, err.Error(), "no such table: items", connMsg)
	}
	require.Empty(t, errList, "all concurrent queries and updates must succeed with zero errors")

	// 4. Verify database consistency after concurrency storm
	finalIDs, err := db.GetAllItemIDs(ctx)
	require.NoError(t, err)
	assert.Len(t, finalIDs, numItems)
}

func TestGetAllItemIDs_Concurrent(t *testing.T) {
	db := setupTestDB(t)
	ctx := t.Context()

	const numItems = 20
	items := make([]*octodeckv1.Item, numItems)
	for i := range numItems {
		items[i] = octodeckv1.Item_builder{
			Id:        config.Ptr(fmt.Sprintf("item_concurrent_%d", i)),
			Repo:      config.Ptr("org/repo"),
			UpdatedAt: timestamppb.Now(),
		}.Build()
	}
	require.NoError(t, db.SaveItems(ctx, items))

	const (
		numGoroutines = 25
		iterations    = 40
	)

	var (
		wg      sync.WaitGroup
		start   = make(chan struct{})
		errMu   sync.Mutex
		errList []error
	)

	for g := range numGoroutines {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			<-start
			for i := range iterations {
				ids, err := db.GetAllItemIDs(ctx)
				if err != nil {
					errMu.Lock()
					errList = append(errList, fmt.Errorf("goroutine %d iter %d: %w", id, i, err))
					errMu.Unlock()
					return
				}
				if len(ids) != numItems {
					errMu.Lock()
					errList = append(errList, fmt.Errorf(
						"goroutine %d iter %d: expected %d items, got %d",
						id, i, numItems, len(ids),
					))
					errMu.Unlock()
					return
				}
			}
		}(g)
	}

	close(start)
	wg.Wait()

	require.Empty(t, errList, "concurrent GetAllItemIDs calls on in-memory DB should not fail")
}

func TestDiscoveryCursorCRUD(t *testing.T) {
	ctx := t.Context()
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	const (
		q1 = "repo:k8s/k8s is:open label:sig/node"
		q2 = "repo:k8s/k8s is:open label:sig/api-machinery"
		q3 = "repo:octodeck/octodeck is:pr"
	)

	// 1. Initial check: non-existent cursor
	t0, exists, err := db.GetDiscoveryCursor(ctx, q1)
	require.NoError(t, err)
	assert.False(t, exists)
	assert.True(t, t0.IsZero())

	// 2. Set cursor
	now := time.Now().UTC().Truncate(time.Second)
	err = db.SetDiscoveryCursor(ctx, q1, now)
	require.NoError(t, err)

	t1, exists, err := db.GetDiscoveryCursor(ctx, q1)
	require.NoError(t, err)
	assert.True(t, exists)
	assert.Equal(t, now, t1.UTC())

	// 3. Update cursor
	later := now.Add(10 * time.Minute)
	err = db.SetDiscoveryCursor(ctx, q1, later)
	require.NoError(t, err)

	t2, exists, err := db.GetDiscoveryCursor(ctx, q1)
	require.NoError(t, err)
	assert.True(t, exists)
	assert.Equal(t, later, t2.UTC())

	// 4. Set cursor for q2 and q3
	require.NoError(t, db.SetDiscoveryCursor(ctx, q2, now))
	require.NoError(t, db.SetDiscoveryCursor(ctx, q3, now))

	// 5. Delete cursor for q3
	err = db.DeleteDiscoveryCursor(ctx, q3)
	require.NoError(t, err)
	_, exists, err = db.GetDiscoveryCursor(ctx, q3)
	require.NoError(t, err)
	assert.False(t, exists)

	// 6. Prune: keep only q1; q2 should be pruned
	err = db.PruneDiscoveryCursors(ctx, []string{q1})
	require.NoError(t, err)

	_, exists1, err := db.GetDiscoveryCursor(ctx, q1)
	require.NoError(t, err)
	assert.True(t, exists1)

	_, exists2, err := db.GetDiscoveryCursor(ctx, q2)
	require.NoError(t, err)
	assert.False(t, exists2)
}

func TestDiscoveryQueryStats(t *testing.T) {
	ctx := t.Context()
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	const q = "repo:kubernetes/kubernetes is:open label:sig/node"
	now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)

	// 1. Brand new query (< 1 day elapsed): denominator clamped to 1.0 day
	addedSub1d := now.Add(-6 * time.Hour)
	require.NoError(t, db.EnsureDiscoveryAddedAt(ctx, q, addedSub1d))
	require.NoError(t, db.RecordDiscoveryQueryCount(ctx, q, now.Add(-2*time.Hour), 4))

	avg7d, avg30d, err := db.GetDiscoveryQueryStats(ctx, q, now)
	require.NoError(t, err)
	assert.InDelta(t, 4.0, avg7d, 0.01)
	assert.InDelta(t, 4.0, avg30d, 0.01)

	// 2. Query tracked for 3.5 days: both 7d and 30d windows use 3.5 days
	const q35d = "repo:kubernetes/kubernetes is:open label:sig/auth"
	added35d := now.Add(-84 * time.Hour) // 3.5 days
	require.NoError(t, db.EnsureDiscoveryAddedAt(ctx, q35d, added35d))
	require.NoError(t, db.RecordDiscoveryQueryCount(ctx, q35d, now.Add(-48*time.Hour), 7))
	require.NoError(t, db.RecordDiscoveryQueryCount(ctx, q35d, now.Add(-12*time.Hour), 7))

	avg7d, avg30d, err = db.GetDiscoveryQueryStats(ctx, q35d, now)
	require.NoError(t, err)
	assert.InDelta(t, 4.0, avg7d, 0.01)  // 14 / 3.5 = 4.0
	assert.InDelta(t, 4.0, avg30d, 0.01) // 14 / 3.5 = 4.0

	// 3. Query tracked for 45 days: 7d window uses 7.0 days, 30d window uses 30.0 days
	const q45d = "org:kubernetes is:issue label:security"
	added45d := now.Add(-45 * 24 * time.Hour)
	require.NoError(t, db.EnsureDiscoveryAddedAt(ctx, q45d, added45d))
	// 14 items in last 7 days (avg 2.0/day)
	require.NoError(t, db.RecordDiscoveryQueryCount(ctx, q45d, now.Add(-3*24*time.Hour), 14))
	// 46 more items 15 days ago (total 60 in last 30 days -> avg 2.0/day)
	require.NoError(t, db.RecordDiscoveryQueryCount(ctx, q45d, now.Add(-15*24*time.Hour), 46))
	// 100 items 40 days ago (outside 30d window, should be ignored)
	require.NoError(t, db.RecordDiscoveryQueryCount(ctx, q45d, now.Add(-40*24*time.Hour), 100))

	avg7d, avg30d, err = db.GetDiscoveryQueryStats(ctx, q45d, now)
	require.NoError(t, err)
	assert.InDelta(t, 2.0, avg7d, 0.01)
	assert.InDelta(t, 2.0, avg30d, 0.01)

	// 4. Pruning removes stats and added_at for inactive queries
	require.NoError(t, db.PruneDiscoveryCursors(ctx, []string{q45d}))
	avg7dPruned, avg30dPruned, err := db.GetDiscoveryQueryStats(ctx, q35d, now)
	require.NoError(t, err)
	assert.InDelta(t, 0.0, avg7dPruned, 0.001)
	assert.InDelta(t, 0.0, avg30dPruned, 0.001)
}
