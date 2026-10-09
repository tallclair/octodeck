package logic

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMatchWildcard(t *testing.T) {
	tests := []struct {
		pattern string
		text    string
		match   bool
	}{
		{"*", "anything", true},
		{"*/*", "owner/repo", true},
		{"kubernetes/*", "kubernetes/kubernetes", true},
		{"kubernetes/*", "golang/go", false},
		{"size/?", "size/s", true},
		{"size/?", "size/medium", false},
		{"*bug*", "kind/bug/fix", true},
		{"exact-match", "exact-match", true},
		{"EXACT-MATCH", "exact-match", true},
		{"exact-match", "EXACT-MATCH", true},
	}

	for _, tt := range tests {
		t.Run(tt.pattern+"_"+tt.text, func(t *testing.T) {
			assert.Equal(t, tt.match, MatchWildcard(tt.pattern, tt.text))
		})
	}
}

func TestMatchesFilter(t *testing.T) {
	// Empty patterns allow everything
	assert.True(t, MatchesFilter("kubernetes/kubernetes", nil, nil))
	assert.True(t, MatchesFilter("kubernetes/kubernetes", []string{}, []string{}))

	// Include patterns
	assert.True(t, MatchesFilter("kubernetes/kubernetes", []string{"kubernetes/*"}, nil))
	assert.False(t, MatchesFilter("golang/go", []string{"kubernetes/*"}, nil))

	// Exclude patterns
	assert.True(t, MatchesFilter("kubernetes/kubernetes", nil, []string{"kubernetes/test-infra"}))
	assert.False(t, MatchesFilter("kubernetes/test-infra", nil, []string{"kubernetes/test-infra"}))

	// Combined include and exclude (exclude wins)
	includes := []string{"kubernetes/*", "golang/*"}
	excludes := []string{"kubernetes/steering", "golang/proposal"}

	assert.True(t, MatchesFilter("kubernetes/kubernetes", includes, excludes))
	assert.True(t, MatchesFilter("golang/go", includes, excludes))
	assert.False(t, MatchesFilter("kubernetes/steering", includes, excludes))
	assert.False(t, MatchesFilter("golang/proposal", includes, excludes))
	assert.False(t, MatchesFilter("rust-lang/rust", includes, excludes))
}

func TestValidatePatternBase(t *testing.T) {
	// Valid patterns
	clean, err := ValidatePatternBase("kubernetes/*", "test")
	require.NoError(t, err)
	assert.Equal(t, "kubernetes/*", clean)

	// Handles ! prefix
	clean, err = ValidatePatternBase("!kubernetes/steering", "test")
	require.NoError(t, err)
	assert.Equal(t, "kubernetes/steering", clean)

	// Empty errors
	_, err = ValidatePatternBase("", "test")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "test pattern cannot be empty")

	_, err = ValidatePatternBase("!  ", "test")
	require.Error(t, err)

	// Control characters error
	_, err = ValidatePatternBase("invalid\x00pattern", "test")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "contains invalid control characters")

	// Max length
	longStr := strings.Repeat("a", MaxPatternLength+5)
	_, err = ValidatePatternBase(longStr, "test")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "exceeds maximum length")
}

func TestValidatePatterns(t *testing.T) {
	err := ValidatePatterns([]string{"a", "b", ""}, func(p string) error {
		return nil
	})
	require.NoError(t, err)

	err = ValidatePatterns([]string{"a", "invalid"}, func(p string) error {
		if p == "invalid" {
			return assert.AnError
		}
		return nil
	})
	require.ErrorIs(t, err, assert.AnError)
}

func TestMatchesAnyValueFilter(t *testing.T) {
	labels := []string{"kind/bug", "area/kubelet"}
	tests := []struct {
		name               string
		values             []string
		includes, excludes []string
		want               bool
	}{
		{name: "no patterns", values: labels, want: true},
		{name: "no values, no patterns", want: true},
		{name: "include matches one value", values: labels, includes: []string{"area/*"}, want: true},
		{name: "include matches no value", values: labels, includes: []string{"sig/*"}, want: false},
		{name: "include with no values", includes: []string{"sig/*"}, want: false},
		{name: "exclude matches one value", values: labels, excludes: []string{"kind/*"}, want: false},
		{
			name: "exclude wins over include", values: labels,
			includes: []string{"area/*"}, excludes: []string{"kind/bug"},
		},
		{name: "blank patterns are ignored", values: labels, includes: []string{" "}, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, MatchesAnyValueFilter(tt.values, tt.includes, tt.excludes))
		})
	}
}
