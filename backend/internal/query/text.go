package query

import (
	"strconv"
	"strings"
)

// matchText matches one free-text term (design §4.5). The term is a case-insensitive substring of
// the selected text fields (title and body by default, narrowed by in:); a phrase containing
// spaces must appear contiguously. A term of the form "123" or "#123" also matches item number 123,
// regardless of in:; items without a number (0) never match by number. Repository, author, label
// and milestone names are never searched.
func matchText(v *View, term string, tf textFields) bool {
	if n, ok := parseItemNumber(term); ok && n > 0 && int64(v.Item.GetNumber()) == n {
		return true
	}
	t := strings.ToLower(term)
	return (tf.title && strings.Contains(v.lowerTitle(), t)) || (tf.body && strings.Contains(v.lowerBody(), t))
}

// parseItemNumber parses "123" or "#123".
func parseItemNumber(term string) (int64, bool) {
	s := strings.TrimPrefix(term, "#")
	if s == "" {
		return 0, false
	}
	for i := range len(s) {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseInt(s, 10, 32)
	if err != nil {
		return 0, false
	}
	return n, true
}
