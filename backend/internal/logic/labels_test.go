package logic

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

func TestFilterLabels(t *testing.T) {
	makeLabel := func(name string) *octodeckv1.Label {
		return octodeckv1.Label_builder{
			Name:  config.Ptr(name),
			Color: config.Ptr("ffffff"),
		}.Build()
	}

	labels := []*octodeckv1.Label{
		makeLabel("size/small"),
		makeLabel("size/large"),
		makeLabel("kind/bug"),
		makeLabel("sig/node"),
		makeLabel("do-not-merge/hold"),
	}

	t.Run("no filter", func(t *testing.T) {
		filtered := FilterLabels(labels, nil, nil)
		require.Len(t, filtered, 5)
	})

	t.Run("include mode", func(t *testing.T) {
		filtered := FilterLabels(labels, []string{"size/*", "kind/*"}, nil)
		require.Len(t, filtered, 3)
		assert.Equal(t, "size/small", filtered[0].GetName())
		assert.Equal(t, "size/large", filtered[1].GetName())
		assert.Equal(t, "kind/bug", filtered[2].GetName())
	})

	t.Run("exclude mode", func(t *testing.T) {
		filtered := FilterLabels(labels, nil, []string{"do-not-merge/*", "size/*"})
		require.Len(t, filtered, 2)
		assert.Equal(t, "kind/bug", filtered[0].GetName())
		assert.Equal(t, "sig/node", filtered[1].GetName())
	})

	t.Run("combined include and exclude with exclude precedence", func(t *testing.T) {
		// Include size/* and sig/*, but exclude size/large
		filtered := FilterLabels(labels, []string{"size/*", "sig/*"}, []string{"size/large"})
		require.Len(t, filtered, 2)
		assert.Equal(t, "size/small", filtered[0].GetName())
		assert.Equal(t, "sig/node", filtered[1].GetName())
	})
}

func TestValidateLabelPatterns(t *testing.T) {
	require.NoError(t, ValidateLabelPatterns([]string{"size/*", "kind/bug", "sig/*", "!kind/flake"}))
	require.NoError(t, ValidateLabelPatterns([]string{"", "  "})) // empty ignored

	require.Error(t, ValidateLabelPattern(""))
	require.Error(t, ValidateLabelPattern("!"))
	require.Error(t, ValidateLabelPattern("   "))
	require.Error(t, ValidateLabelPattern("size/\nlarge"))
}
