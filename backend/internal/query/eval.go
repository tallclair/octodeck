package query

import (
	"slices"
	"strings"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// Match reports whether the view matches the query, including the implicit triage:inbox scope.
func (q *Query) Match(v *View) bool {
	if q.implicitInbox && v.Activity.Acked {
		return false
	}
	return q.evalNode(q.root, v)
}

// Filter returns the views that match the query, preserving order.
func (q *Query) Filter(views []*View) []*View {
	out := make([]*View, 0, len(views))
	for _, v := range views {
		if q.Match(v) {
			out = append(out, v)
		}
	}
	return out
}

func (q *Query) evalNode(n *Node, v *View) bool {
	switch n.Kind {
	case KindTrue:
		return true
	case KindFalse:
		return false
	case KindPredicate:
		return q.evalPredicate(n.Pred, v)
	case KindAnd:
		for _, c := range n.Children {
			if !q.evalNode(c, v) {
				return false
			}
		}
		return true
	case KindOr:
		for _, c := range n.Children {
			if q.evalNode(c, v) {
				return true
			}
		}
		return false
	case KindNot:
		return !q.evalNode(n.Children[0], v)
	}
	return false
}

// evalPredicate ORs the predicate's values and applies negation to the whole OR.
func (q *Query) evalPredicate(p *Predicate, v *View) bool {
	if p.Field == octodeckv1.Field_FIELD_IN {
		// in only selects the fields searched by free text; on its own it matches everything.
		// Validation guarantees it is top level and not negated.
		return true
	}
	matched := false
	for _, val := range p.Values {
		if q.matchValue(p.Field, val, v) {
			matched = true
			break
		}
	}
	return matched != p.Negated
}

// matchValue reports whether the view has the canonical value val for field.
func (q *Query) matchValue(field octodeckv1.Field, val string, v *View) bool {
	it := v.Item
	switch field {
	case octodeckv1.Field_FIELD_TRIAGE:
		return matchTriage(val, v)
	case octodeckv1.Field_FIELD_STATE:
		return matchState(val, it.GetState())
	case octodeckv1.Field_FIELD_TYPE:
		return matchType(val, it)
	case octodeckv1.Field_FIELD_DRAFT:
		return it.GetIsDraft() == (val == valueTrue)
	case octodeckv1.Field_FIELD_TRACKING:
		return isTracked(it) == (val == valueTrue)
	case octodeckv1.Field_FIELD_STARRED:
		return it.GetLocal().GetStarred() == (val == valueTrue)
	case octodeckv1.Field_FIELD_NEW:
		return matchNew(val, v)
	case octodeckv1.Field_FIELD_REPO:
		return identEqual(it.GetRepo(), val)
	case octodeckv1.Field_FIELD_ORG:
		return strings.HasPrefix(identKey(it.GetRepo()), identKey(val)+"/")
	case octodeckv1.Field_FIELD_AUTHOR:
		return identEqual(it.GetAuthor().GetLogin(), val)
	case octodeckv1.Field_FIELD_ASSIGNEE:
		return slices.ContainsFunc(it.GetAssignees(), func(u *octodeckv1.User) bool {
			return identEqual(u.GetLogin(), val)
		})
	case octodeckv1.Field_FIELD_MILESTONE:
		return textKey(milestoneTitle(it)) == textKey(val)
	case octodeckv1.Field_FIELD_LABEL:
		return slices.ContainsFunc(it.GetLabels(), func(l *octodeckv1.Label) bool {
			return textKey(labelName(l)) == textKey(val)
		})
	case octodeckv1.Field_FIELD_NO:
		return matchNo(val, it)
	case octodeckv1.Field_FIELD_TEXT:
		return matchText(v, val, q.text)
	case octodeckv1.Field_FIELD_IN, octodeckv1.Field_FIELD_UNSPECIFIED:
		return false
	}
	return false
}

func matchTriage(val string, v *View) bool {
	switch val {
	case valueInbox:
		return !v.Activity.Acked
	case valueAcked:
		return v.Activity.Acked
	}
	return false
}

// matchState treats an unspecified state as open and merged items as closed, as the dashboard
// always has.
func matchState(val string, s octodeckv1.ItemState) bool {
	switch val {
	case valueOpen:
		return s == octodeckv1.ItemState_ITEM_STATE_OPEN || s == octodeckv1.ItemState_ITEM_STATE_UNSPECIFIED
	case valueClosed:
		return s == octodeckv1.ItemState_ITEM_STATE_CLOSED || s == octodeckv1.ItemState_ITEM_STATE_MERGED
	case valueMerged:
		return s == octodeckv1.ItemState_ITEM_STATE_MERGED
	}
	return false
}

// matchType falls back to the URL for items whose type isn't recorded (older rows).
func matchType(val string, it *octodeckv1.Item) bool {
	t := it.GetType()
	switch val {
	case valuePR:
		return t == octodeckv1.ItemType_ITEM_TYPE_PR ||
			(t != octodeckv1.ItemType_ITEM_TYPE_ISSUE && strings.Contains(it.GetUrl(), "/pull/"))
	case valueIssue:
		return t == octodeckv1.ItemType_ITEM_TYPE_ISSUE ||
			(t != octodeckv1.ItemType_ITEM_TYPE_PR && strings.Contains(it.GetUrl(), "/issues/"))
	}
	return false
}

// isTracked reports whether the viewer is subscribed (or the subscription is unknown or ignored).
func isTracked(it *octodeckv1.Item) bool {
	return it.GetViewerSubscription() != octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED
}

func matchNew(val string, v *View) bool {
	a := v.Activity
	switch val {
	case valueItem:
		return a.Item
	case valueMention:
		return a.Mention
	case valueComment:
		return a.Comment
	case valueCode:
		return a.Code
	case valueNoise:
		return a.Noise
	case valueAny:
		return a.Any()
	}
	return false
}

func matchNo(val string, it *octodeckv1.Item) bool {
	switch val {
	case valueAssignee:
		return len(it.GetAssignees()) == 0
	case valueLabel:
		return len(it.GetLabels()) == 0
	case valueMilestone:
		return milestoneTitle(it) == ""
	}
	return false
}

// milestoneTitle returns the item's milestone title, or "" if it has none. The title is compared
// as stored (not trimmed), as the dashboard always has.
func milestoneTitle(it *octodeckv1.Item) string {
	return it.GetMilestone().GetTitle()
}

// labelName returns a label's name trimmed of surrounding whitespace, the same normalisation
// query values get, so every listed label value can be selected.
func labelName(l *octodeckv1.Label) string {
	return strings.TrimSpace(l.GetName())
}

// identKey folds a GitHub identifier with ASCII-only case folding. This matches SQLite's NOCASE
// collation and LIKE, so the SQL prefilter can translate identity predicates exactly; GitHub logins
// and repository names are ASCII anyway.
func identKey(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

func identEqual(a, b string) bool {
	return a != "" && identKey(a) == identKey(b)
}

// textKey folds a free-form name (label, milestone) for case-insensitive comparison.
func textKey(s string) string {
	return strings.ToLower(s)
}
