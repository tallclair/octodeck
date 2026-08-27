package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

func TestConfigLoadSave(t *testing.T) {
	tempDir := t.TempDir()
	customPath := filepath.Join(tempDir, "config.json")

	t.Run("Load default if not exists", func(t *testing.T) {
		cfg, err := Load(customPath, Overrides{})
		require.NoError(t, err)
		assert.Equal(t, customPath, cfg.GetPath())
		assert.Equal(t, int32(1), cfg.GetPollingIntervalMin())
	})

	t.Run("Save and Load", func(t *testing.T) {
		cfg, err := Load(customPath, Overrides{})
		require.NoError(t, err)

		newData := octodeckv1.Config_builder{
			PollingIntervalMin: Ptr(int32(30)),
			WatchedRepos:       []string{"owner/repo"},
		}.Build()
		err = cfg.UpdateProto(newData, nil)
		require.NoError(t, err)

		// Verify file exists
		_, err = os.Stat(customPath)
		require.NoError(t, err)

		// Load again
		cfg2, err := Load(customPath, Overrides{})
		require.NoError(t, err)
		assert.Equal(t, int32(30), cfg2.GetPollingIntervalMin())
		assert.Equal(t, []string{"owner/repo"}, cfg2.GetWatchedRepos())
	})

	t.Run("Partial update with FieldMask", func(t *testing.T) {
		cfg, err := Load(customPath, Overrides{})
		require.NoError(t, err)

		newData := octodeckv1.Config_builder{
			PollingIntervalMin: Ptr(int32(60)),
			WatchedRepos:       []string{"other/repo"},
		}.Build()
		// Only update polling_interval_min
		err = cfg.UpdateProto(newData, &fieldmaskpb.FieldMask{Paths: []string{"polling_interval_min"}})
		require.NoError(t, err)

		assert.Equal(t, int32(60), cfg.GetPollingIntervalMin())
		assert.Equal(t, []string{"owner/repo"}, cfg.GetWatchedRepos(), "watched_repos should not have changed")
	})

	t.Run("Explicit Save", func(t *testing.T) {
		path := filepath.Join(tempDir, "config_save.json")
		cfg, err := Load(path, Overrides{})
		require.NoError(t, err)

		// Verify explicit Save() persists the default config to a new file.
		err = cfg.Save()
		require.NoError(t, err)

		_, err = os.Stat(path)
		assert.NoError(t, err)
	})
}

func TestConfigAccessors(t *testing.T) {
	t.Run("GetSyncInterval", func(t *testing.T) {
		cfg := NewForTest(octodeckv1.Config_builder{PollingIntervalMin: Ptr(int32(10))}.Build())
		assert.Equal(t, 10*time.Minute, cfg.GetSyncInterval())

		cfg0 := NewForTest(octodeckv1.Config_builder{PollingIntervalMin: Ptr(int32(0))}.Build())
		assert.Equal(t, DefaultSyncInterval, cfg0.GetSyncInterval())
	})

	t.Run("GetPort", func(t *testing.T) {
		// Default
		cfg := NewForTest(octodeckv1.Config_builder{}.Build())
		assert.Equal(t, DefaultPort, cfg.GetPort())

		// Configured
		cfg = NewForTest(octodeckv1.Config_builder{Port: Ptr(int32(9090))}.Build())
		assert.Equal(t, 9090, cfg.GetPort())

		// Override
		cfg.overrides.Port = 8080
		assert.Equal(t, 8080, cfg.GetPort())
	})

	t.Run("GetDBPath", func(t *testing.T) {
		// Default
		cfg := NewForTest(octodeckv1.Config_builder{}.Build())
		home, err := os.UserHomeDir()
		require.NoError(t, err)
		expected := filepath.Join(home, ".octodeck", "octodeck.db")
		path, err := cfg.GetDBPath()
		require.NoError(t, err)
		assert.Equal(t, expected, path)

		// Configured
		cfg = NewForTest(octodeckv1.Config_builder{DbPath: Ptr("/tmp/db")}.Build())
		path, err = cfg.GetDBPath()
		require.NoError(t, err)
		assert.Equal(t, "/tmp/db", path)

		// Override
		cfg.overrides.DBPath = "/override/db"
		path, err = cfg.GetDBPath()
		require.NoError(t, err)
		assert.Equal(t, "/override/db", path)
	})

	t.Run("GetProto", func(t *testing.T) {
		data := octodeckv1.Config_builder{PollingIntervalMin: Ptr(int32(10))}.Build()
		cfg := NewForTest(data)
		proto := cfg.GetProto()
		assert.Equal(t, int32(10), proto.GetPollingIntervalMin())
		// Ensure it's a copy
		proto.SetPollingIntervalMin(20)
		assert.Equal(t, int32(10), cfg.GetPollingIntervalMin())
	})

	t.Run("GetConfigPath", func(t *testing.T) {
		path, err := GetConfigPath()
		require.NoError(t, err)
		assert.NotEmpty(t, path)
	})

	t.Run("GetDevServer", func(t *testing.T) {
		cfg := &Config{overrides: Overrides{DevServer: "true"}}
		assert.Equal(t, DefaultDevServer, cfg.GetDevServer())

		cfgCustom := &Config{overrides: Overrides{DevServer: "http://localhost:3000"}}
		assert.Equal(t, "http://localhost:3000", cfgCustom.GetDevServer())
	})
}

const botCodecov = "codecov"

func TestNormalizeKnownBots(t *testing.T) {
	input := []string{
		"  K8s-Ci-Robot[bot] ",
		"dependabot[bot]",
		"DEPENDABOT",
		botCodecov,
		"  ",
		"custom-bot[robot]",
		"KUBERNETES-PROW",
		"codecov[BOT]",
	}

	expected := []string{
		botCodecov,
		"custom-bot",
		"dependabot",
		"k8s-ci-robot",
		"kubernetes-prow",
	}

	result := NormalizeKnownBots(input)
	assert.Equal(t, expected, result)
}

func TestDefaultKnownBots(t *testing.T) {
	bots := DefaultKnownBots()
	assert.NotEmpty(t, bots)
	// Must be sorted and all lowercase without [bot]
	for _, b := range bots {
		assert.Equal(t, b, NormalizeKnownBots([]string{b})[0])
		assert.NotContains(t, b, "[bot]")
		assert.NotContains(t, b, "[robot]")
	}
	assert.Equal(t, NormalizeKnownBots(bots), bots)
}

func TestAddKnownBots(t *testing.T) {
	tempDir := t.TempDir()
	customPath := filepath.Join(tempDir, "config.json")

	cfg, err := Load(customPath, Overrides{})
	require.NoError(t, err)

	initialCount := len(cfg.GetKnownBots())

	// Adding already existing bot (with [bot] suffix) should not change list
	updated, added, err := cfg.AddKnownBots("codecov[bot]", "  K8S-CI-ROBOT  ")
	require.NoError(t, err)
	assert.False(t, added)
	assert.Len(t, updated, initialCount)

	// Adding brand new bot
	updated, added, err = cfg.AddKnownBots("New-Awesome-Bot[bot]")
	require.NoError(t, err)
	assert.True(t, added)
	assert.Len(t, updated, initialCount+1)
	assert.Contains(t, updated, "new-awesome-bot")

	// Reload from disk to verify persistence
	cfg2, err := Load(customPath, Overrides{})
	require.NoError(t, err)
	assert.Equal(t, updated, cfg2.GetKnownBots())
}
