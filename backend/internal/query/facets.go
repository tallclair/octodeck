package query

import (
	"cmp"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/logic"
)

// ErrInvalidFacetField is returned (wrapped) for a facet field that can't be faceted.
var ErrInvalidFacetField = errors.New("invalid facet field")

// ValidateFacetFields checks that every requested field can be faceted. Free text, in: and
// unspecified or unknown fields have no value set to count.
func ValidateFacetFields(fields []octodeckv1.Field) error {
	for i, f := range fields {
		if !facetable(f) {
			return fmt.Errorf("%w: fields[%d] is %s (%d)", ErrInvalidFacetField, i, fieldName(f), int32(f))
		}
	}
	return nil
}

func facetable(f octodeckv1.Field) bool {
	return knownField(f) && f != octodeckv1.Field_FIELD_IN && f != octodeckv1.Field_FIELD_TEXT
}

// WithoutTopLevel returns a copy of the query with the field's own top-level predicates removed:
// the root predicate, or the direct predicate children of a root and, negated or not (a not
// wrapping a predicate counts as the predicate). Nested occurrences are kept. Removing the triage
// field also drops the implicit triage:inbox scope, so the triage facet counts both inbox and
// acked items; for other fields the scope is unchanged. An unknown or unspecified field removes
// nothing.
func (q *Query) WithoutTopLevel(field octodeckv1.Field) *Query {
	out := *q
	if !knownField(field) {
		// Composite nodes report FIELD_UNSPECIFIED, so they must not be matched against it.
		return &out
	}
	switch q.root.Kind {
	case KindAnd:
		kept := make([]*Node, 0, len(q.root.Children))
		for _, c := range q.root.Children {
			if c.field() != field {
				kept = append(kept, c)
			}
		}
		switch {
		case len(kept) == 0:
			out.root = &Node{Kind: KindTrue}
		case len(kept) != len(q.root.Children):
			out.root = &Node{Kind: KindAnd, Children: kept}
		}
	case KindPredicate, KindFalse, KindNot:
		if q.root.field() == field {
			out.root = &Node{Kind: KindTrue}
		}
	case KindTrue, KindOr:
	}
	if field == octodeckv1.Field_FIELD_TRIAGE {
		out.implicitInbox = false
	}
	return &out
}

// facetValue accumulates one value of a field's universe.
type facetValue struct {
	display  string
	color    string
	latestMs int64
	count    int32
}

// facetUniverse is every value of a field across all items, keyed by folded value.
type facetUniverse struct {
	values map[string]*facetValue
	order  []string // keys, in output order
}

// Facets counts, for each requested field (in request order, duplicates echoed), every value of
// the field across views, with the number of views that match the query once the field's own
// top-level predicates are removed (see WithoutTopLevel). Values with no matching view are listed
// with count 0.
//
// views is the whole universe: every stored item after the configured repository and label
// filters. Value metadata (label color, repository latest activity) is computed over the whole
// universe and doesn't depend on the query. Closed-field values are listed in vocabulary order.
// Open-field values are grouped with the same case folding the evaluator uses, sorted by folded
// value, and displayed with the casing of the most recently updated item that has them.
func Facets(q *Query, views []*View, fields []octodeckv1.Field) ([]*octodeckv1.Facet, error) {
	if err := ValidateFacetFields(fields); err != nil {
		return nil, err
	}
	ordered := slices.Clone(views)
	slices.SortStableFunc(ordered, func(a, b *View) int {
		ua, ub := logic.ProtoMs(a.Item.GetUpdatedAt()), logic.ProtoMs(b.Item.GetUpdatedAt())
		if ua != ub {
			return cmp.Compare(ub, ua)
		}
		return strings.Compare(a.Item.GetId(), b.Item.GetId())
	})

	var baseMatched []*View
	var baseComputed bool
	out := make([]*octodeckv1.Facet, 0, len(fields))
	for _, field := range fields {
		u := buildUniverse(field, ordered)
		stripped := q.WithoutTopLevel(field)
		var matched []*View
		if stripped.root == q.root && stripped.implicitInbox == q.implicitInbox {
			if !baseComputed {
				baseMatched = q.Filter(views)
				baseComputed = true
			}
			matched = baseMatched
		} else {
			matched = stripped.Filter(views)
		}
		for _, v := range matched {
			for _, key := range facetKeys(field, v) {
				u.values[key].count++
			}
		}
		out = append(out, u.facet(field))
	}
	return out, nil
}

