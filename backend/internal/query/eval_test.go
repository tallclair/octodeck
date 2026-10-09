package query

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

func runEvalCases(t *testing.T, cases []evalCase, fs []fixture) {
	t.Helper()
	items := buildItems(fs)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := evalViews(tc, items)
			require.NoError(t, err)
			assert.ElementsMatch(t, tc.want, ids(got))
		})
	}
}

func TestEval_Core(t *testing.T) {
	runEvalCases(t, coreCases(), coreFixtures())
}

func TestEval_Edge(t *testing.T) {
	runEvalCases(t, edgeCases(), edgeFixtures())
}

// TestEval_FixtureActivity pins the activity flags the vectors rely on, so a fixture mistake shows
// up here rather than as a confusing vector failure.
func TestEval_FixtureActivity(t *testing.T) {
	views := NewViews(buildItems(coreFixtures()), Env{CurrentUser: testUser, KnownBots: testBots})
	got := map[string]string{}
	for _, v := range views {
		got[v.Item.GetId()] = v.Item.GetLocal().GetComputedStatus().String()
	}
	assert.Equal(t, map[string]string{
		"F01": "ITEM_STATUS_NEW_MENTION",
		"F02": "ITEM_STATUS_IDLE",
		"F03": "ITEM_STATUS_ACKED",
		"F04": "ITEM_STATUS_NOISE",
		"F05": "ITEM_STATUS_NEW",
		"F06": "ITEM_STATUS_IDLE",
		"F07": "ITEM_STATUS_IDLE",
		"F08": "ITEM_STATUS_NEW_ACTIVITY",
		"F09": "ITEM_STATUS_ACKED",
		"F10": "ITEM_STATUS_IDLE",
		"F11": "ITEM_STATUS_IDLE",
	}, got)
}

// TestEval_ActivityTabParity checks that "inbox + new:any" (the Activity tab) selects exactly the
// items the dashboard's old status filter did: status not ACKED, IDLE or NOISE. It also checks
// that the status NewViews stores equals the status calculator's.
func TestEval_ActivityTabParity(t *testing.T) {
	items := buildItems(append(coreFixtures(), edgeFixtures()...))
	q, err := Compile(p(fNew, "any"), Options{CurrentUser: testUser})
	require.NoError(t, err)
	for _, v := range NewViews(cloneItems(items), Env{CurrentUser: testUser, KnownBots: testBots}) {
		want := statusOf(v.Item)
		assert.Equal(t, want, v.Item.GetLocal().GetComputedStatus(), v.Item.GetId())
		oldActivityTab := want != octodeckv1.ItemStatus_ITEM_STATUS_ACKED &&
			want != octodeckv1.ItemStatus_ITEM_STATUS_IDLE &&
			want != octodeckv1.ItemStatus_ITEM_STATUS_NOISE
		assert.Equal(t, oldActivityTab, q.Match(v), v.Item.GetId())
	}
}

// TestEval_EveryFieldCovered guards the vector table: every evaluable field appears in at least
// one core vector, both plain and negated.
func TestEval_EveryFieldCovered(t *testing.T) {
	plain := map[octodeckv1.Field]bool{}
	negated := map[octodeckv1.Field]bool{}
	var walk func(e *octodeckv1.Expr)
	walk = func(e *octodeckv1.Expr) {
		switch e.WhichKind() {
		case octodeckv1.Expr_Predicate_case:
			if e.GetPredicate().GetNegated() {
				negated[e.GetPredicate().GetField()] = true
			} else {
				plain[e.GetPredicate().GetField()] = true
			}
		case octodeckv1.Expr_And_case:
			for _, c := range e.GetAnd().GetExprs() {
				walk(c)
			}
		case octodeckv1.Expr_Or_case:
			for _, c := range e.GetOr().GetExprs() {
				walk(c)
			}
		case octodeckv1.Expr_Not_case:
			walk(e.GetNot())
		case octodeckv1.Expr_Kind_not_set_case:
		}
	}
	for _, c := range coreCases() {
		walk(c.expr)
	}
	for f := range octodeckv1.Field_name {
		field := octodeckv1.Field(f)
		if field == octodeckv1.Field_FIELD_UNSPECIFIED {
			continue
		}
		assert.True(t, plain[field], "no vector for %s", field)
		if field != octodeckv1.Field_FIELD_IN { // in can't be negated
			assert.True(t, negated[field], "no negated vector for %s", field)
		}
	}
}

