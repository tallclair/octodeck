// Package query implements the dashboard query model: validation and normalisation of the
// structured octodeckv1.Expr tree, in-memory evaluation against items, facet counts, sorting, and
// an SQL prefilter that only ever narrows the candidate set.
//
// See docs/internal/query_model_design.md for the semantics.
package query

import (
	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// Closed-set values. Values are compared case-insensitively; these are the canonical forms.
const (
	valueInbox = "inbox"
	valueAcked = "acked"
	valueAll   = "all"

	valueOpen   = "open"
	valueClosed = "closed"
	valueMerged = "merged"

	valuePR    = "pr"
	valueIssue = "issue"

	valueTrue  = "true"
	valueFalse = "false"

	valueItem    = "item"
	valueMention = "mention"
	valueComment = "comment"
	valueCode    = "code"
	valueNoise   = "noise"
	valueAny     = "any"

	valueAssignee  = "assignee"
	valueLabel     = "label"
	valueMilestone = "milestone"

	valueTitle = "title"
	valueBody  = "body"

	// valueMe is the author/assignee placeholder for the authenticated user.
	valueMe = "@me"
)

// fieldName returns the query-language key for a field, for error messages.
func fieldName(f octodeckv1.Field) string {
	switch f {
	case octodeckv1.Field_FIELD_TRIAGE:
		return "triage"
	case octodeckv1.Field_FIELD_STATE:
		return "state"
	case octodeckv1.Field_FIELD_TYPE:
		return "type"
	case octodeckv1.Field_FIELD_DRAFT:
		return "draft"
	case octodeckv1.Field_FIELD_TRACKING:
		return "tracking"
	case octodeckv1.Field_FIELD_STARRED:
		return "starred"
	case octodeckv1.Field_FIELD_NEW:
		return "new"
	case octodeckv1.Field_FIELD_REPO:
		return "repo"
	case octodeckv1.Field_FIELD_ORG:
		return "org"
	case octodeckv1.Field_FIELD_AUTHOR:
		return "author"
	case octodeckv1.Field_FIELD_ASSIGNEE:
		return "assignee"
	case octodeckv1.Field_FIELD_MILESTONE:
		return "milestone"
	case octodeckv1.Field_FIELD_LABEL:
		return "label"
	case octodeckv1.Field_FIELD_NO:
		return "no"
	case octodeckv1.Field_FIELD_IN:
		return "in"
	case octodeckv1.Field_FIELD_TEXT:
		return "text"
	case octodeckv1.Field_FIELD_UNSPECIFIED:
		return "unspecified"
	}
	return "unknown"
}

// knownField reports whether f is a field the server understands (not UNSPECIFIED or an unknown
// enum number).
func knownField(f octodeckv1.Field) bool {
	switch f {
	case octodeckv1.Field_FIELD_TRIAGE, octodeckv1.Field_FIELD_STATE, octodeckv1.Field_FIELD_TYPE,
		octodeckv1.Field_FIELD_DRAFT, octodeckv1.Field_FIELD_TRACKING, octodeckv1.Field_FIELD_STARRED,
		octodeckv1.Field_FIELD_NEW, octodeckv1.Field_FIELD_REPO, octodeckv1.Field_FIELD_ORG,
		octodeckv1.Field_FIELD_AUTHOR, octodeckv1.Field_FIELD_ASSIGNEE, octodeckv1.Field_FIELD_MILESTONE,
		octodeckv1.Field_FIELD_LABEL, octodeckv1.Field_FIELD_NO, octodeckv1.Field_FIELD_IN,
		octodeckv1.Field_FIELD_TEXT:
		return true
	case octodeckv1.Field_FIELD_UNSPECIFIED:
		return false
	}
	return false
}

// ClosedValues returns the legal values of a closed field in vocabulary order, and whether the
// field is closed. Open fields (repo, org, author, assignee, milestone, label, text) accept any
// non-empty value.
func ClosedValues(f octodeckv1.Field) ([]string, bool) {
	switch f {
	case octodeckv1.Field_FIELD_TRIAGE:
		return []string{valueInbox, valueAcked, valueAll}, true
	case octodeckv1.Field_FIELD_STATE:
		return []string{valueOpen, valueClosed, valueMerged}, true
	case octodeckv1.Field_FIELD_TYPE:
		return []string{valuePR, valueIssue}, true
	case octodeckv1.Field_FIELD_DRAFT, octodeckv1.Field_FIELD_TRACKING, octodeckv1.Field_FIELD_STARRED:
		return []string{valueTrue, valueFalse}, true
	case octodeckv1.Field_FIELD_NEW:
		return []string{valueItem, valueMention, valueComment, valueCode, valueNoise, valueAny}, true
	case octodeckv1.Field_FIELD_NO:
		return []string{valueAssignee, valueLabel, valueMilestone}, true
	case octodeckv1.Field_FIELD_IN:
		return []string{valueTitle, valueBody}, true
	case octodeckv1.Field_FIELD_REPO, octodeckv1.Field_FIELD_ORG, octodeckv1.Field_FIELD_AUTHOR,
		octodeckv1.Field_FIELD_ASSIGNEE, octodeckv1.Field_FIELD_MILESTONE, octodeckv1.Field_FIELD_LABEL,
		octodeckv1.Field_FIELD_TEXT, octodeckv1.Field_FIELD_UNSPECIFIED:
		return nil, false
	}
	return nil, false
}
