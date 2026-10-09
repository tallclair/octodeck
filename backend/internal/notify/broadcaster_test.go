package notify

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2024, 3, 1, 10, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func notification(id string) *octodeckv1.Notification {
	return octodeckv1.Notification_builder{Id: &id}.Build()
}

func ids(stamped []Stamped) []string {
	out := make([]string, 0, len(stamped))
	for _, st := range stamped {
		out = append(out, st.Notification.GetId())
	}
	return out
}

func receive(t *testing.T, sub *Subscription) []Stamped {
	t.Helper()
	select {
	case batch := <-sub.Notifications():
		return batch
	case <-time.After(time.Second):
		require.FailNow(t, "timed out waiting for notification")
		return nil
	}
}

func TestPublishFansOutToSubscribers(t *testing.T) {
	b := New(Options{})
	sub1, backlog1 := b.Subscribe(time.Time{})
	sub2, _ := b.Subscribe(time.Time{})
	defer sub1.Close()
	defer sub2.Close()
	assert.Empty(t, backlog1)

	b.Publish(notification("a"), nil, notification("b"))

	for _, sub := range []*Subscription{sub1, sub2} {
		batch := receive(t, sub)
		require.Equal(t, []string{"a", "b"}, ids(batch), "one publish is one batch")
		assert.True(t, batch[1].SentAt.After(batch[0].SentAt), "stamps must be strictly increasing")
	}
}

func TestBurstIsOneQueueEntry(t *testing.T) {
	b := New(Options{SubscriberBuffer: 1})
	sub, _ := b.Subscribe(time.Time{})
	defer sub.Close()

	burst := make([]*octodeckv1.Notification, 100)
	for i := range burst {
		burst[i] = notification("x")
	}
	b.Publish(burst...)

	assert.False(t, sub.Lagged(), "a burst larger than the buffer must not lag the subscriber")
	assert.Len(t, receive(t, sub), 100)
}

func TestStampsHaveNoMonotonicReading(t *testing.T) {
	b := New(Options{})
	sub, _ := b.Subscribe(time.Time{})
	defer sub.Close()

	b.Publish(notification("a"))
	st := receive(t, sub)[0]
	assert.Equal(t, st.SentAt.Round(0), st.SentAt)
	cursor, ok := sub.Cursor()
	require.True(t, ok)
	assert.Equal(t, cursor.Round(0), cursor)
}

func TestStampsStrictlyIncreaseWithFrozenClock(t *testing.T) {
	clock := newFakeClock()
	b := New(Options{Now: clock.Now})
	sub, _ := b.Subscribe(time.Time{})
	defer sub.Close()

	b.Publish(notification("a"))
	st := receive(t, sub)[0]
	cursor, ok := sub.Cursor()
	require.True(t, ok)
	assert.True(t, cursor.After(st.SentAt))

	b.Publish(notification("b"))
	assert.True(t, receive(t, sub)[0].SentAt.After(cursor), "notifications after a cursor are stamped after it")
}

func TestSubscribeReturnsBacklogAfterCursor(t *testing.T) {
	clock := newFakeClock()
	b := New(Options{Now: clock.Now})
	b.Publish(notification("a"))
	clock.Advance(time.Second)
	b.Publish(notification("b"))
	clock.Advance(time.Second)
	b.Publish(notification("c"))

	_, all := b.Subscribe(time.Unix(1, 0))
	require.Equal(t, []string{"a", "b", "c"}, ids(all))

	sub, backlog := b.Subscribe(all[0].SentAt)
	defer sub.Close()
	assert.Equal(t, []string{"b", "c"}, ids(backlog))

	_, none := b.Subscribe(time.Time{})
	assert.Empty(t, none, "a zero cursor means no catch-up")
}

func TestHistoryIsBoundedBySize(t *testing.T) {
	b := New(Options{HistorySize: 2})
	b.Publish(notification("a"), notification("b"), notification("c"))
	_, backlog := b.Subscribe(time.Unix(1, 0))
	assert.Equal(t, []string{"b", "c"}, ids(backlog))
}

func TestHistoryIsBoundedByAge(t *testing.T) {
	clock := newFakeClock()
	b := New(Options{HistoryAge: time.Hour, Now: clock.Now})
	b.Publish(notification("old"))
	clock.Advance(2 * time.Hour)
	b.Publish(notification("new"))
	_, backlog := b.Subscribe(time.Unix(1, 0))
	assert.Equal(t, []string{"new"}, ids(backlog))

	clock.Advance(2 * time.Hour)
	_, backlog = b.Subscribe(time.Unix(1, 0))
	assert.Empty(t, backlog, "expired entries are pruned on subscribe")
}

func TestSlowSubscriberIsTerminatedAsLagged(t *testing.T) {
	b := New(Options{SubscriberBuffer: 1})
	slow, _ := b.Subscribe(time.Time{})
	fast, _ := b.Subscribe(time.Time{})
	defer fast.Close()

	b.Publish(notification("a"))
	receive(t, fast)
	b.Publish(notification("b"))

	select {
	case <-slow.Done():
	default:
		require.FailNow(t, "slow subscriber should have been terminated")
	}
	assert.True(t, slow.Lagged())
	assert.Equal(t, "b", receive(t, fast)[0].Notification.GetId())
	assert.False(t, fast.Lagged())
}

