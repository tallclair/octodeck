package query

import (
	"fmt"
	"slices"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/database"
)

// seedDB stores items in a fresh in-memory database.
func seedDB(t *testing.T, items []*octodeckv1.Item) *database.DB {
	t.Helper()
	db, err := database.Init(t.Context(), database.InMemoryDSN)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	require.NoError(t, db.SaveItems(t.Context(), items))
	return db
}

func itemIDs(items []*octodeckv1.Item) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.GetId()
	}
	return out
}

// negateExpr returns the negation of e for stress-testing the prefilter under NOT, or nil if e is
// the empty query. in: predicates must stay top level, so they are kept outside the negation.
func negateExpr(e *octodeckv1.Expr) *octodeckv1.Expr {
	switch e.WhichKind() {
	case octodeckv1.Expr_Kind_not_set_case:
		return nil
	case octodeckv1.Expr_Predicate_case:
		if e.GetPredicate().GetField() == fIn {
			return nil
		}
	case octodeckv1.Expr_And_case:
		var keep, rest []*octodeckv1.Expr
		for _, c := range e.GetAnd().GetExprs() {
			if c.WhichKind() == octodeckv1.Expr_Predicate_case && c.GetPredicate().GetField() == fIn {
				keep = append(keep, c)
			} else {
				rest = append(rest, c)
			}
		}
		return andE(append(keep, notE(andE(rest...)))...)
	case octodeckv1.Expr_Or_case, octodeckv1.Expr_Not_case:
	}
	return notE(e)
}

// conformanceSuites pairs each vector table with its fixture universe.
func conformanceSuites() []struct {
	name     string
	cases    []evalCase
	fixtures []fixture
} {
	return []struct {
		name     string
		cases    []evalCase
		fixtures []fixture
	}{
		{"core", coreCases(), coreFixtures()},
		{"edge", edgeCases(), edgeFixtures()},
	}
}

// TestPrefilterConformance runs every evaluation vector, and its negation, with and without the
// SQL prefilter and requires identical results (design §6: SQL only narrows the candidate set).
// It also checks that the prefilter's rows are a superset of the in-memory result (design §8).
func TestPrefilterConformance(t *testing.T) {
	for _, suite := range conformanceSuites() {
		t.Run(suite.name, func(t *testing.T) {
			items := buildItems(suite.fixtures)
			db := seedDB(t, items)
			for _, tc := range suite.cases {
				variants := []evalCase{tc}
				if neg := negateExpr(tc.expr); neg != nil {
					variants = append(variants, evalCase{name: tc.name + " (negated)", expr: neg, noUser: tc.noUser})
				}
				for i, vc := range variants {
					t.Run(vc.name, func(t *testing.T) {
						q, err := Compile(vc.expr, Options{CurrentUser: vc.user()})
						require.NoError(t, err)
						env := Env{CurrentUser: vc.user(), KnownBots: testBots}

						withoutSQL := ids(q.Filter(NewViews(cloneItems(items), env)))

						rows, err := db.GetItems(t.Context(), SQLPrefilter(q))
						require.NoError(t, err)
						withSQL := ids(q.Filter(NewViews(rows, env)))

						assert.ElementsMatch(t, withoutSQL, withSQL, "results differ with the SQL prefilter")
						assert.Subset(t, itemIDs(rows), withoutSQL, "prefilter dropped a match")
						if i == 0 {
							assert.ElementsMatch(t, tc.want, withoutSQL)
						}
					})
				}
			}
		})
	}
}

// TestPrefilterExactness checks the translator's exactness claims against SQLite: an exact
// translation selects exactly the rows the tree matches in memory (ignoring the implicit triage
// scope, which is never pushed), and a superset translation selects at least those rows.
func TestPrefilterExactness(t *testing.T) {
	for _, suite := range conformanceSuites() {
		t.Run(suite.name, func(t *testing.T) {
			items := buildItems(suite.fixtures)
			db := seedDB(t, items)
			for _, tc := range suite.cases {
				for _, expr := range []*octodeckv1.Expr{tc.expr, negateExpr(tc.expr)} {
					if expr != nil {
						checkExactness(t, db, items, tc, expr)
					}
				}
			}
		})
	}
}

