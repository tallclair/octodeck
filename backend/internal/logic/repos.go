package logic

import (
	"fmt"
	"strings"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// FilterItemsByRepo filters a slice of items according to inclusion and exclusion repository patterns.
// If includedPatterns is non-empty, items must match at least one include pattern.
// If excludedPatterns is non-empty, items matching any exclude pattern are removed.
// Exclusion patterns take precedence over inclusion patterns.
// If both are empty, the original items slice is returned unchanged.
func FilterItemsByRepo(items []*octodeckv1.Item, includedPatterns, excludedPatterns []string) []*octodeckv1.Item {
	if len(items) == 0 {
		return nil
	}
	if len(includedPatterns) == 0 && len(excludedPatterns) == 0 {
		return items
	}

	var result []*octodeckv1.Item
	for _, item := range items {
		if item != nil && MatchesFilter(item.GetRepo(), includedPatterns, excludedPatterns) {
			result = append(result, item)
		}
	}
	return result
}

// FilterRepos filters a slice of repository names according to inclusion and exclusion patterns.
// If includedPatterns is non-empty, repos must match at least one include pattern.
// If excludedPatterns is non-empty, repos matching any exclude pattern are removed.
// Exclusion patterns take precedence over inclusion patterns.
func FilterRepos(repos, includedPatterns, excludedPatterns []string) []string {
	if len(repos) == 0 {
		return nil
	}
	if len(includedPatterns) == 0 && len(excludedPatterns) == 0 {
		return repos
	}

	var result []string
	for _, repo := range repos {
		if MatchesFilter(repo, includedPatterns, excludedPatterns) {
			result = append(result, repo)
		}
	}
	return result
}

// ValidateRepoPattern validates a single repository pattern (owner/repo).
func ValidateRepoPattern(pattern string) error {
	trimmed, err := ValidatePatternBase(pattern, "repository")
	if err != nil {
		return err
	}

	// Must contain exactly one slash separating owner and repo
	parts := strings.Split(trimmed, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return fmt.Errorf(
			"repository pattern %q must be in owner/repo format (e.g. kubernetes/* or kubernetes/kubernetes)",
			trimmed,
		)
	}

	for _, r := range trimmed {
		//nolint:staticcheck // more readable this way
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == '-' || r == '_' || r == '.' || r == '/' || r == '*' || r == '?') {
			return fmt.Errorf("repository pattern %q contains invalid character %q", trimmed, string(r))
		}
	}
	return nil
}

// ValidateRepoPatterns validates a list of repository patterns.
func ValidateRepoPatterns(patterns []string) error {
	return ValidatePatterns(patterns, ValidateRepoPattern)
}
