package config

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/reflect/protoreflect"
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
		assert.Equal(t, int32(10), cfg.GetDiscoveryIntervalMin())
		assert.Equal(t, 10*time.Minute, cfg.GetDiscoveryInterval())
		assert.Empty(t, cfg.GetTrackedQueries())
	})

	t.Run("Save and Load", func(t *testing.T) {
		cfg, err := Load(customPath, Overrides{})
		require.NoError(t, err)

		newData := octodeckv1.Config_builder{
			PollingIntervalMin:   Ptr(int32(30)),
			DiscoveryIntervalMin: Ptr(int32(15)),
			WatchedRepos:         []string{"owner/repo"},
			TrackedQueries:       []string{"repo:kubernetes/kubernetes is:open label:sig/node"},
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
		assert.Equal(t, int32(15), cfg2.GetDiscoveryIntervalMin())
		assert.Equal(t, 15*time.Minute, cfg2.GetDiscoveryInterval())
		assert.Equal(t, []string{"owner/repo"}, cfg2.GetWatchedRepos())
		assert.Equal(t, []string{"repo:kubernetes/kubernetes is:open label:sig/node"}, cfg2.GetTrackedQueries())
	})

	t.Run("Partial update with FieldMask", func(t *testing.T) {
		cfg, err := Load(customPath, Overrides{})
		require.NoError(t, err)

		newData := octodeckv1.Config_builder{
			PollingIntervalMin:   Ptr(int32(60)),
			DiscoveryIntervalMin: Ptr(int32(45)),
			WatchedRepos:         []string{"other/repo"},
			TrackedQueries:       []string{"repo:golang/go is:open"},
		}.Build()
		// Only update polling_interval_min, discovery_interval_min, and tracked_queries
		err = cfg.UpdateProto(newData, &fieldmaskpb.FieldMask{Paths: []string{
			"polling_interval_min",
			"discovery_interval_min",
			"tracked_queries",
		}})
		require.NoError(t, err)

		assert.Equal(t, int32(60), cfg.GetPollingIntervalMin())
		assert.Equal(t, int32(45), cfg.GetDiscoveryIntervalMin())
		assert.Equal(t, 45*time.Minute, cfg.GetDiscoveryInterval())
		assert.Equal(t, []string{"repo:golang/go is:open"}, cfg.GetTrackedQueries())
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

	t.Run("GetDiscoveryInterval", func(t *testing.T) {
		cfg := NewForTest(octodeckv1.Config_builder{DiscoveryIntervalMin: Ptr(int32(15))}.Build())
		assert.Equal(t, 15*time.Minute, cfg.GetDiscoveryInterval())
		assert.Equal(t, int32(15), cfg.GetDiscoveryIntervalMin())

		// Zero falls back to DefaultDiscoveryInterval
		cfg0 := NewForTest(octodeckv1.Config_builder{DiscoveryIntervalMin: Ptr(int32(0))}.Build())
		assert.Equal(t, DefaultDiscoveryInterval, cfg0.GetDiscoveryInterval())

		// Negative falls back to DefaultDiscoveryInterval
		cfgNeg := NewForTest(octodeckv1.Config_builder{DiscoveryIntervalMin: Ptr(int32(-10))}.Build())
		assert.Equal(t, DefaultDiscoveryInterval, cfgNeg.GetDiscoveryInterval())

		// Unset (nil) falls back to DefaultDiscoveryInterval
		cfgEmpty := NewForTest(octodeckv1.Config_builder{}.Build())
		assert.Equal(t, DefaultDiscoveryInterval, cfgEmpty.GetDiscoveryInterval())
	})

	t.Run("GetTrackedQueries", func(t *testing.T) {
		cfgEmpty := NewForTest(octodeckv1.Config_builder{}.Build())
		assert.Empty(t, cfgEmpty.GetTrackedQueries())

		cfg := NewForTest(octodeckv1.Config_builder{
			TrackedQueries: []string{"repo:a/b is:open", "org:test is:pr"},
		}.Build())
		assert.Equal(t, []string{"repo:a/b is:open", "org:test is:pr"}, cfg.GetTrackedQueries())
	})
}

func TestConfig_DiscoveryAndTrackedQueriesJSON(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.json")

	// Write JSON directly with camelCase and snake_case compatibility
	jsonContent := `{
  "pollingIntervalMin": 5,
  "discoveryIntervalMin": 20,
  "trackedQueries": [
    "repo:kubernetes/kubernetes is:open label:sig/node",
    "repo:kubernetes/website is:open is:pr"
  ]
}`
	err := os.WriteFile(configPath, []byte(jsonContent), 0600)
	require.NoError(t, err)

	cfg, err := Load(configPath, Overrides{})
	require.NoError(t, err)

	assert.Equal(t, int32(20), cfg.GetDiscoveryIntervalMin())
	assert.Equal(t, 20*time.Minute, cfg.GetDiscoveryInterval())
	assert.Equal(t, []string{
		"repo:kubernetes/kubernetes is:open label:sig/node",
		"repo:kubernetes/website is:open is:pr",
	}, cfg.GetTrackedQueries())

	// Re-save and inspect file content
	err = cfg.Save()
	require.NoError(t, err)

	savedBytes, err := os.ReadFile(configPath)
	require.NoError(t, err)
	savedStr := string(savedBytes)
	assert.Contains(t, savedStr, "discoveryIntervalMin")
	assert.Contains(t, savedStr, "trackedQueries")

	// Reload to verify round-trip
	cfgReloaded, err := Load(configPath, Overrides{})
	require.NoError(t, err)
	assert.Equal(t, int32(20), cfgReloaded.GetDiscoveryIntervalMin())
	assert.Equal(t, cfg.GetTrackedQueries(), cfgReloaded.GetTrackedQueries())
}

const (
	botCodecov    = "codecov"
	botDependabot = "dependabot"
)

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
		botDependabot,
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

func TestSanitizeTrackedQueries(t *testing.T) {
	t.Run("nil and empty", func(t *testing.T) {
		assert.Nil(t, SanitizeTrackedQueries(nil))
		assert.Nil(t, SanitizeTrackedQueries([]string{}))
		assert.Nil(t, SanitizeTrackedQueries([]string{"", "   ", "\t", "\n"}))
	})

	t.Run("trimming whitespace and filtering empty", func(t *testing.T) {
		input := []string{"  repo:octodeck/octodeck is:pr  ", "", "  ", "repo:golang/go is:open\t"}
		expected := []string{"repo:octodeck/octodeck is:pr", "repo:golang/go is:open"}
		assert.Equal(t, expected, SanitizeTrackedQueries(input))
	})

	t.Run("deduplication preserving order", func(t *testing.T) {
		input := []string{
			"repo:b/b is:open",
			"repo:a/a is:open",
			"repo:b/b is:open",
			"  repo:a/a is:open  ",
			"repo:c/c is:open",
		}
		expected := []string{
			"repo:b/b is:open",
			"repo:a/a is:open",
			"repo:c/c is:open",
		}
		assert.Equal(t, expected, SanitizeTrackedQueries(input))
	})

	t.Run("special characters, quotes, unicode", func(t *testing.T) {
		input := []string{
			`repo:kubernetes/kubernetes label:"sig/node" is:open -label:"do-not-merge"`,
			`repo:owner/repo label:🚀 created:>2026-01-01`,
			`repo:test/test query with emoji: 🔍 ⚠️ 🎯`,
		}
		assert.Equal(t, input, SanitizeTrackedQueries(input))
	})
}

func TestValidateTrackedQueries(t *testing.T) {
	t.Run("valid queries", func(t *testing.T) {
		assert.NoError(t, ValidateTrackedQueries(nil))
		assert.NoError(t, ValidateTrackedQueries([]string{}))
		assert.NoError(t, ValidateTrackedQueries([]string{"repo:a/b is:open", "org:k8s"}))
	})

	t.Run("null byte detection", func(t *testing.T) {
		err := ValidateTrackedQueries([]string{"repo:a/b\x00is:open"})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "null byte")
	})

	t.Run("invalid utf-8 detection", func(t *testing.T) {
		err := ValidateTrackedQueries([]string{"repo:a/b\xff\xfeis:open"})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid UTF-8")
	})

	t.Run("updated filter rejection", func(t *testing.T) {
		disallowed := []string{
			"repo:k8s/k8s is:open updated:>2026-01-01",
			"updated:<2026-01-01 is:open",
			"(updated:>=2026-01-01)",
			"-updated:2026-01-01",
			"repo:foo -updated:>2026-01-01",
			"repo:k8s/k8s UPDATED:>2026-01-01",
		}
		for _, q := range disallowed {
			assert.True(t, HasUpdatedFilter(q), "expected HasUpdatedFilter to return true for %q", q)
			err := ValidateTrackedQueries([]string{q})
			require.Error(t, err, "expected ValidateTrackedQueries to fail for %q", q)
			assert.Contains(t, err.Error(), "cannot contain an 'updated' filter")
		}

		allowed := []string{
			"repo:k8s/k8s is:open label:sig/node",
			"repo:k8s/k8s updated-documentation",
			"repo:k8s/k8s is:issue",
		}
		for _, q := range allowed {
			assert.False(t, HasUpdatedFilter(q), "expected HasUpdatedFilter to return false for %q", q)
			assert.NoError(t, ValidateTrackedQueries([]string{q}), "expected ValidateTrackedQueries to pass for %q", q)
		}
	})
}

func TestConfig_RepeatedFieldsFieldMaskClearing(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config_clearing.json")

	t.Run("Clear tracked_queries via FieldMask", func(t *testing.T) {
		cfg, err := Load(configPath, Overrides{})
		require.NoError(t, err)

		// 1. Seed tracked_queries
		seed := octodeckv1.Config_builder{
			TrackedQueries: []string{
				"repo:kubernetes/kubernetes is:open",
				"org:octodeck is:pr",
			},
		}.Build()
		err = cfg.UpdateProto(seed, &fieldmaskpb.FieldMask{Paths: []string{"tracked_queries"}})
		require.NoError(t, err)
		require.Len(t, cfg.GetTrackedQueries(), 2)

		// 2. Clear tracked_queries with empty slice
		clearCfg := octodeckv1.Config_builder{
			TrackedQueries: []string{},
		}.Build()
		require.NotPanics(t, func() {
			err = cfg.UpdateProto(clearCfg, &fieldmaskpb.FieldMask{Paths: []string{"tracked_queries"}})
		})
		require.NoError(t, err)
		assert.Empty(t, cfg.GetTrackedQueries())

		// 3. Verify disk persistence
		reloaded, err := Load(configPath, Overrides{})
		require.NoError(t, err)
		assert.Empty(t, reloaded.GetTrackedQueries())
	})

	t.Run("Clear watched_repos via FieldMask", func(t *testing.T) {
		cfg, err := Load(configPath, Overrides{})
		require.NoError(t, err)

		seed := octodeckv1.Config_builder{
			WatchedRepos: []string{"kubernetes/kubernetes", "golang/go"},
		}.Build()
		err = cfg.UpdateProto(seed, &fieldmaskpb.FieldMask{Paths: []string{"watched_repos"}})
		require.NoError(t, err)
		require.NotEmpty(t, cfg.GetWatchedRepos())

		clearCfg := octodeckv1.Config_builder{WatchedRepos: []string{}}.Build()
		require.NotPanics(t, func() {
			err = cfg.UpdateProto(clearCfg, &fieldmaskpb.FieldMask{Paths: []string{"watched_repos"}})
		})
		require.NoError(t, err)
		assert.Empty(t, cfg.GetWatchedRepos())
	})

	t.Run("Clear excluded_labels via FieldMask", func(t *testing.T) {
		cfg, err := Load(configPath, Overrides{})
		require.NoError(t, err)

		seed := octodeckv1.Config_builder{
			ExcludedLabels: []string{"do-not-merge", "wip"},
		}.Build()
		err = cfg.UpdateProto(seed, &fieldmaskpb.FieldMask{Paths: []string{"excluded_labels"}})
		require.NoError(t, err)
		require.NotEmpty(t, cfg.GetProto().GetExcludedLabels())

		clearCfg := octodeckv1.Config_builder{ExcludedLabels: []string{}}.Build()
		require.NotPanics(t, func() {
			err = cfg.UpdateProto(clearCfg, &fieldmaskpb.FieldMask{Paths: []string{"excluded_labels"}})
		})
		require.NoError(t, err)
		assert.Empty(t, cfg.GetProto().GetExcludedLabels())
	})

	t.Run("Clear all repeated fields simultaneously via FieldMask", func(t *testing.T) {
		cfg, err := Load(configPath, Overrides{})
		require.NoError(t, err)

		// Seed all repeated fields
		seed := octodeckv1.Config_builder{
			WatchedRepos:         []string{"owner/repo"},
			PinnedRepos:          []string{"owner/repo"},
			ExcludedRepos:        []string{"owner/excluded"},
			KnownBots:            []string{botDependabot},
			IncludedLabels:       []string{"sig/node"},
			ExcludedLabels:       []string{"wip"},
			TrackedQueries:       []string{"repo:owner/repo is:open"},
			DiscoveryIntervalMin: Ptr(int32(25)),
		}.Build()
		err = cfg.UpdateProto(seed, nil)
		require.NoError(t, err)

		// Clear all repeated fields using FieldMask
		allListMask := &fieldmaskpb.FieldMask{Paths: []string{
			"watched_repos", "pinned_repos", "excluded_repos",
			"known_bots", "included_labels", "excluded_labels", "tracked_queries",
		}}
		emptyCfg := octodeckv1.Config_builder{}.Build()
		require.NotPanics(t, func() {
			err = cfg.UpdateProto(emptyCfg, allListMask)
		})
		require.NoError(t, err)

		assert.Empty(t, cfg.GetWatchedRepos())
		assert.Empty(t, cfg.GetPinnedRepos())
		assert.Empty(t, cfg.GetExcludedRepos())
		assert.Empty(t, cfg.GetKnownBots())
		assert.Empty(t, cfg.GetProto().GetIncludedLabels())
		assert.Empty(t, cfg.GetProto().GetExcludedLabels())
		assert.Empty(t, cfg.GetTrackedQueries())
		// Ensure scalar field was preserved
		assert.Equal(t, int32(25), cfg.GetDiscoveryIntervalMin())
	})

	t.Run("Support camelCase FieldMask paths", func(t *testing.T) {
		cfg, err := Load(configPath, Overrides{})
		require.NoError(t, err)

		seed := octodeckv1.Config_builder{
			TrackedQueries: []string{"query1"},
			WatchedRepos:   []string{"owner/repo"},
		}.Build()
		err = cfg.UpdateProto(seed, nil)
		require.NoError(t, err)

		clearCfg := octodeckv1.Config_builder{
			TrackedQueries: []string{},
			WatchedRepos:   []string{},
		}.Build()
		camelMask := &fieldmaskpb.FieldMask{Paths: []string{"trackedQueries", "watchedRepos"}}
		require.NotPanics(t, func() {
			err = cfg.UpdateProto(clearCfg, camelMask)
		})
		require.NoError(t, err)
		assert.Empty(t, cfg.GetTrackedQueries())
		assert.Empty(t, cfg.GetWatchedRepos())
	})
}

func TestConfig_RepeatedFieldsSliceImmutability(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config_immutability.json")
	cfg, err := Load(configPath, Overrides{})
	require.NoError(t, err)

	t.Run("Source slice mutation after UpdateProto with FieldMask does not alter config", func(t *testing.T) {
		sourceQueries := []string{"query_original_1", "query_original_2"}
		inputCfg := octodeckv1.Config_builder{
			TrackedQueries: sourceQueries,
		}.Build()

		err := cfg.UpdateProto(inputCfg, &fieldmaskpb.FieldMask{Paths: []string{"tracked_queries"}})
		require.NoError(t, err)
		assert.Equal(t, []string{"query_original_1", "query_original_2"}, cfg.GetTrackedQueries())

		// Mutate source slice in-place
		sourceQueries[0] = "MUTATED_QUERY"
		assert.Equal(t, "query_original_1", cfg.GetTrackedQueries()[0],
			"internal config state must not reflect caller's slice mutation")
		assert.Equal(t, "query_original_1", cfg.GetProto().GetTrackedQueries()[0])
	})

	t.Run("Source slice mutation after full UpdateProto does not alter config", func(t *testing.T) {
		sourceRepos := []string{"orig/repo1", "orig/repo2"}
		inputCfg := octodeckv1.Config_builder{
			WatchedRepos: sourceRepos,
		}.Build()

		err := cfg.UpdateProto(inputCfg, nil)
		require.NoError(t, err)

		sourceRepos[0] = "mutated/repo"
		assert.Equal(t, "orig/repo1", cfg.GetWatchedRepos()[0])
	})

	t.Run("Getter returned slice mutation does not alter config", func(t *testing.T) {
		// Populate config
		err := cfg.UpdateProto(octodeckv1.Config_builder{
			TrackedQueries: []string{"safe_query"},
			WatchedRepos:   []string{"safe/repo"},
		}.Build(), nil)
		require.NoError(t, err)

		// Mutate getter return
		retrieved := cfg.GetTrackedQueries()
		require.NotEmpty(t, retrieved)
		retrieved[0] = "POISONED_QUERY"

		// Next call should return intact original
		fresh := cfg.GetTrackedQueries()
		assert.Equal(t, "safe_query", fresh[0], "modifying getter slice must not mutate stored config")

		// Same for watched repos
		repos := cfg.GetWatchedRepos()
		require.NotEmpty(t, repos)
		repos[0] = "poisoned/repo"
		assert.Equal(t, "safe/repo", cfg.GetWatchedRepos()[0])
	})
}

func TestConfig_RepeatedFieldsFullUpdateClearing(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config_full_clear.json")
	cfg, err := Load(configPath, Overrides{})
	require.NoError(t, err)

	// Seed all fields
	seed := octodeckv1.Config_builder{
		WatchedRepos:         []string{"owner/repo"},
		PinnedRepos:          []string{"owner/repo"},
		ExcludedRepos:        []string{"owner/excluded"},
		KnownBots:            []string{botDependabot},
		IncludedLabels:       []string{"sig/node"},
		ExcludedLabels:       []string{"wip"},
		TrackedQueries:       []string{"repo:owner/repo is:open"},
		DiscoveryIntervalMin: Ptr(int32(15)),
	}.Build()
	err = cfg.UpdateProto(seed, nil)
	require.NoError(t, err)

	// Full update with empty config
	emptyCfg := octodeckv1.Config_builder{
		DiscoveryIntervalMin: Ptr(int32(20)),
	}.Build()
	err = cfg.UpdateProto(emptyCfg, nil)
	require.NoError(t, err)

	assert.Empty(t, cfg.GetTrackedQueries())
	assert.Empty(t, cfg.GetWatchedRepos())
	assert.Empty(t, cfg.GetPinnedRepos())
	assert.Empty(t, cfg.GetExcludedRepos())
	assert.Empty(t, cfg.GetProto().GetIncludedLabels())
	assert.Empty(t, cfg.GetProto().GetExcludedLabels())
	assert.Empty(t, cfg.GetKnownBots())
	assert.Equal(t, int32(20), cfg.GetDiscoveryIntervalMin())

	// Verify disk persistence
	reloaded, err := Load(configPath, Overrides{})
	require.NoError(t, err)
	assert.Empty(t, reloaded.GetTrackedQueries())
	assert.Empty(t, reloaded.GetWatchedRepos())
}

func TestConfig_ZeroPanicReflectionAcrossAllRepeatedFields(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config_reflect.json")
	cfg, err := Load(configPath, Overrides{})
	require.NoError(t, err)

	desc := (&octodeckv1.Config{}).ProtoReflect().Descriptor()
	fields := desc.Fields()

	for i := range fields.Len() {
		fd := fields.Get(i)
		if !fd.IsList() {
			continue
		}

		fieldName := string(fd.Name())
		jsonName := fd.JSONName()

		t.Run(fieldName+"_clearing_via_FieldMask_does_not_panic", func(t *testing.T) {
			// 1. Populate field using reflection
			popCfg := &octodeckv1.Config{}
			popReflect := popCfg.ProtoReflect()
			popList := popReflect.Mutable(fd).List()
			if fd.Kind() == protoreflect.StringKind {
				popList.Append(protoreflect.ValueOfString("entry-1"))
				popList.Append(protoreflect.ValueOfString("entry-2"))
			}
			err := cfg.UpdateProto(popCfg, &fieldmaskpb.FieldMask{Paths: []string{fieldName}})
			require.NoError(t, err)

			// 2. Clear field using empty message and snake_case path
			emptyCfg := &octodeckv1.Config{}
			require.NotPanics(t, func() {
				err = cfg.UpdateProto(emptyCfg, &fieldmaskpb.FieldMask{Paths: []string{fieldName}})
			}, "UpdateProto with snake_case path %q must not panic", fieldName)
			require.NoError(t, err)

			currList := cfg.GetProto().ProtoReflect().Get(fd).List()
			assert.Equal(t, 0, currList.Len(), "field %s should be empty", fieldName)

			// 3. Clear field using camelCase JSON name path
			popList2 := popReflect.Mutable(fd).List()
			if fd.Kind() == protoreflect.StringKind {
				popList2.Append(protoreflect.ValueOfString("entry-camel"))
			}
			_ = cfg.UpdateProto(popCfg, &fieldmaskpb.FieldMask{Paths: []string{jsonName}})
			require.NotPanics(t, func() {
				err = cfg.UpdateProto(emptyCfg, &fieldmaskpb.FieldMask{Paths: []string{jsonName}})
			}, "UpdateProto with camelCase path %q must not panic", jsonName)
			require.NoError(t, err)

			currList2 := cfg.GetProto().ProtoReflect().Get(fd).List()
			assert.Equal(t, 0, currList2.Len(), "field %s should be empty", jsonName)
		})
	}
}

func TestConfig_LegacyMigrationAndCompat(t *testing.T) {
	tempDir := t.TempDir()

	t.Run("Legacy config v0.1.0 without tracked_queries or discovery_interval_min", func(t *testing.T) {
		legacyJSON := `{
  "watchedRepos": ["kubernetes/kubernetes", "google/go-github"],
  "pinnedRepos": ["kubernetes/kubernetes"],
  "excludedRepos": ["kubernetes/test-infra"],
  "pollingIntervalMin": 5,
  "knownBots": ["dependabot", "k8s-ci-robot"],
  "autoAckOwnActivity": true,
  "port": 38274
}`
		configPath := filepath.Join(tempDir, "legacy_v010.json")
		err := os.WriteFile(configPath, []byte(legacyJSON), 0600)
		require.NoError(t, err)

		cfg, err := Load(configPath, Overrides{})
		require.NoError(t, err)

		// Existing fields preserved
		assert.Equal(t, []string{"kubernetes/kubernetes", "google/go-github"}, cfg.GetWatchedRepos())
		assert.Equal(t, []string{"kubernetes/kubernetes"}, cfg.GetPinnedRepos())
		assert.Equal(t, []string{"kubernetes/test-infra"}, cfg.GetExcludedRepos())
		assert.Equal(t, int32(5), cfg.GetPollingIntervalMin())
		assert.Equal(t, 5*time.Minute, cfg.GetSyncInterval())
		assert.True(t, cfg.GetAutoAckOwnActivity())
		assert.Equal(t, 38274, cfg.GetPort())

		// New fields have safe defaults
		assert.Empty(t, cfg.GetTrackedQueries())
		assert.Equal(t, int32(0), cfg.GetDiscoveryIntervalMin())
		assert.Equal(t, DefaultDiscoveryInterval, cfg.GetDiscoveryInterval())
		assert.Equal(t, 10*time.Minute, cfg.GetDiscoveryInterval())

		// Verify re-saving persists without corrupting legacy data
		err = cfg.Save()
		require.NoError(t, err)

		savedBytes, err := os.ReadFile(configPath)
		require.NoError(t, err)
		savedStr := string(savedBytes)
		assert.Contains(t, savedStr, "watchedRepos")
		assert.Contains(t, savedStr, "pollingIntervalMin")

		// Reload to verify persistence
		reloaded, err := Load(configPath, Overrides{})
		require.NoError(t, err)
		assert.Equal(t, cfg.GetWatchedRepos(), reloaded.GetWatchedRepos())
		assert.Equal(t, cfg.GetDiscoveryInterval(), reloaded.GetDiscoveryInterval())
	})

	t.Run("Forward compatibility with unknown future fields", func(t *testing.T) {
		futureJSON := `{
  "watchedRepos": ["kubernetes/kubernetes"],
  "pollingIntervalMin": 10,
  "discoveryIntervalMin": 45,
  "trackedQueries": ["repo:octodeck/octodeck is:pr"],
  "unknownFutureField": "should_be_ignored",
  "experimentalFeatureFlag": true,
  "nestedFutureObject": {"key": "val", "num": 42}
}`
		configPath := filepath.Join(tempDir, "future_config.json")
		err := os.WriteFile(configPath, []byte(futureJSON), 0600)
		require.NoError(t, err, "protojson.UnmarshalOptions{DiscardUnknown: true} must not fail on future fields")

		cfg, err := Load(configPath, Overrides{})
		require.NoError(t, err)

		assert.Equal(t, int32(45), cfg.GetDiscoveryIntervalMin())
		assert.Equal(t, []string{"repo:octodeck/octodeck is:pr"}, cfg.GetTrackedQueries())
		assert.Equal(t, []string{"kubernetes/kubernetes"}, cfg.GetWatchedRepos())
	})

	t.Run("Legacy config with snake_case field names", func(t *testing.T) {
		snakeJSON := `{
  "watched_repos": ["kubernetes/kubernetes"],
  "polling_interval_min": 15,
  "discovery_interval_min": 25,
  "tracked_queries": ["repo:kubernetes/kubernetes is:open label:sig/node"]
}`
		configPath := filepath.Join(tempDir, "snake_config.json")
		err := os.WriteFile(configPath, []byte(snakeJSON), 0600)
		require.NoError(t, err)

		cfg, err := Load(configPath, Overrides{})
		require.NoError(t, err)
		assert.Equal(t, int32(25), cfg.GetDiscoveryIntervalMin())
		assert.Equal(t, []string{"repo:kubernetes/kubernetes is:open label:sig/node"}, cfg.GetTrackedQueries())
		assert.Equal(t, []string{"kubernetes/kubernetes"}, cfg.GetWatchedRepos())
	})

	t.Run("Config with explicit null or empty tracked_queries in JSON", func(t *testing.T) {
		jsonNull := `{
  "watchedRepos": ["kubernetes/kubernetes"],
  "trackedQueries": null,
  "discoveryIntervalMin": 0
}`
		configPath := filepath.Join(tempDir, "null_tracked.json")
		err := os.WriteFile(configPath, []byte(jsonNull), 0600)
		require.NoError(t, err)

		cfg, err := Load(configPath, Overrides{})
		require.NoError(t, err)
		assert.Empty(t, cfg.GetTrackedQueries())
		assert.Equal(t, int32(0), cfg.GetDiscoveryIntervalMin())
		assert.Equal(t, DefaultDiscoveryInterval, cfg.GetDiscoveryInterval())
	})

	t.Run("Config with explicit negative discovery interval in JSON falls back safely", func(t *testing.T) {
		jsonNeg := `{
  "discoveryIntervalMin": -20
}`
		configPath := filepath.Join(tempDir, "neg_discovery.json")
		err := os.WriteFile(configPath, []byte(jsonNeg), 0600)
		require.NoError(t, err)

		cfg, err := Load(configPath, Overrides{})
		require.NoError(t, err)
		assert.Equal(t, int32(-20), cfg.GetDiscoveryIntervalMin())
		assert.Equal(t, DefaultDiscoveryInterval, cfg.GetDiscoveryInterval())
	})

	t.Run("Corrupt/malformed JSON returns error without panicking", func(t *testing.T) {
		malformedJSON := `{"watchedRepos": ["unclosed-bracket"`
		configPath := filepath.Join(tempDir, "malformed.json")
		err := os.WriteFile(configPath, []byte(malformedJSON), 0600)
		require.NoError(t, err)

		cfg, err := Load(configPath, Overrides{})
		require.Error(t, err)
		assert.Nil(t, cfg)
		assert.Contains(t, err.Error(), "failed to parse config file")
	})

	t.Run("Empty JSON object uses defaults", func(t *testing.T) {
		emptyJSON := `{}`
		configPath := filepath.Join(tempDir, "empty.json")
		err := os.WriteFile(configPath, []byte(emptyJSON), 0600)
		require.NoError(t, err)

		cfg, err := Load(configPath, Overrides{})
		require.NoError(t, err)
		assert.Empty(t, cfg.GetTrackedQueries())
		assert.Equal(t, DefaultDiscoveryInterval, cfg.GetDiscoveryInterval())
	})
}

func TestConfig_ConcurrentReadUpdate(t *testing.T) {
	tempDir := t.TempDir()
	cfgPath := filepath.Join(tempDir, "concurrent_config.json")
	cfg, err := Load(cfgPath, Overrides{})
	require.NoError(t, err)

	const numGoroutines = 20
	const numIterations = 100

	var wg sync.WaitGroup
	wg.Add(numGoroutines * 2)

	// Concurrent Readers
	for range numGoroutines {
		go func() {
			defer wg.Done()
			for range numIterations {
				queries := cfg.GetTrackedQueries()
				interval := cfg.GetDiscoveryInterval()
				intervalMin := cfg.GetDiscoveryIntervalMin()
				_ = queries
				_ = interval
				_ = intervalMin
			}
		}()
	}

	// Concurrent Writers
	for i := range numGoroutines {
		idx := i
		go func() {
			defer wg.Done()
			for j := range numIterations {
				newCfg := octodeckv1.Config_builder{
					TrackedQueries: []string{
						"repo:kubernetes/kubernetes",
						"repo:golang/go is:open",
						string(rune('a' + (idx % 26))),
					},
					DiscoveryIntervalMin: Ptr(int32(10 + (j % 50))),
				}.Build()
				_ = cfg.UpdateProto(newCfg, &fieldmaskpb.FieldMask{
					Paths: []string{"tracked_queries", "discovery_interval_min"},
				})
			}
		}()
	}

	wg.Wait()
	require.NotEmpty(t, cfg.GetTrackedQueries())
	require.Positive(t, cfg.GetDiscoveryIntervalMin())
}
