package logic

import (
	"time"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// notificationContext carries the per-batch inputs for deciding notifications while reconciling
// items, so configuration is read once per batch.
type notificationContext struct {
	suppressed     bool
	currentUser    string
	knownBots      []string
	settings       *octodeckv1.NotificationSettings
	baseURL        string
	watchedRepos   []string
	excludedRepos  []string
	includedLabels []string
	excludedLabels []string
}

// newNotificationContext reads the notification inputs for one batch. suppressed disables
// notifications for the whole batch (e.g. while seeding an empty database).
func (s *SyncEngine) newNotificationContext(suppressed bool) *notificationContext {
	if suppressed || s.cfg == nil || s.gh == nil {
		return &notificationContext{suppressed: true}
	}
	return &notificationContext{
		currentUser:    s.getCurrentUser(),
		knownBots:      s.cfg.GetKnownBots(),
		settings:       s.cfg.GetNotificationSettings(),
		baseURL:        s.cfg.DashboardBaseURL(),
		watchedRepos:   s.cfg.GetWatchedRepos(),
		excludedRepos:  s.cfg.GetExcludedRepos(),
		includedLabels: s.cfg.GetProto().GetIncludedLabels(),
		excludedLabels: s.cfg.GetProto().GetExcludedLabels(),
	}
}

// evaluate returns the notification produced by reconciling fetched (already merged with stored
// and with local state attached) against stored (nil for a new item), or nil.
//
// Visibility follows GetItems: items in repositories hidden by the global repo filters never
// notify, and label filters match the labels the dashboard shows (after the global label filters).
func (nc *notificationContext) evaluate(stored, fetched *octodeckv1.Item, now time.Time) *octodeckv1.Notification {
	if nc.suppressed || !nc.settings.GetEnabled() {
		return nil
	}
	if !MatchesFilter(fetched.GetRepo(), nc.watchedRepos, nc.excludedRepos) {
		return nil
	}

	// Evaluate against the visible labels without changing what gets stored.
	if len(nc.includedLabels) > 0 || len(nc.excludedLabels) > 0 {
		allLabels := fetched.GetLabels()
		fetched.SetLabels(FilterLabels(allLabels, nc.includedLabels, nc.excludedLabels))
		defer fetched.SetLabels(allLabels)
	}

	d := EvaluateNotification(stored, fetched, nc.currentUser, nc.knownBots, nc.settings, now)
	if !d.Notify() {
		return nil
	}
	return BuildNotification(fetched, d, nc.baseURL, now)
}
