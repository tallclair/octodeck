package query

import (
	"slices"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

// facetFixtures is a small universe for facet counts. Ordered by updated_at (newest first):
// X5, X1, X2, X3, X4. X4 is the only item of zeta/old and is acked; X5 has new mention, comment and
// code activity; the rest are idle.
func facetFixtures() []fixture {
	seen := func(f fixture) fixture {
		f.sub = subbed
		f.viewed = tViewed
		return f
	}
	x4 := fixture{id: "X4", repo: "zeta/old", number: 4, typ: issue, state: open, author: "dave", sub: subbed,
		updated: tViewed.Add(-4 * time.Hour), ackedAt: tViewed, ackedAct: tViewed}
	return []fixture{
		seen(fixture{id: "X1", repo: "acme/web", number: 1, typ: pr, state: open, author: "Alice",
			labels: []string{"Bug", "bug"}, milestone: config.Ptr("v1"), assignees: []string{"bob"},
			updated: tViewed.Add(-1 * time.Hour)}),
		seen(fixture{id: "X2", repo: "acme/api", number: 2, typ: issue, state: closed, author: "alice",
			labels: []string{"bug", "ui"}, updated: tViewed.Add(-2 * time.Hour)}),
		seen(fixture{id: "X3", repo: "ACME/web", number: 3, typ: pr, state: merged, author: "carol",
			labels: []string{"UI"}, updated: tViewed.Add(-3 * time.Hour)}),
		x4,
		seen(fixture{id: "X5", repo: "acme/api", number: 5, typ: pr, state: open, author: "eve", updated: tNew,
			comments: []fixtureComment{{author: "bob", body: "ping @me", at: tNew}},
			commits:  []fixtureCommit{{author: "carol", at: tNew}}}),
	}
}

func facetViews(fs []fixture, user string) []*View {
	return NewViews(buildItems(fs), Env{CurrentUser: user, KnownBots: testBots})
}

// facetCounts runs Facets for one field and returns value -> count, plus the values in order.
func facetCounts(t *testing.T, expr *octodeckv1.Expr, field octodeckv1.Field) (map[string]int32, []string) {
	t.Helper()
	q, err := Compile(expr, Options{CurrentUser: testUser})
	require.NoError(t, err)
	facets, err := Facets(q, facetViews(facetFixtures(), testUser), []octodeckv1.Field{field})
	require.NoError(t, err)
	require.Len(t, facets, 1)
	require.Equal(t, field, facets[0].GetField())
	counts := map[string]int32{}
	var order []string
	for _, v := range facets[0].GetValues() {
		counts[v.GetValue()] = v.GetCount()
		order = append(order, v.GetValue())
	}
	return counts, order
}

func TestFacets_OwnFieldExclusion(t *testing.T) {
	counts, _ := facetCounts(t, p(fRepo, "acme/web"), fRepo)
	assert.Equal(t, map[string]int32{"acme/api": 2, "acme/web": 2, "zeta/old": 0}, counts,
		"selecting a repo must not hide the other repos")

	counts, _ = facetCounts(t, np(fRepo, "acme/web"), fRepo)
	assert.Equal(t, int32(2), counts["acme/web"], "negated own-field predicates are removed too")

	// Other fields still apply: the state facet is narrowed by repo:acme/web (X1 open, X3 merged).
	counts, _ = facetCounts(t, andE(p(fRepo, "acme/web"), p(fState, "open")), fState)
	assert.Equal(t, map[string]int32{"open": 1, "closed": 1, "merged": 1}, counts)
}

func TestFacets_NestedOwnFieldIsKept(t *testing.T) {
	// The top-level repo predicate is dropped but the nested one under or still applies:
	// or(repo:acme/api, state:open) matches X5, X2 (api) and X1 (open).
	expr := andE(p(fRepo, "acme/web"), orE(p(fRepo, "acme/api"), p(fState, "open")))
	counts, _ := facetCounts(t, expr, fRepo)
	assert.Equal(t, map[string]int32{"acme/api": 2, "acme/web": 1, "zeta/old": 0}, counts)
}

func TestFacets_ZeroCountsAndImplicitInbox(t *testing.T) {
	// zeta/old only has an acked item: the implicit triage:inbox excludes it from the count but the
	// value is still listed.
	counts, order := facetCounts(t, nil, fRepo)
	assert.Equal(t, []string{"acme/api", "acme/web", "zeta/old"}, order)
	assert.Equal(t, map[string]int32{"acme/api": 2, "acme/web": 2, "zeta/old": 0}, counts)

	counts, _ = facetCounts(t, p(fTriage, "all"), fRepo)
	assert.Equal(t, int32(1), counts["zeta/old"], "triage:all counts acked items")

	counts, _ = facetCounts(t, nil, fOrg)
	assert.Equal(t, map[string]int32{"acme": 4, "zeta": 0}, counts)
}

func TestFacets_Triage(t *testing.T) {
	counts, order := facetCounts(t, nil, fTriage)
	assert.Equal(t, []string{"inbox", "acked"}, order, "triage:all is a meta value and isn't listed")
	assert.Equal(t, map[string]int32{"inbox": 4, "acked": 1}, counts)

	counts, _ = facetCounts(t, p(fTriage, "acked"), fTriage)
	assert.Equal(t, map[string]int32{"inbox": 4, "acked": 1}, counts,
		"the selected triage value doesn't hide the other")

	// A nested triage predicate is not removed, so it still applies: X4 (acked) or acme/web (X1, X3).
	counts, _ = facetCounts(t, orE(p(fTriage, "acked"), p(fRepo, "acme/web")), fTriage)
	assert.Equal(t, map[string]int32{"inbox": 2, "acked": 1}, counts)

	// Other facets honor the explicit triage selection.
	counts, _ = facetCounts(t, p(fTriage, "acked"), fRepo)
	assert.Equal(t, map[string]int32{"acme/api": 0, "acme/web": 0, "zeta/old": 1}, counts)
}

func TestFacets_MultiValuedCounting(t *testing.T) {
	counts, order := facetCounts(t, nil, fLabel)
	assert.Equal(t, []string{"Bug", "ui"}, order)
	assert.Equal(t, map[string]int32{"Bug": 2, "ui": 2}, counts, "Bug and bug on X1 count once")

	counts, order = facetCounts(t, nil, fNew)
	assert.Equal(t, []string{"item", "mention", "comment", "code", "noise"}, order, "new:any isn't listed")
	assert.Equal(t, map[string]int32{"item": 0, "mention": 1, "comment": 1, "code": 1, "noise": 0}, counts)

	counts, _ = facetCounts(t, nil, fNo)
	assert.Equal(t, map[string]int32{valueAssignee: 3, valueLabel: 1, valueMilestone: 3}, counts)

	counts, _ = facetCounts(t, nil, fState)
	assert.Equal(t, map[string]int32{"open": 2, "closed": 2, "merged": 1}, counts, "merged counts as closed too")
}

func TestFacets_GroupingAndMetadata(t *testing.T) {
	q, err := Compile(nil, Options{CurrentUser: testUser})
	require.NoError(t, err)
	facets, err := Facets(q, facetViews(facetFixtures(), testUser), []octodeckv1.Field{fAuthor, fLabel, fRepo})
	require.NoError(t, err)
	require.Len(t, facets, 3)

	// Authors are grouped case-insensitively with the most recently updated item's casing (X1).
	authors := facets[0].GetValues()
	require.Len(t, authors, 4)
	assert.Equal(t, "Alice", authors[0].GetValue())
	assert.Equal(t, int32(2), authors[0].GetCount())
	assert.Equal(t, []string{"Alice", "carol", "dave", "eve"}, facetValueNames(authors))
	assert.Equal(t, int32(0), authors[2].GetCount(), "dave only has an acked item")

	// Label colors come from the first-seen label (fixture colors cycle by index).
	labels := facets[1].GetValues()
	require.Len(t, labels, 2)
	assert.Equal(t, "d73a4a", labels[0].GetColor(), "Bug is X1's first label")
	assert.Equal(t, "0075ca", labels[1].GetColor(), "ui is X2's second label")
	assert.False(t, labels[0].HasLatestActivityAt(), "only repos carry latest activity")

	// Repo latest activity is the universe-wide maximum, even for a zero-count repo.
	repos := facets[2].GetValues()
	require.Len(t, repos, 3)
	assert.Equal(t, "acme/web", repos[1].GetValue(), "ACME/web is grouped under the first-seen casing")
	assert.Equal(t, tNew, repos[0].GetLatestActivityAt().AsTime(), "acme/api: X5's comment")
	assert.Equal(t, tViewed.Add(-3*time.Hour), repos[1].GetLatestActivityAt().AsTime(), "acme/web: X3's merge")
	assert.Equal(t, int32(0), repos[2].GetCount())
	assert.Equal(t, tBase, repos[2].GetLatestActivityAt().AsTime(), "zeta/old: creation of its acked item")
	assert.Empty(t, repos[0].GetColor())
}

func facetValueNames(values []*octodeckv1.FacetValue) []string {
	out := make([]string, len(values))
	for i, v := range values {
		out[i] = v.GetValue()
	}
	return out
}

func TestFacets_RequestOrderAndDuplicates(t *testing.T) {
	q, err := Compile(nil, Options{})
	require.NoError(t, err)
	views := facetViews(facetFixtures(), testUser)

	facets, err := Facets(q, views, []octodeckv1.Field{fRepo, fTriage, fRepo})
	require.NoError(t, err)
	require.Len(t, facets, 3)
	assert.Equal(t, fRepo, facets[0].GetField())
	assert.Equal(t, fTriage, facets[1].GetField())
	assert.Equal(t, fRepo, facets[2].GetField())
	assert.Equal(t, facetValueNames(facets[0].GetValues()), facetValueNames(facets[2].GetValues()))

	facets, err = Facets(q, views, nil)
	require.NoError(t, err)
	assert.Empty(t, facets)
}

func TestFacets_InvalidFields(t *testing.T) {
	q, err := Compile(nil, Options{})
	require.NoError(t, err)
	for _, f := range []octodeckv1.Field{fText, fIn, octodeckv1.Field_FIELD_UNSPECIFIED, octodeckv1.Field(99)} {
		_, err := Facets(q, nil, []octodeckv1.Field{fRepo, f})
		require.ErrorIs(t, err, ErrInvalidFacetField, "field %v", f)
		assert.Contains(t, err.Error(), "fields[1]")
	}
	assert.NoError(t, ValidateFacetFields([]octodeckv1.Field{fTriage, fLabel, fNo}))
}

func TestFacets_UnresolvedMeIsOwnField(t *testing.T) {
	// author:@me without a known user matches nothing, but the author facet drops it like any
	// other author predicate.
	q, err := Compile(p(fAuthor, "@me"), Options{})
	require.NoError(t, err)
	facets, err := Facets(q, facetViews(facetFixtures(), ""), []octodeckv1.Field{fAuthor, fRepo})
	require.NoError(t, err)
	assert.Equal(t, int32(2), facets[0].GetValues()[0].GetCount())
	for _, v := range facets[1].GetValues() {
		assert.Zero(t, v.GetCount(), v.GetValue())
	}
}

func TestWithoutTopLevel(t *testing.T) {
	q, err := Compile(andE(p(fRepo, "a/b"), np(fRepo, "c/d"), p(fState, "open")), Options{})
	require.NoError(t, err)
	r := q.WithoutTopLevel(fRepo)
	require.Equal(t, KindAnd, r.Root().Kind)
	require.Len(t, r.Root().Children, 1)
	assert.Equal(t, fState, r.Root().Children[0].Pred.Field)
	assert.True(t, r.ImplicitInbox())
	assert.Len(t, q.Root().Children, 3, "the original query is unchanged")

	assert.Equal(t, KindTrue, q.WithoutTopLevel(fRepo).WithoutTopLevel(fState).Root().Kind)

	tq, err := Compile(p(fTriage, "acked"), Options{})
	require.NoError(t, err)
	assert.False(t, tq.ImplicitInbox())
	tr := tq.WithoutTopLevel(fTriage)
	assert.Equal(t, KindTrue, tr.Root().Kind)
	assert.False(t, tr.ImplicitInbox(), "removing triage means triage:all, not the implicit inbox")

	eq, err := Compile(nil, Options{})
	require.NoError(t, err)
	assert.False(t, eq.WithoutTopLevel(fTriage).ImplicitInbox())
	assert.True(t, eq.WithoutTopLevel(fRepo).ImplicitInbox())
}

func TestWithoutTopLevel_UnspecifiedFieldRemovesNothing(t *testing.T) {
	q, err := Compile(andE(p(fRepo, "a/b"), orE(p(fState, "open")), notE(andE(p(fLabel, "x")))), Options{})
	require.NoError(t, err)
	for _, f := range []octodeckv1.Field{octodeckv1.Field_FIELD_UNSPECIFIED, octodeckv1.Field(99)} {
		r := q.WithoutTopLevel(f)
		assert.Equal(t, q.Root(), r.Root(), "composite children must not match %v", f)
		assert.Equal(t, q.ImplicitInbox(), r.ImplicitInbox())
	}
}

// TestFacets_NotWrapperIsOwnField checks that not(field:value) is treated like -field:value: both
// are the field's own top-level predicate and are removed from its facet.
func TestFacets_NotWrapperIsOwnField(t *testing.T) {
	negated, _ := facetCounts(t, andE(np(fTriage, "acked"), p(fState, "open")), fTriage)
	wrapped, _ := facetCounts(t, andE(notE(p(fTriage, "acked")), p(fState, "open")), fTriage)
	assert.Equal(t, negated, wrapped)
	assert.Equal(t, int32(1), wrapped["acked"], "the acked item is counted (X4 is open)")

	negated, _ = facetCounts(t, np(fRepo, "acme/web"), fRepo)
	wrapped, _ = facetCounts(t, notE(p(fRepo, "acme/web")), fRepo)
	assert.Equal(t, negated, wrapped)
	assert.Equal(t, int32(2), wrapped["acme/web"])

	// A not around a composite is not a predicate of the field and still applies.
	counts, _ := facetCounts(t, notE(orE(p(fRepo, "acme/web"))), fRepo)
	assert.Equal(t, int32(0), counts["acme/web"])
}

// TestFacetValuesAgreeWithEval checks that facet counting can't drift from predicate semantics:
// for every fixture, facetable field and listed value, an item contributes to the value exactly
// when the predicate field:value matches it.
func TestFacetValuesAgreeWithEval(t *testing.T) {
	suites := map[string][]fixture{"core": coreFixtures(), "edge": edgeFixtures(), "facet": facetFixtures()}
	for name, fs := range suites {
		views := facetViews(fs, testUser)
		empty, err := Compile(nil, Options{})
		require.NoError(t, err)
		for f := octodeckv1.Field_FIELD_TRIAGE; f <= octodeckv1.Field_FIELD_TEXT; f++ {
			if !facetable(f) {
				continue
			}
			facets, err := Facets(empty, views, []octodeckv1.Field{f})
			require.NoError(t, err)
			for _, fv := range facets[0].GetValues() {
				q, err := Compile(p(f, fv.GetValue()), Options{CurrentUser: testUser})
				require.NoError(t, err, "%s %s:%s", name, fieldName(f), fv.GetValue())
				key := fv.GetValue()
				if _, closed := ClosedValues(f); !closed {
					key = foldOpen(f, key)
				}
				for _, v := range views {
					assert.Equal(t, q.evalNode(q.Root(), v), slices.Contains(facetKeys(f, v), key),
						"%s: item %s, %s:%s", name, v.Item.GetId(), fieldName(f), fv.GetValue())
				}
			}
		}
	}
}
