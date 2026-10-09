package config

import (
	"fmt"

	"google.golang.org/protobuf/proto"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// DefaultNotificationSettings returns the notification and badge preferences used for any field
// the user hasn't set. Explicit @mentions bypass the filters by default because they are direct
// requests for the user's attention.
func DefaultNotificationSettings() *octodeckv1.NotificationSettings {
	return octodeckv1.NotificationSettings_builder{
		Enabled:                Ptr(true),
		OnlyAssignedOrAuthored: Ptr(true),
		NotifyOnNewItems:       Ptr(true),
		NotifyOnNewActivity:    Ptr(true),
		IgnoreBots:             Ptr(true),
		AlwaysIncludeMentions:  Ptr(true),
		BadgeCountMode:         Ptr(octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_INBOX),
	}.Build()
}

// effectiveNotificationSettings returns a copy of s with every unset field filled with its
// default. Defaults are applied when settings are read, never stored, so the config file only
// holds the user's explicit choices (a stored false is kept) and later default changes reach
// everyone who didn't choose otherwise.
func effectiveNotificationSettings(s *octodeckv1.NotificationSettings) *octodeckv1.NotificationSettings {
	defaults := DefaultNotificationSettings()
	if s == nil {
		return defaults
	}
	out, _ := proto.Clone(s).(*octodeckv1.NotificationSettings)
	if !out.HasEnabled() {
		out.SetEnabled(defaults.GetEnabled())
	}
	if !out.HasOnlyAssignedOrAuthored() {
		out.SetOnlyAssignedOrAuthored(defaults.GetOnlyAssignedOrAuthored())
	}
	if !out.HasNotifyOnNewItems() {
		out.SetNotifyOnNewItems(defaults.GetNotifyOnNewItems())
	}
	if !out.HasNotifyOnNewActivity() {
		out.SetNotifyOnNewActivity(defaults.GetNotifyOnNewActivity())
	}
	if !out.HasIgnoreBots() {
		out.SetIgnoreBots(defaults.GetIgnoreBots())
	}
	if !out.HasAlwaysIncludeMentions() {
		out.SetAlwaysIncludeMentions(defaults.GetAlwaysIncludeMentions())
	}
	if out.GetBadgeCountMode() == octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_UNSPECIFIED {
		out.SetBadgeCountMode(defaults.GetBadgeCountMode())
	}
	return out
}

// GetNotificationSettings returns a copy of the effective notification settings.
func (c *Config) GetNotificationSettings() *octodeckv1.NotificationSettings {
	return effectiveNotificationSettings(c.data.Load().GetNotificationSettings())
}

// DashboardBaseURL returns the base URL of the dashboard served by this daemon.
func (c *Config) DashboardBaseURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d", c.GetPort())
}
