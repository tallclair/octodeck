package logic

import (
	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// FilterLabels filters a slice of labels according to inclusion and exclusion patterns.
// If includedPatterns is non-empty, labels must match at least one include pattern.
// If excludedPatterns is non-empty, labels matching any exclude pattern are removed.
// Exclusion patterns take precedence over inclusion patterns.
// If both are empty, the original labels slice is returned unchanged.
func FilterLabels(labels []*octodeckv1.Label, includedPatterns, excludedPatterns []string) []*octodeckv1.Label {
	if len(labels) == 0 {
		return nil
	}
	if len(includedPatterns) == 0 && len(excludedPatterns) == 0 {
		return labels
	}

	var result []*octodeckv1.Label
	for _, label := range labels {
		if label != nil && MatchesFilter(label.GetName(), includedPatterns, excludedPatterns) {
			result = append(result, label)
		}
	}
	return result
}

// ValidateLabelPattern validates a single label pattern.
func ValidateLabelPattern(pattern string) error {
	_, err := ValidatePatternBase(pattern, "label")
	return err
}

// ValidateLabelPatterns validates a list of label patterns.
func ValidateLabelPatterns(patterns []string) error {
	return ValidatePatterns(patterns, ValidateLabelPattern)
}