func TestCursorUnavailableWhileNotificationsQueued(t *testing.T) {
	b := New(Options{})
	sub, _ := b.Subscribe(time.Time{})
	defer sub.Close()

	b.Publish(notification("a"))
	_, ok := sub.Cursor()
	assert.False(t, ok)

	receive(t, sub)
	_, ok = sub.Cursor()
	assert.True(t, ok)
}

func TestTryReceiveDrainsQueuedBatches(t *testing.T) {
	b := New(Options{})
	sub, _ := b.Subscribe(time.Time{})
	defer sub.Close()

	assert.Empty(t, sub.TryReceive())
	b.Publish(notification("a"))
	b.Publish(notification("b"), notification("c"))
	assert.Equal(t, []string{"a", "b", "c"}, ids(sub.TryReceive()))
	assert.Empty(t, sub.TryReceive())
}

func waitBadge(t *testing.T, sub *Subscription) *octodeckv1.BadgeUpdate {
	t.Helper()
	select {
	case <-sub.BadgeChanged():
		return sub.Badge()
	case <-time.After(5 * time.Second):
		require.FailNow(t, "timed out waiting for badge")
		return nil
	}
}

func badgeCount(n int32) *octodeckv1.BadgeUpdate {
	return octodeckv1.BadgeUpdate_builder{Count: &n}.Build()
}

func TestBadgeLoopComputesOncePerBurstAndFansOut(t *testing.T) {
	b := New(Options{BadgeDebounce: 50 * time.Millisecond})
	defer b.Close()
	sub1, _ := b.Subscribe(time.Time{})
	sub2, _ := b.Subscribe(time.Time{})
	defer sub1.Close()
	defer sub2.Close()

	var mu sync.Mutex
	calls := int32(0)
	b.StartBadge(func(context.Context) (*octodeckv1.BadgeUpdate, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		return badgeCount(calls), nil
	})
	assert.Equal(t, int32(1), waitBadge(t, sub1).GetCount(), "computed at start")
	assert.Equal(t, int32(1), waitBadge(t, sub2).GetCount())

	for range 10 {
		b.InvalidateBadge()
	}
	assert.Equal(t, int32(2), waitBadge(t, sub1).GetCount(), "a burst of invalidations is one computation")
	assert.Equal(t, int32(2), waitBadge(t, sub2).GetCount())
}

func TestBadgeLoopSignalsOnlyOnChange(t *testing.T) {
	b := New(Options{BadgeDebounce: time.Millisecond})
	defer b.Close()
	sub, _ := b.Subscribe(time.Time{})
	defer sub.Close()

	computed := make(chan struct{}, 10)
	b.StartBadge(func(context.Context) (*octodeckv1.BadgeUpdate, error) {
		computed <- struct{}{}
		return badgeCount(3), nil
	})
	waitBadge(t, sub)
	b.InvalidateBadge()
	<-computed
	<-computed
	select {
	case <-sub.BadgeChanged():
		require.FailNow(t, "an unchanged badge must not signal")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestBadgeLoopRetriesAfterFailure(t *testing.T) {
	b := New(Options{BadgeDebounce: time.Millisecond, BadgeRetry: 10 * time.Millisecond})
	defer b.Close()
	sub, _ := b.Subscribe(time.Time{})
	defer sub.Close()

	var mu sync.Mutex
	failures := 2
	b.StartBadge(func(context.Context) (*octodeckv1.BadgeUpdate, error) {
		mu.Lock()
		defer mu.Unlock()
		if failures > 0 {
			failures--
			return nil, errors.New("database is locked")
		}
		return badgeCount(7), nil
	})
	assert.Equal(t, int32(7), waitBadge(t, sub).GetCount(), "the badge is retried without a new invalidation")
}

func TestCloseTerminatesSubscriptions(t *testing.T) {
	b := New(Options{})
	sub, _ := b.Subscribe(time.Time{})
	b.Close()

	<-sub.Done()
	assert.False(t, sub.Lagged())
	sub.Close() // idempotent

	late, _ := b.Subscribe(time.Time{})
	<-late.Done()

	b.Publish(notification("a"))
	_, backlog := b.Subscribe(time.Unix(1, 0))
	assert.Empty(t, backlog, "publishing after close is dropped")
}

func TestSubscriptionCloseUnregisters(t *testing.T) {
	b := New(Options{SubscriberBuffer: 1})
	sub, _ := b.Subscribe(time.Time{})
	sub.Close()
	<-sub.Done()

	// Publishing more than the buffer must not mark the closed subscription as lagged.
	b.Publish(notification("a"), notification("b"))
	assert.False(t, sub.Lagged())
}

func TestNilBroadcasterIsSafe(t *testing.T) {
	var b *Broadcaster
	b.Publish(notification("a"))
	b.InvalidateBadge()
	b.StartBadge(nil)
	b.Close()
	sub, backlog := b.Subscribe(time.Unix(1, 0))
	assert.Empty(t, backlog)
	assert.Nil(t, sub.Badge())
	_, ok := sub.Cursor()
	assert.True(t, ok)
	assert.False(t, sub.Lagged())
	sub.Close()
}

func TestConcurrentPublishAndSubscribe(t *testing.T) {
	b := New(Options{SubscriberBuffer: 1000})
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			for range 50 {
				b.Publish(notification("x"))
				b.InvalidateBadge()
			}
		})
	}
	for range 4 {
		wg.Go(func() {
			sub, _ := b.Subscribe(time.Unix(1, 0))
			_, _ = sub.Cursor()
			sub.Close()
		})
	}
	wg.Wait()
	b.Close()
}
