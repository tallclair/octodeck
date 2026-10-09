// Package notify fans out desktop notifications decided by the sync engine to connected clients
// and keeps a bounded in-memory history of them so that reconnecting clients can catch up. It also
// maintains the toolbar badge, recomputed once per change and shared by every client.
//
// Nothing here is persisted: after a daemon restart the history is empty and there is nothing to
// catch up on.
package notify

import (
	"sync"
	"time"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

const (
	// DefaultHistorySize caps how many notifications are retained for catch-up.
	DefaultHistorySize = 500
	// DefaultHistoryAge caps how long notifications are retained for catch-up.
	DefaultHistoryAge = 24 * time.Hour
	// DefaultSubscriberBuffer is how many published batches may be queued for a subscriber that
	// isn't reading. A subscriber that falls further behind is terminated as lagged; it
	// reconnects and catches up from the history instead.
	DefaultSubscriberBuffer = 64
	// DefaultBadgeDebounce is how long badge invalidations are coalesced before the badge is
	// recomputed.
	DefaultBadgeDebounce = 250 * time.Millisecond
	// DefaultBadgeRetry is how long to wait before recomputing the badge after a failure.
	DefaultBadgeRetry = 5 * time.Second
)

// Stamped is a notification together with the daemon-clock time it was published. Stamps are
// strictly increasing across a Broadcaster, so they double as resume cursors.
type Stamped struct {
	Notification *octodeckv1.Notification
	SentAt       time.Time
}

// Options configures a Broadcaster. Zero values take the defaults.
type Options struct {
	HistorySize      int
	HistoryAge       time.Duration
	SubscriberBuffer int
	BadgeDebounce    time.Duration
	BadgeRetry       time.Duration
	// Now returns the current time (for tests).
	Now func() time.Time
}

// Broadcaster publishes notifications to subscribers. All methods are safe for concurrent use and
// for use on a nil *Broadcaster (which drops everything), so components that don't wire one up
// keep working.
type Broadcaster struct {
	mu        sync.Mutex
	opts      Options
	history   []Stamped // oldest first
	subs      map[*Subscription]struct{}
	lastStamp time.Time
	closed    bool
	// done is closed by Close; it stops the badge loop.
	done chan struct{}

	// badge is the latest computed badge; nil until the first successful computation.
	badge *octodeckv1.BadgeUpdate
	// badgeDirty signals the badge loop that the badge may have changed. Signals coalesce.
	badgeDirty   chan struct{}
	badgeStarted bool
}

// New creates a Broadcaster.
func New(opts Options) *Broadcaster {
	if opts.HistorySize <= 0 {
		opts.HistorySize = DefaultHistorySize
	}
	if opts.HistoryAge <= 0 {
		opts.HistoryAge = DefaultHistoryAge
	}
	if opts.SubscriberBuffer <= 0 {
		opts.SubscriberBuffer = DefaultSubscriberBuffer
	}
	if opts.BadgeDebounce <= 0 {
		opts.BadgeDebounce = DefaultBadgeDebounce
	}
	if opts.BadgeRetry <= 0 {
		opts.BadgeRetry = DefaultBadgeRetry
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Broadcaster{
		opts:       opts,
		subs:       make(map[*Subscription]struct{}),
		done:       make(chan struct{}),
		badgeDirty: make(chan struct{}, 1),
	}
}

// nextStampLocked returns a stamp strictly after every stamp handed out so far. The monotonic
// reading is stripped so that stamps compare the same way as the wall-clock cursors clients send
// back.
func (b *Broadcaster) nextStampLocked() time.Time {
	now := b.opts.Now().Round(0)
	if !now.After(b.lastStamp) {
		now = b.lastStamp.Add(time.Nanosecond)
	}
	b.lastStamp = now
	return now
}

func (b *Broadcaster) pruneLocked() {
	cutoff := b.opts.Now().Add(-b.opts.HistoryAge)
	drop := 0
	for drop < len(b.history) && b.history[drop].SentAt.Before(cutoff) {
		drop++
	}
	if over := len(b.history) - drop - b.opts.HistorySize; over > 0 {
		drop += over
	}
	if drop > 0 {
		b.history = append([]Stamped(nil), b.history[drop:]...)
	}
}

// Publish stamps the notifications, records them in the history, and queues them for every
// subscriber as one batch, however many there are. It never blocks: a subscriber whose queue is
// full is terminated as lagged.
func (b *Broadcaster) Publish(notifications ...*octodeckv1.Notification) {
	if b == nil || len(notifications) == 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	batch := make([]Stamped, 0, len(notifications))
	for _, n := range notifications {
		if n == nil {
			continue
		}
		batch = append(batch, Stamped{Notification: n, SentAt: b.nextStampLocked()})
	}
	if len(batch) == 0 {
		return
	}
	b.history = append(b.history, batch...)
	for sub := range b.subs {
		select {
		case sub.notifications <- batch:
		default:
			sub.terminateLocked(true)
		}
	}
	b.pruneLocked()
}

// Subscribe registers a subscriber. If since is non-zero, it also returns the retained
// notifications published after since (oldest first); registration and the snapshot happen
// atomically, so nothing is missed or delivered twice between them. Subscribing to a closed
// Broadcaster returns an already terminated subscription.
func (b *Broadcaster) Subscribe(since time.Time) (*Subscription, []Stamped) {
	sub := &Subscription{
		b:             b,
		notifications: make(chan []Stamped, DefaultSubscriberBuffer),
		badge:         make(chan struct{}, 1),
		done:          make(chan struct{}),
	}
	if b == nil {
		return sub, nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	sub.notifications = make(chan []Stamped, b.opts.SubscriberBuffer)
	if b.closed {
		close(sub.done)
		return sub, nil
	}
	b.subs[sub] = struct{}{}
	if since.IsZero() {
		return sub, nil
	}
	b.pruneLocked()
	var backlog []Stamped
	for _, st := range b.history {
		if st.SentAt.After(since) {
			backlog = append(backlog, st)
		}
	}
	return sub, backlog
}

// Close terminates every subscription, stops the badge loop and rejects further publishes. Used
// at daemon shutdown so that long-lived streams end promptly. It is idempotent.
func (b *Broadcaster) Close() {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	close(b.done)
	for sub := range b.subs {
		sub.terminateLocked(false)
	}
}

// Subscription receives notifications and badge changes from a Broadcaster.
type Subscription struct {
	b             *Broadcaster
	notifications chan []Stamped
	badge         chan struct{}
	done          chan struct{}
	lagged        bool // guarded by b.mu
}

// Notifications delivers published batches in stamp order.
func (s *Subscription) Notifications() <-chan []Stamped {
	return s.notifications
}

// TryReceive returns every batch already queued, flattened, without blocking.
func (s *Subscription) TryReceive() []Stamped {
	var out []Stamped
	for {
		select {
		case batch := <-s.notifications:
			out = append(out, batch...)
		default:
			return out
		}
	}
}

// BadgeChanged signals that Badge has a new value.
func (s *Subscription) BadgeChanged() <-chan struct{} {
	return s.badge
}

// Badge returns the latest computed badge, or nil if it hasn't been computed yet.
func (s *Subscription) Badge() *octodeckv1.BadgeUpdate {
	if s.b == nil {
		return nil
	}
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	return s.b.badge
}

// Done is closed when the subscription ends: because it fell behind (see Lagged), because the
// Broadcaster was closed, or because Close was called.
func (s *Subscription) Done() <-chan struct{} {
	return s.done
}

// Lagged reports whether the subscription was terminated because its queue overflowed.
func (s *Subscription) Lagged() bool {
	if s.b == nil {
		return false
	}
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	return s.lagged
}

// Cursor returns a resume cursor for a message that carries no notification (heartbeat, badge).
// It is safe only when every notification stamped at or before it has already been read from
// Notifications(), so ok is false while notifications are still queued; drain them and retry.
// The returned stamp is reserved, so later notifications are stamped strictly after it.
func (s *Subscription) Cursor() (time.Time, bool) {
	if s.b == nil {
		return time.Now().Round(0), true
	}
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	if len(s.notifications) > 0 {
		return time.Time{}, false
	}
	return s.b.nextStampLocked(), true
}

// Close unregisters the subscription. It is idempotent.
func (s *Subscription) Close() {
	if s.b == nil {
		return
	}
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	s.terminateLocked(false)
}

func (s *Subscription) terminateLocked(lagged bool) {
	if _, ok := s.b.subs[s]; !ok {
		return
	}
	delete(s.b.subs, s)
	s.lagged = lagged
	close(s.done)
}
