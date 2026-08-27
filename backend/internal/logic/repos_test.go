package logic

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

func TestValidateRepoPattern(t *testing.T) {
	tests := []struct {
		name    string
		pattern string
		wantErr bool
	}{
		{"valid exact repo", "kubernetes/kubernetes", false},
		{"valid wildcard repo", "kubernetes/*", false},
		{"valid wildcard org", "*/website", false},
		{"valid wildcard both", "*/*", false},
		{"valid prefix wildcard", "kubernetes/test-*", false},
		{"valid dots and hyphens", "k8s.io/release-1.28", false},
		{"valid exclude with exclamation", "!kubernetes/steering", false},
		{"empty string", "", true},
		{"only exclamation", "!", true},
		{"no slash", "kubernetes", true},
		{"too many slashes", "a/b/c", true},
		{"leading slash", "/kubernetes", true},
		{"trailing slash", "kubernetes/", true},
		{"invalid characters", "kubernetes/foo$bar", true},
		{"spaces inside", "kubernetes / kubernetes", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateRepoPattern(tt.pattern)
			if tt.wantErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestValidateRepoPatterns(t *testing.T) {
	require.NoError(t, ValidateRepoPatterns([]string{
		"kubernetes/*",
		"golang/go",
		"rust-lang/*",
		"!kubernetes/steering",
	}))
	require.NoError(t, ValidateRepoPatterns([]string{"", "  "})) // empty ignored
	require.Error(t, ValidateRepoPatterns([]string{"valid/repo", "invalid"}))
}

func TestFilterItemsByRepo(t *testing.T) {
	item1 := octodeckv1.Item_builder{Id: config.Ptr("1"), Repo: config.Ptr("kubernetes/kubernetes")}.Build()
	item2 := octodeckv1.Item_builder{Id: config.Ptr("2"), Repo: config.Ptr("kubernetes/website")}.Build()
	item3 := octodeckv1.Item_builder{Id: config.Ptr("3"), Repo: config.Ptr("golang/go")}.Build()
	item4 := octodeckv1.Item_builder{Id: config.Ptr("4"), Repo: config.Ptr("kubernetes/test-infra")}.Build()

	items := []*octodeckv1.Item{item1, item2, item3, item4}

	t.Run("empty patterns returns all items", func(t *testing.T) {
		res := FilterItemsByRepo(items, nil, nil)
		assert.Equal(t, items, res)
	})

	t.Run("include wildcard org keeps matching items", func(t *testing.T) {
		res := FilterItemsByRepo(items, []string{"kubernetes/*"}, nil)
		require.Len(t, res, 3)
		assert.Equal(t, "1", res[0].GetId())
		assert.Equal(t, "2", res[1].GetId())
		assert.Equal(t, "4", res[2].GetId())
	})

	t.Run("include multiple patterns", func(t *testing.T) {
		res := FilterItemsByRepo(items, []string{"kubernetes/website", "golang/*"}, nil)
		require.Len(t, res, 2)
		assert.Equal(t, "2", res[0].GetId())
		assert.Equal(t, "3", res[1].GetId())
	})

	t.Run("exclude wildcard pattern removes matching items", func(t *testing.T) {
		res := FilterItemsByRepo(items, nil, []string{"kubernetes/test-*", "golang/*"})
		require.Len(t, res, 2)
		assert.Equal(t, "1", res[0].GetId())
		assert.Equal(t, "2", res[1].GetId())
	})

	t.Run("combined include and exclude patterns with exclude precedence", func(t *testing.T) {
		// Include all kubernetes repos EXCEPT test-infra
		res := FilterItemsByRepo(items, []string{"kubernetes/*"}, []string{"kubernetes/test-infra"})
		require.Len(t, res, 2)
		assert.Equal(t, "1", res[0].GetId())
		assert.Equal(t, "2", res[1].GetId())
	})
}

func TestFilterRepos(t *testing.T) {
	repos := []string{"kubernetes/kubernetes", "kubernetes/website", "golang/go", "kubernetes/test-infra"}

	t.Run("include filter", func(t *testing.T) {
		res := FilterRepos(repos, []string{"kubernetes/*"}, nil)
		assert.Equal(t, []string{"kubernetes/kubernetes", "kubernetes/website", "kubernetes/test-infra"}, res)
	})

	t.Run("exclude filter", func(t *testing.T) {
		res := FilterRepos(repos, nil, []string{"kubernetes/test-infra", "golang/*"})
		assert.Equal(t, []string{"kubernetes/kubernetes", "kubernetes/website"}, res)
	})

	t.Run("combined include and exclude filter", func(t *testing.T) {
		res := FilterRepos(repos, []string{"kubernetes/*", "golang/*"}, []string{"kubernetes/test-infra", "golang/go"})
		assert.Equal(t, []string{"kubernetes/kubernetes", "kubernetes/website"}, res)
	})
}