func checkExactness(t *testing.T, db *database.DB, items []*octodeckv1.Item, tc evalCase, expr *octodeckv1.Expr) {
	t.Helper()
	q, err := Compile(expr, Options{CurrentUser: tc.user()})
	require.NoError(t, err)
	frag, ok := translate(q.Root())
	if !ok || len(frag.args) > maxPrefilterArgs {
		return
	}
	unscoped := *q
	unscoped.implicitInbox = false
	env := Env{CurrentUser: tc.user(), KnownBots: testBots}
	mem := ids(unscoped.Filter(NewViews(cloneItems(items), env)))

	rows, err := db.GetItems(t.Context(), &database.ItemFilter{Where: frag.sql, Args: frag.args})
	require.NoError(t, err, frag.sql)
	if frag.exact {
		assert.ElementsMatch(t, mem, itemIDs(rows), "%s: exact translation %q", tc.name, frag.sql)
	} else {
		assert.Subset(t, itemIDs(rows), mem, "%s: superset translation %q", tc.name, frag.sql)
	}
}

// TestPrefilterNarrows shows the prefilter actually reduces the rows loaded for pushable queries.
func TestPrefilterNarrows(t *testing.T) {
	items := buildItems(coreFixtures())
	db := seedDB(t, items)
	q, err := Compile(andE(p(fRepo, "golang/go"), p(fState, "open"), p(fLabel, "x")), Options{})
	require.NoError(t, err)
	rows, err := db.GetItems(t.Context(), SQLPrefilter(q))
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"F04"}, itemIDs(rows))
}

// TestPrefilterConformance_Adversarial runs request shapes and data that once made the prefilter
// change the result: wide and/or lists (SQLite's expression depth limit) and NUL bytes in
// identifiers (NOCASE and LIKE stop comparing at NUL). Results must be identical with and without
// the prefilter, and loading the prefiltered rows must not fail.
func TestPrefilterConformance_Adversarial(t *testing.T) {
	idle := func(f fixture) fixture {
		f.sub = subbed
		f.viewed = tViewed
		f.updated = tViewed
		f.typ = issue
		f.state = open
		return f
	}
	fs := []fixture{
		idle(fixture{id: "N1", repo: "a\x00b/r", author: "a\x00b", title: "nul b"}),
		idle(fixture{id: "N2", repo: "a\x00c/r", author: "a\x00c", title: "nul c"}),
		idle(fixture{id: "N3", repo: "a/r", author: "a", title: "plain"}),
		idle(fixture{id: "N4", repo: "o/r7", author: "x", title: "in a wide list"}),
	}
	items := buildItems(fs)
	db := seedDB(t, items)

	const wide = 1001
	repoPreds := make([]*octodeckv1.Expr, 0, 400)
	for i := range 400 {
		repoPreds = append(repoPreds, p(fRepo, fmt.Sprintf("o/r%d", i)))
	}
	mixed := append(slices.Clone(repoPreds), repeatExpr(600, andE())...)
	tests := []struct {
		name string
		expr *octodeckv1.Expr
		want []string
	}{
		{"or of empty ands", orE(repeatExpr(wide, andE())...), list("N1", "N2", "N3", "N4")},
		{"or of unresolved @me", orE(repeatExpr(wide, p(fAuthor, "@me"))...), nil},
		{"and of not(empty and)", andE(repeatExpr(wide, notE(andE()))...), nil},
		{"and of not(unresolved @me)", andE(repeatExpr(wide, notE(p(fAuthor, "@me")))...),
			list("N1", "N2", "N3", "N4")},
		{"wide or of repos", orE(repoPreds...), list("N4")},
		{"wide or of repos and empty ands", orE(mixed...), list("N1", "N2", "N3", "N4")},
		{"wide and of repos and empty ands", andE(mixed...), nil},
		{"author with NUL", p(fAuthor, "a\x00b"), list("N1")},
		{"-author with NUL", np(fAuthor, "a\x00b"), list("N2", "N3", "N4")},
		{"-repo with NUL", np(fRepo, "a\x00b/r"), list("N2", "N3", "N4")},
		{"org with NUL", p(fOrg, "a\x00b"), list("N1")},
		{"-org with NUL", np(fOrg, "a\x00b"), list("N2", "N3", "N4")},
		{"org prefix ending in NUL", p(fOrg, "a\x00"), nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q, err := Compile(ta(tc.expr), Options{})
			require.NoError(t, err)
			env := Env{KnownBots: testBots}
			withoutSQL := ids(q.Filter(NewViews(cloneItems(items), env)))
			rows, err := db.GetItems(t.Context(), SQLPrefilter(q))
			require.NoError(t, err)
			withSQL := ids(q.Filter(NewViews(rows, env)))
			assert.ElementsMatch(t, tc.want, withoutSQL)
			assert.ElementsMatch(t, withoutSQL, withSQL, "results differ with the SQL prefilter")
		})
	}
}
