package server

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/logic"
	"github.com/tallclair/octodeck/backend/internal/notify"
)

const (
	// defaultHeartbeatInterval keeps idle streams (and proxies) alive and gives the client a
	// fresh resume cursor. It is below the 30s idle timeout of Manifest V3 service workers, whose
	// storage writes on each message keep the extension's worker alive.
	defaultHeartbeatInterval = 20 * time.Second
	// maxIndividualNotifications is the most notifications sent individually at once (on
	// reconnect, or for a burst published together); more are summarised in a single
	// notification.
	maxIndividualNotifications = 3
)

// WatchNotifications streams desktop notifications decided by the sync engine, badge updates,
// and heartbeats. On connect it replays (or summarises) notifications the client missed since
// last_received_at that are still in the daemon's in-memory history, then sends the badge.
func (h *octoDeckHandler) WatchNotifications(
	ctx context.Context,
	req *connect.Request[octodeckv1.WatchNotificationsRequest],
	stream *connect.ServerStream[octodeckv1.WatchNotificationsResponse],
) error {
	if h.broadcaster == nil {
		return connect.NewError(connect.CodeUnavailable, errors.New("notifications are not available"))
	}

	var since time.Time
	if ts := req.Msg.GetLastReceivedAt(); ts != nil && ts.IsValid() && ts.GetSeconds() > 0 {
		since = ts.AsTime()
	}
	sub, backlog := h.broadcaster.Subscribe(since)
	defer sub.Close()

	w := &notificationStreamWriter{stream: stream, sub: sub, baseURL: h.cfg.DashboardBaseURL}
	if h.cfg.GetNotificationSettings().GetEnabled() {
		if err := w.sendBatch(backlog); err != nil {
			return err
		}
	}
	if sub.Badge() == nil {
		// Not computed yet (or the last computation failed): ask for it; BadgeChanged fires
		// when it is ready.
		h.broadcaster.InvalidateBadge()
	} else if err := w.sendBadge(); err != nil {
		return err
	}
	return h.streamNotifications(ctx, w)
}

// streamNotifications forwards live notifications, badge changes and heartbeats until the client
// disconnects or the subscription ends.
func (h *octoDeckHandler) streamNotifications(ctx context.Context, w *notificationStreamWriter) error {
	interval := h.heartbeatInterval
	if interval <= 0 {
		interval = defaultHeartbeatInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		var err error
		select {
		case <-ctx.Done():
			return nil
		case <-w.sub.Done():
			if w.sub.Lagged() {
				return connect.NewError(connect.CodeUnavailable,
					errors.New("notification stream fell behind; reconnect to catch up"))
			}
			// The daemon is shutting down.
			return nil
		case batch := <-w.sub.Notifications():
			err = w.sendBatch(slices.Concat(batch, w.sub.TryReceive()))
		case <-w.sub.BadgeChanged():
			err = w.sendBadge()
		case <-ticker.C:
			err = w.sendWithCursor(octodeckv1.WatchNotificationsResponse_builder{
				Heartbeat: octodeckv1.Heartbeat_builder{}.Build(),
			}.Build())
		}
		if err != nil {
			return err
		}
	}
}

// computeBadge computes the badge over the items GetItems returns by default. The broadcaster's
// badge loop calls it once per burst of invalidations and shares the result with every stream.
func (h *octoDeckHandler) computeBadge(ctx context.Context) (*octodeckv1.BadgeUpdate, error) {
	items, err := h.db.GetItems(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to load items for badge: %w", err)
	}
	items = h.filterItemRepos(items)
	return logic.ComputeBadge(items, h.currentUser(), h.cfg.GetKnownBots(),
		h.cfg.GetNotificationSettings().GetBadgeCountMode()), nil
}

// invalidateBadge tells the badge loop that badge counts may have changed.
func (h *octoDeckHandler) invalidateBadge() {
	h.broadcaster.InvalidateBadge()
}

// notificationStreamWriter sends messages on one WatchNotifications stream, stamping each with a
// resume cursor that never skips a notification the client hasn't received.
type notificationStreamWriter struct {
	stream    *connect.ServerStream[octodeckv1.WatchNotificationsResponse]
	sub       *notify.Subscription
	baseURL   func() string
	lastBadge *octodeckv1.BadgeUpdate
}

