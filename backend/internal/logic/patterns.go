package logic

import (
	"fmt"
	"strings"
	"unicode"
)

// MaxPatternLength is the maximum allowed length of a filter pattern string.
const MaxPatternLength = 100

// MatchWildcard performs case-insensitive wildcard matching where '*' matches
// zero or more characters and '?' matches any single character.
func MatchWildcard(pattern, text string) bool {
	pattern = strings.ToLower(pattern)
	text = strings.ToLower(text)

	pLen := len(pattern)
	tLen := len(text)
	pIdx, tIdx := 0, 0
	starIdx, matchIdx := -1, 0

	for tIdx < tLen {
		switch {
		case pIdx < pLen && (pattern[pIdx] == '?' || pattern[pIdx] == text[tIdx]):
			pIdx++
			tIdx++
		case pIdx < pLen && pattern[pIdx] == '*':
			starIdx = pIdx
			matchIdx = tIdx
			pIdx++
		case starIdx != -1:
			pIdx = starIdx + 1
			matchIdx++
			tIdx = matchIdx
		default:
			return false
		}
	}

	for pIdx < pLen && pattern[pIdx] == '*' {
		pIdx++
	}

	return pIdx == pLen
}

// CleanPatterns trims whitespace from pattern strings, strips optional '!', and filters out empty entries.
func CleanPatterns(patterns []string) []string {
	var cleaned []string
	for _, p := range patterns {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			cleaned = append(cleaned, strings.TrimPrefix(trimmed, "!"))
		}
	}
	return cleaned
}

// MatchesAnyPattern returns true if text matches any wildcard pattern in the list.
func MatchesAnyPattern(text string, patterns []string) bool {
	for _, pat := range patterns {
		if MatchWildcard(pat, text) {
			return true
		}
	}
	return false
}

// MatchesFilter checks if a given text is allowed by the provided include and exclude patterns.
// If includedPatterns is non-empty, text must match at least one include pattern.
// If excludedPatterns is non-empty, matching any exclude pattern rejects the text.
// Exclusion patterns take precedence over inclusion patterns.
func MatchesFilter(text string, includedPatterns, excludedPatterns []string) bool {
	activeIncludes := CleanPatterns(includedPatterns)
	activeExcludes := CleanPatterns(excludedPatterns)

	if len(activeIncludes) > 0 && !MatchesAnyPattern(text, activeIncludes) {
		return false
	}
	if len(activeExcludes) > 0 && MatchesAnyPattern(text, activeExcludes) {
		return false
	}
	return true
}

// ValidatePatternBase validates standard pattern length and control character constraints.
// Strips optional leading '!' and whitespace before checking.
func ValidatePatternBase(pattern, patternType string) (string, error) {
	trimmed := strings.TrimSpace(pattern)
	trimmed = strings.TrimPrefix(trimmed, "!")
	trimmed = strings.TrimSpace(trimmed)
	if trimmed == "" {
		return "", fmt.Errorf("%s pattern cannot be empty", patternType)
	}
	if len(trimmed) > MaxPatternLength {
		return "", fmt.Errorf("%s pattern %q exceeds maximum length of %d characters",
			patternType, trimmed, MaxPatternLength)
	}
	for _, r := range trimmed {
		if unicode.IsControl(r) {
			return "", fmt.Errorf("%s pattern %q contains invalid control characters", patternType, trimmed)
		}
	}
	return trimmed, nil
}

// ValidatePatterns validates a list of patterns using the provided validator function.
func ValidatePatterns(patterns []string, validateFn func(string) error) error {
	for _, p := range patterns {
		if strings.TrimSpace(p) == "" {
			continue
		}
		if err := validateFn(p); err != nil {
			return err
		}
	}
	return nil
}