// buildUniverse collects the value universe of field. Closed fields list their vocabulary
// (without the meta values triage:all and new:any); open fields list the distinct values present.
func buildUniverse(field octodeckv1.Field, ordered []*View) *facetUniverse {
	u := &facetUniverse{values: map[string]*facetValue{}}
	if allowed, closed := ClosedValues(field); closed {
		for _, val := range allowed {
			if isMetaValue(field, val) {
				continue
			}
			u.values[val] = &facetValue{display: val}
			u.order = append(u.order, val)
		}
		return u
	}
	for _, v := range ordered {
		for _, raw := range openValues(field, v.Item) {
			key := foldOpen(field, raw.value)
			fv, ok := u.values[key]
			if !ok {
				fv = &facetValue{display: raw.value, color: raw.color}
				u.values[key] = fv
				u.order = append(u.order, key)
			}
			if field == octodeckv1.Field_FIELD_REPO {
				fv.latestMs = max(fv.latestMs, logic.LatestNonNoiseActivityMs(v.Item))
			}
		}
	}
	slices.SortFunc(u.order, func(a, b string) int {
		if c := strings.Compare(a, b); c != 0 {
			return c
		}
		return strings.Compare(u.values[a].display, u.values[b].display)
	})
	return u
}

func (u *facetUniverse) facet(field octodeckv1.Field) *octodeckv1.Facet {
	values := make([]*octodeckv1.FacetValue, 0, len(u.order))
	for _, key := range u.order {
		fv := u.values[key]
		b := octodeckv1.FacetValue_builder{Value: &fv.display, Count: &fv.count}
		if fv.color != "" {
			b.Color = &fv.color
		}
		if fv.latestMs > 0 {
			b.LatestActivityAt = timestamppb.New(time.UnixMilli(fv.latestMs))
		}
		values = append(values, b.Build())
	}
	return octodeckv1.Facet_builder{Field: &field, Values: values}.Build()
}

// isMetaValue reports whether a closed value stands for a combination of other values rather than
// a value items have.
func isMetaValue(field octodeckv1.Field, val string) bool {
	return (field == octodeckv1.Field_FIELD_TRIAGE && val == valueAll) ||
		(field == octodeckv1.Field_FIELD_NEW && val == valueAny)
}

// facetKeys returns the distinct universe keys the view contributes to for field. For closed
// fields this is decided by the evaluator itself, so counts always agree with filtering.
func facetKeys(field octodeckv1.Field, v *View) []string {
	if allowed, closed := ClosedValues(field); closed {
		var keys []string
		var q Query
		for _, val := range allowed {
			if !isMetaValue(field, val) && q.matchValue(field, val, v) {
				keys = append(keys, val)
			}
		}
		return keys
	}
	var keys []string
	for _, raw := range openValues(field, v.Item) {
		key := foldOpen(field, raw.value)
		if !slices.Contains(keys, key) {
			keys = append(keys, key)
		}
	}
	return keys
}

type openValue struct {
	value string
	color string // labels only
}

// openValues returns the item's raw values for an open field. Empty values are skipped.
func openValues(field octodeckv1.Field, it *octodeckv1.Item) []openValue {
	var out []openValue
	add := func(val, color string) {
		if val != "" {
			out = append(out, openValue{value: val, color: color})
		}
	}
	switch field {
	case octodeckv1.Field_FIELD_REPO:
		add(it.GetRepo(), "")
	case octodeckv1.Field_FIELD_ORG:
		if owner, _, ok := strings.Cut(it.GetRepo(), "/"); ok {
			add(owner, "")
		}
	case octodeckv1.Field_FIELD_AUTHOR:
		add(it.GetAuthor().GetLogin(), "")
	case octodeckv1.Field_FIELD_ASSIGNEE:
		for _, u := range it.GetAssignees() {
			add(u.GetLogin(), "")
		}
	case octodeckv1.Field_FIELD_MILESTONE:
		// A whitespace-only title can't be selected (query values are trimmed), so it isn't listed.
		if title := milestoneTitle(it); strings.TrimSpace(title) != "" {
			add(title, "")
		}
	case octodeckv1.Field_FIELD_LABEL:
		for _, l := range it.GetLabels() {
			add(labelName(l), l.GetColor())
		}
	case octodeckv1.Field_FIELD_UNSPECIFIED, octodeckv1.Field_FIELD_TRIAGE, octodeckv1.Field_FIELD_STATE,
		octodeckv1.Field_FIELD_TYPE, octodeckv1.Field_FIELD_DRAFT, octodeckv1.Field_FIELD_TRACKING,
		octodeckv1.Field_FIELD_STARRED, octodeckv1.Field_FIELD_NEW, octodeckv1.Field_FIELD_NO,
		octodeckv1.Field_FIELD_IN, octodeckv1.Field_FIELD_TEXT:
	}
	return out
}

// foldOpen folds an open-field value the way the evaluator compares it.
func foldOpen(field octodeckv1.Field, val string) string {
	if field == octodeckv1.Field_FIELD_MILESTONE || field == octodeckv1.Field_FIELD_LABEL {
		return textKey(val)
	}
	return identKey(val)
}
