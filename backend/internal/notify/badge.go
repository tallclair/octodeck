package notify

import (
	"context"
	"log/slog"
	"time"

	"google.golang.org/protobuf/proto"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// BadgeFunc computes the current badge.
type BadgeFunc func(ctx context.Context) (*octodeckv1.BadgeUpdate, error)

// badgeComputeTimeout bounds a single badge computation.
const badgeComputeTimeout = 30 * time.Second

// InvalidateBadge marks the badge as possibly changed. The badge loop (see StartBadge) recomputes
// it once per burst of invalidations. Signals coalesce, so this never blocks.
func (b *Broadcaster) InvalidateBadge() {
	if b == nil {
		return
	}
	select {
	case b.badgeDirty <- struct{}{}:
	default:
	}
}

// StartBadge starts the badge loop, which computes the badge with compute after each burst of
// invalidations (debounced by Options.BadgeDebounce) and signals subscribers when it changes. A
// failed computation is logged and retried after Options.BadgeRetry. The badge is computed once
// at start. The loop stops when the Broadcaster is closed. Only the first call has an effect.
func (b *Broadcaster) StartBadge(compute BadgeFunc) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.badgeStarted || b.closed {
		return
	}
	b.badgeStarted = true
	b.InvalidateBadge()
	go b.runBadge(compute)
}

func (b *Broadcaster) runBadge(compute BadgeFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-b.done
		cancel()
	}()

	timer := time.NewTimer(0)
	if !timer.Stop() {
		<-timer.C
	}
	pending := false
	for {
		select {
		case <-b.done:
			timer.Stop()
			return
		case <-b.badgeDirty:
			if !pending {
				pending = true
				timer.Reset(b.opts.BadgeDebounce)
			}
		case <-timer.C:
			pending = false
			if err := b.recomputeBadge(ctx, compute); err != nil {
				if ctx.Err() != nil {
					return
				}
				slog.WarnContext(ctx, "Failed to compute notification badge; retrying",
					"error", err, "retry", b.opts.BadgeRetry)
				pending = true
				timer.Reset(b.opts.BadgeRetry)
			}
		}
	}
}

func (b *Broadcaster) recomputeBadge(ctx context.Context, compute BadgeFunc) error {
	ctx, cancel := context.WithTimeout(ctx, badgeComputeTimeout)
	defer cancel()
	badge, err := compute(ctx)
	if err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.badge != nil && proto.Equal(b.badge, badge) {
		return nil
	}
	b.badge = badge
	for sub := range b.subs {
		select {
		case sub.badge <- struct{}{}:
		default:
		}
	}
	return nil
}
