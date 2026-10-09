package logic

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/github"
	"github.com/tallclair/octodeck/backend/internal/notify"
)

func newNotificationTestEngine(t *testing.T, cfg *octodeckv1.Config) (*SyncEngine, *notify.Subscription) {
	t.Helper()
	db := setupTestDB(t)
	t.Cleanup(func() { _ = db.Close() })
	b := notify.New(notify.Options{})
	t.Cleanup(b.Close)
	sub, _ := b.Subscribe(time.Time{})
	t.Cleanup(sub.Close)
	engine := &SyncEngine{
		db:    db,
		cfg:   config.NewForTest(cfg),
		gh:    &github.Client{CurrentUser: ackTestUser},
		clock: notifTestNow,
	}
	engine.SetBroadcaster(b)
	return engine, sub
}

// seedUnrelatedItem stores an unrelated item so that the database isn't empty (seeding an empty
// database never notifies).
func seedUnrelatedItem(t *testing.T, engine *SyncEngine) {
	t.Helper()
	item := ackTestItem(ackTestOther)
	item.SetId("I_seed")
	item.SetRepo("owner/other")
	require.NoError(t, engine.db.SaveItems(t.Context(), []*octodeckv1.Item{item}))
}

func notificationTestConfig() *octodeckv1.Config {
	settings := config.DefaultNotificationSettings()
	settings.SetOnlyAssignedOrAuthored(false)
	return octodeckv1.Config_builder{
		KnownBots:            ackTestBots(),
		NotificationSettings: settings,
	}.Build()
}

// syncItem returns a fresh copy of the item as GitHub would return it: without local state.
func syncItem(comments ...*octodeckv1.Comment) *octodeckv1.Item {
	item := ackTestItem(ackTestOther)
	item.SetId("I_1")
	item.SetRepo("owner/repo")
	item.SetNumber(1)
	item.SetTitle("A bug")
	item.ClearLocal()
	item.SetComments(comments)
	for _, c := range comments {
		touch(item, c.GetCreatedAt().AsTime())
	}
	return item
}

func syncComment(id int64, author string, at time.Time) *octodeckv1.Comment {
	c := ackTestComment(author, at)
	c.SetCommentId(id)
	return c
}

func drain(sub *notify.Subscription) []*octodeckv1.Notification {
	var out []*octodeckv1.Notification
	for _, st := range sub.TryReceive() {
		out = append(out, st.Notification)
	}
	return out
}

func TestProcessItems_PublishesNotificationsAfterSave(t *testing.T) {
	engine, sub := newNotificationTestEngine(t, notificationTestConfig())
	seedUnrelatedItem(t, engine)
	ctx := t.Context()

	// First sight of a never-viewed item: a new item notification.
	require.NoError(t, engine.processItemsDirect(ctx, []*octodeckv1.Item{syncItem()}, nil, false))
	got := drain(sub)
	require.Len(t, got, 1)
	assert.Equal(t, octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_NEW_ITEM, got[0].GetCategory())
	assert.Equal(t, "I_1", got[0].GetItemId())
	assert.Equal(t, "owner/repo #1", got[0].GetTitle())

	// Re-syncing the same content notifies nothing.
	require.NoError(t, engine.processItemsDirect(ctx, []*octodeckv1.Item{syncItem()}, nil, false))
	assert.Empty(t, drain(sub))

	// A new comment from someone else notifies, even though the item is still unread.
	c1 := syncComment(1, ackTestOther, ackTestTime(10))
	require.NoError(t, engine.processItemsDirect(ctx, []*octodeckv1.Item{syncItem(c1)}, nil, false))
	got = drain(sub)
	require.Len(t, got, 1)
	assert.Equal(t, octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_ACTIVITY, got[0].GetCategory())

	// The same comment again: nothing.
	require.NoError(t, engine.processItemsDirect(ctx, []*octodeckv1.Item{syncItem(c1)}, nil, false))
	assert.Empty(t, drain(sub))

	// The user's own reply: nothing.
	c2 := syncComment(2, ackTestUser, ackTestTime(20))
	require.NoError(t, engine.processItemsDirect(ctx, []*octodeckv1.Item{syncItem(c1, c2)}, nil, false))
	assert.Empty(t, drain(sub))

	// Saving invalidates the badge, so the badge loop recomputes it.
	recomputed := make(chan struct{}, 1)
	engine.broadcaster.StartBadge(func(context.Context) (*octodeckv1.BadgeUpdate, error) {
		select {
		case recomputed <- struct{}{}:
		default:
		}
		return octodeckv1.BadgeUpdate_builder{}.Build(), nil
	})
	<-recomputed // the initial computation
	require.NoError(t, engine.processItemsDirect(ctx, []*octodeckv1.Item{syncItem(c1, c2)}, nil, false))
	select {
	case <-recomputed:
	case <-time.After(5 * time.Second):
		assert.Fail(t, "expected the badge to be recomputed after a save")
	}
}