func (w *notificationStreamWriter) send(sentAt time.Time, msg *octodeckv1.WatchNotificationsResponse) error {
	msg.SetSentAt(timestamppb.New(sentAt))
	return w.stream.Send(msg)
}

func (w *notificationStreamWriter) sendNotification(st notify.Stamped) error {
	return w.send(st.SentAt, octodeckv1.WatchNotificationsResponse_builder{
		Notification: st.Notification,
	}.Build())
}

// sendBadge sends the shared badge if it differs from the last badge sent on this stream.
func (w *notificationStreamWriter) sendBadge() error {
	badge := w.sub.Badge()
	if badge == nil || (w.lastBadge != nil && proto.Equal(w.lastBadge, badge)) {
		return nil
	}
	w.lastBadge = badge
	return w.sendWithCursor(octodeckv1.WatchNotificationsResponse_builder{Badge: badge}.Build())
}

// sendWithCursor sends a message that carries no notification. Queued notifications are sent
// first, so the cursor attached to the message is only ever later than notifications the client
// already has.
func (w *notificationStreamWriter) sendWithCursor(msg *octodeckv1.WatchNotificationsResponse) error {
	for {
		if cursor, ok := w.sub.Cursor(); ok {
			return w.send(cursor, msg)
		}
		select {
		case batch := <-w.sub.Notifications():
			if err := w.sendBatch(slices.Concat(batch, w.sub.TryReceive())); err != nil {
				return err
			}
		case <-w.sub.Done():
			// Terminated with notifications still queued: send without advancing the cursor
			// past them.
			return nil
		}
	}
}

// sendBatch sends notifications that arrive together (missed since the client's cursor, or
// published in one burst): the latest per item, individually if there are at most
// maxIndividualNotifications items, otherwise as one summary.
func (w *notificationStreamWriter) sendBatch(batch []notify.Stamped) error {
	if len(batch) == 0 {
		return nil
	}
	latest := latestPerItem(batch)
	if len(latest) <= maxIndividualNotifications {
		for _, st := range latest {
			if err := w.sendNotification(st); err != nil {
				return err
			}
		}
		return nil
	}

	count := int32(len(latest)) //nolint:gosec // bounded by the notification history size
	summary := octodeckv1.NotificationSummary_builder{
		Count:   &count,
		Title:   config.Ptr("OctoDeck"),
		Message: config.Ptr(fmt.Sprintf("%d items need your attention", count)),
		Url:     config.Ptr(logic.DashboardInboxURL(w.baseURL())),
	}.Build()
	return w.send(batch[len(batch)-1].SentAt, octodeckv1.WatchNotificationsResponse_builder{
		Summary: summary,
	}.Build())
}

// latestPerItem keeps the newest notification for each item, ordered by stamp.
func latestPerItem(backlog []notify.Stamped) []notify.Stamped {
	latestIdx := make(map[string]int, len(backlog))
	for i, st := range backlog {
		latestIdx[st.Notification.GetItemId()] = i
	}
	out := make([]notify.Stamped, 0, len(latestIdx))
	for i, st := range backlog {
		if latestIdx[st.Notification.GetItemId()] == i {
			out = append(out, st)
		}
	}
	return out
}

// validateNotificationSettings checks pattern syntax and the badge mode. nil (not being updated)
// is valid.
func validateNotificationSettings(s *octodeckv1.NotificationSettings) error {
	if s == nil {
		return nil
	}
	checks := []struct {
		name     string
		patterns []string
		validate func([]string) error
	}{
		{"repo_includes", s.GetRepoIncludes(), logic.ValidateRepoPatterns},
		{"repo_excludes", s.GetRepoExcludes(), logic.ValidateRepoPatterns},
		{"label_includes", s.GetLabelIncludes(), logic.ValidateLabelPatterns},
		{"label_excludes", s.GetLabelExcludes(), logic.ValidateLabelPatterns},
		{"author_includes", s.GetAuthorIncludes(), logic.ValidateAuthorPatterns},
		{"author_excludes", s.GetAuthorExcludes(), logic.ValidateAuthorPatterns},
	}
	for _, c := range checks {
		if err := c.validate(c.patterns); err != nil {
			return fmt.Errorf("%s: %w", c.name, err)
		}
	}
	if _, known := octodeckv1.BadgeCountMode_name[int32(s.GetBadgeCountMode())]; !known {
		return fmt.Errorf("unknown badge_count_mode %d", s.GetBadgeCountMode())
	}
	return nil
}
