package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

func TestNotificationSettingsDefaults(t *testing.T) {
	t.Run("new config", func(t *testing.T) {
		cfg, err := Load(filepath.Join(t.TempDir(), "config.json"), Overrides{})
		require.NoError(t, err)
		assert.True(t, proto.Equal(DefaultNotificationSettings(), cfg.GetNotificationSettings()))
	})

	t.Run("older config file without settings", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "config.json")
		require.NoError(t, os.WriteFile(path, []byte(`{"pollingIntervalMin": 5}`), 0o600))
		cfg, err := Load(path, Overrides{})
		require.NoError(t, err)
		assert.True(t, proto.Equal(DefaultNotificationSettings(), cfg.GetNotificationSettings()))
	})

	t.Run("stored false values are kept and missing fields defaulted", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "config.json")
		require.NoError(t, os.WriteFile(path, []byte(
			`{"notificationSettings": {"enabled": false, "badgeCountMode": "BADGE_COUNT_MODE_UNREAD"}}`), 0o600))
		cfg, err := Load(path, Overrides{})
		require.NoError(t, err)
		s := cfg.GetNotificationSettings()
		assert.False(t, s.GetEnabled())
		assert.Equal(t, octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_UNREAD, s.GetBadgeCountMode())
		assert.True(t, s.GetAlwaysIncludeMentions())
		assert.True(t, s.GetNotifyOnNewActivity())
	})

	t.Run("NewForTest", func(t *testing.T) {
		cfg := NewForTest(octodeckv1.Config_builder{}.Build())
		assert.True(t, cfg.GetNotificationSettings().GetEnabled())
	})
}

func TestNotificationSettingsFieldMask(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg, err := Load(path, Overrides{})
	require.NoError(t, err)

	update := octodeckv1.Config_builder{
		PollingIntervalMin: Ptr(int32(42)),
		NotificationSettings: octodeckv1.NotificationSettings_builder{
			RepoExcludes:          []string{"owner/noisy"},
			AlwaysIncludeMentions: Ptr(false),
		}.Build(),
	}.Build()
	require.NoError(t, cfg.UpdateProto(update, &fieldmaskpb.FieldMask{Paths: []string{"notification_settings"}}))

	s := cfg.GetNotificationSettings()
	assert.Equal(t, []string{"owner/noisy"}, s.GetRepoExcludes())
	assert.False(t, s.GetAlwaysIncludeMentions())
	assert.True(t, s.GetEnabled(), "unset fields take defaults")
	assert.Equal(t, int32(1), cfg.GetPollingIntervalMin(), "fields outside the mask are unchanged")

	// The update must not alias the caller's message.
	update.GetNotificationSettings().SetRepoExcludes([]string{"changed"})
	assert.Equal(t, []string{"owner/noisy"}, cfg.GetNotificationSettings().GetRepoExcludes())

	// Persisted across reloads.
	reloaded, err := Load(path, Overrides{})
	require.NoError(t, err)
	assert.True(t, proto.Equal(s, reloaded.GetNotificationSettings()))

	// Clearing via the mask restores the defaults.
	require.NoError(t, cfg.UpdateProto(octodeckv1.Config_builder{}.Build(),
		&fieldmaskpb.FieldMask{Paths: []string{"notification_settings"}}))
	assert.True(t, proto.Equal(DefaultNotificationSettings(), cfg.GetNotificationSettings()))
	assert.True(t, proto.Equal(DefaultNotificationSettings(), cfg.GetProto().GetNotificationSettings()))
}

func TestNotificationDefaultsAreNotPersisted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg, err := Load(path, Overrides{})
	require.NoError(t, err)
	require.NoError(t, cfg.UpdateProto(octodeckv1.Config_builder{
		NotificationSettings: octodeckv1.NotificationSettings_builder{Enabled: Ptr(false)}.Build(),
	}.Build(), &fieldmaskpb.FieldMask{Paths: []string{"notification_settings"}}))

	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Regexp(t, `"enabled":\s+false`, string(raw), "explicit choices are stored")
	assert.NotContains(t, string(raw), "alwaysIncludeMentions", "defaults are applied on read, not stored")
	assert.True(t, cfg.GetNotificationSettings().GetAlwaysIncludeMentions())
}

func TestDashboardBaseURL(t *testing.T) {
	cfg := NewForTest(octodeckv1.Config_builder{}.Build())
	assert.Regexp(t, `^http://127\.0\.0\.1:\d+$`, cfg.DashboardBaseURL())
}