func TestQuery_ImplicitInbox(t *testing.T) {
	tests := []struct {
		name string
		expr *octodeckv1.Expr
		want bool
	}{
		{"nil", nil, true},
		{"no triage", andE(p(fRepo, "a/b"), np(fLabel, "x")), true},
		{"top-level triage", p(fTriage, "acked"), false},
		{"negated triage", np(fTriage, "inbox"), false},
		{"triage under or", orE(p(fRepo, "a/b"), p(fTriage, "acked")), false},
		{"triage under not", andE(p(fRepo, "a/b"), notE(orE(p(fTriage, "acked")))), false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q, err := Compile(tc.expr, Options{})
			require.NoError(t, err)
			assert.Equal(t, tc.want, q.ImplicitInbox())
		})
	}
}

func TestParseItemNumber(t *testing.T) {
	for in, want := range map[string]int64{"123": 123, "#123": 123, "#0": 0} {
		n, ok := parseItemNumber(in)
		assert.True(t, ok, in)
		assert.Equal(t, want, n, in)
	}
	for _, in := range []string{"", "#", "12a", "#-1", "##1", "99999999999", "1 2"} {
		_, ok := parseItemNumber(in)
		assert.False(t, ok, in)
	}
}

// TestEval_ZeroNumberNeverMatches checks that "0" and "#0" don't select items whose number is
// unset (0); they still match as ordinary text.
func TestEval_ZeroNumberNeverMatches(t *testing.T) {
	seen := func(f fixture) fixture {
		f.sub = subbed
		f.viewed = tViewed
		f.updated = tViewed
		return f
	}
	fs := []fixture{
		seen(fixture{id: "Z1", repo: "o/r", number: 0, typ: issue, state: open, title: "No number"}),
		seen(fixture{id: "Z2", repo: "o/r", number: 7, typ: issue, state: open, title: "Release v0 notes"}),
	}
	runEvalCases(t, []evalCase{
		{name: "#0 matches no unset number", expr: ta(p(fText, "#0")), want: nil},
		{name: "0 matches only as text", expr: ta(p(fText, "0")), want: list("Z2")},
		{name: "#7 matches the number", expr: ta(p(fText, "#7")), want: list("Z2")},
	}, fs)
}

// TestEval_PaddedNames pins how surrounding whitespace in stored names is handled. Label names are
// trimmed like query values, so a padded label can be selected. Milestone titles are compared as
// stored, as the dashboard always did, so a padded title only matches nothing.
func TestEval_PaddedNames(t *testing.T) {
	seen := func(f fixture) fixture {
		f.sub = subbed
		f.viewed = tViewed
		f.updated = tViewed
		return f
	}
	fs := []fixture{
		seen(fixture{id: "P1", repo: "o/r", number: 1, typ: issue, state: open,
			labels: []string{" bug "}, milestone: config.Ptr(" v1.0 ")}),
		seen(fixture{id: "P2", repo: "o/r", number: 2, typ: issue, state: open,
			labels: []string{"bug"}, milestone: config.Ptr("v1.0")}),
		seen(fixture{id: "P3", repo: "o/r", number: 3, typ: issue, state: open, milestone: config.Ptr("  ")}),
	}
	runEvalCases(t, []evalCase{
		{name: "padded label matches trimmed value", expr: ta(p(fLabel, "BUG")), want: list("P1", "P2")},
		{name: "padded milestone is not trimmed", expr: ta(p(fMilestone, "v1.0")), want: list("P2")},
		{name: "padded query milestone value is trimmed", expr: ta(p(fMilestone, " v1.0 ")), want: list("P2")},
		{name: "whitespace milestone is still a milestone", expr: ta(p(fNo, "milestone")), want: nil},
	}, fs)

	empty, err := Compile(nil, Options{})
	require.NoError(t, err)
	facets, err := Facets(empty, facetViews(fs, testUser), []octodeckv1.Field{fLabel, fMilestone})
	require.NoError(t, err)
	assert.Equal(t, []string{"bug"}, facetValueNames(facets[0].GetValues()), "label values are trimmed")
	assert.Equal(t, int32(2), facets[0].GetValues()[0].GetCount())
	assert.Equal(t, []string{" v1.0 ", "v1.0"}, facetValueNames(facets[1].GetValues()),
		"milestone titles are listed as stored, without whitespace-only titles")
}