// TestProcessItems_EmptyDatabaseDoesNotNotify covers seeding after a failed startup inventory:
// whichever sync path first fills an empty database, that batch doesn't notify; later batches do.
func TestProcessItems_EmptyDatabaseDoesNotNotify(t *testing.T) {
	engine, sub := newNotificationTestEngine(t, notificationTestConfig())
	ctx := t.Context()

	require.NoError(t, engine.processItemsDirect(ctx, []*octodeckv1.Item{syncItem()}, nil, false))
	assert.Empty(t, drain(sub))
	stored, err := engine.db.GetItem(ctx, "I_1")
	require.NoError(t, err)
	assert.Equal(t, "I_1", stored.GetId(), "items are still saved")

	c1 := syncComment(1, ackTestOther, ackTestTime(10))
	require.NoError(t, engine.processItemsDirect(ctx, []*octodeckv1.Item{syncItem(c1)}, nil, false))
	got := drain(sub)
	require.Len(t, got, 1)
	assert.Equal(t, octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_ACTIVITY, got[0].GetCategory())
}

// TestProcessItems_ConcurrentReconciliationNotifiesOnce processes the same fetched item from
// several sync paths at once: reconciliation is serialized, so exactly one notification results.
func TestProcessItems_ConcurrentReconciliationNotifiesOnce(t *testing.T) {
	engine, sub := newNotificationTestEngine(t, notificationTestConfig())
	seedUnrelatedItem(t, engine)
	ctx := t.Context()
	require.NoError(t, engine.processItemsDirect(ctx, []*octodeckv1.Item{syncItem()}, nil, false))
	drain(sub)

	const workers = 4
	var wg sync.WaitGroup
	for range workers {
		wg.Go(func() {
			c1 := syncComment(1, ackTestOther, ackTestTime(10))
			assert.NoError(t, engine.processItemsDirect(ctx, []*octodeckv1.Item{syncItem(c1)}, nil, false))
		})
	}
	wg.Wait()
	assert.Len(t, drain(sub), 1)
}

func TestProcessItems_HiddenReposDoNotNotify(t *testing.T) {
	cfg := notificationTestConfig()
	cfg.SetExcludedRepos([]string{"owner/*"})
	engine, sub := newNotificationTestEngine(t, cfg)
	seedUnrelatedItem(t, engine)
	require.NoError(t, engine.processItemsDirect(t.Context(), []*octodeckv1.Item{syncItem()}, nil, false))
	assert.Empty(t, drain(sub))
}

func TestProcessItems_DisabledNotifications(t *testing.T) {
	cfg := notificationTestConfig()
	cfg.GetNotificationSettings().SetEnabled(false)
	engine, sub := newNotificationTestEngine(t, cfg)
	seedUnrelatedItem(t, engine)
	require.NoError(t, engine.processItemsDirect(t.Context(), []*octodeckv1.Item{syncItem()}, nil, false))
	assert.Empty(t, drain(sub))
}
