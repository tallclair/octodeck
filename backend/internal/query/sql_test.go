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

func TestTranslate(t *testing.T) {
	type want struct {
		sql   string
		args  []any
		exact bool
	}
	none := (*want)(nil)
	tests := []struct {
		name string
		expr *octodeckv1.Expr
		user string
		want *want
	}{
		{"state:open", p(fState, "open"), testUser, &want{"state IN (?,?)", []any{int32(0), int32(1)}, true}},
		{"state:closed,merged dedupes", p(fState, "closed", "merged"), testUser,
			&want{"state IN (?,?)", []any{int32(2), int32(3)}, true}},
		{"-state:open", np(fState, "open"), testUser,
			&want{"NOT (state IN (?,?))", []any{int32(0), int32(1)}, true}},
		{"type:pr is a superset", p(fType, "pr"), testUser, &want{"type <> ?", []any{int32(1)}, false}},
		{"-type:pr is not pushed", np(fType, "pr"), testUser, none},
		{"type:pr,issue", p(fType, "pr", "issue"), testUser,
			&want{"type <> ? OR type <> ?", []any{int32(1), int32(2)}, false}},
		{"repo values", p(fRepo, "A/B", "c/d"), testUser, &want{"repo IN (?,?)", []any{"A/B", "c/d"}, true}},
		{"author uses NOCASE", p(fAuthor, "X"), testUser,
			&want{"author_login COLLATE NOCASE IN (?)", []any{"X"}, true}},
		{"author @ stripped", p(fAuthor, "@x"), testUser,
			&want{"author_login COLLATE NOCASE IN (?)", []any{"x"}, true}},
		{"non-ASCII author is not pushed", p(fAuthor, "ñ"), testUser, none},
		{"non-ASCII repo is not pushed", p(fRepo, "ñ/x"), testUser, none},
		{"org escapes LIKE metacharacters", p(fOrg, `a_b%c\d`), testUser,
			&want{`repo LIKE ? ESCAPE '\'`, []any{`a\_b\%c\\d/%`}, true}},
		{"org values are ORed", p(fOrg, "a", "b"), testUser,
			&want{`repo LIKE ? ESCAPE '\' OR repo LIKE ? ESCAPE '\'`, []any{"a/%", "b/%"}, true}},
		{"and drops untranslatable conjuncts", andE(p(fState, "open"), p(fLabel, "x")), testUser,
			&want{"(state IN (?,?))", []any{int32(0), int32(1)}, false}},
		{"or with untranslatable child is not pushed", orE(p(fState, "open"), p(fLabel, "x")), testUser, none},
		{"not of superset and is not pushed", notE(andE(p(fState, "open"), p(fLabel, "x"))), testUser, none},
		{"not of exact or", notE(orE(p(fState, "merged"), p(fRepo, "a/b"))), testUser,
			&want{"NOT ((state IN (?)) OR (repo IN (?)))", []any{int32(3), "a/b"}, true}},
		{"double not of type is not pushed", notE(notE(p(fType, "pr"))), testUser, none},
		{"empty and is dropped from and", andE(andE(), p(fState, "merged")), testUser,
			&want{"(state IN (?))", []any{int32(3)}, true}},
		{"empty and with untranslatable sibling is not pushed", andE(andE(), p(fLabel, "x")), testUser, none},
		{"false conjunct makes and false", andE(p(fLabel, "x"), p(fAuthor, "@me")), "", &want{"0", nil, true}},
		{"true disjunct makes or true", orE(p(fLabel, "x"), andE()), testUser, &want{"1", nil, true}},
		{"false disjunct is dropped from or", orE(p(fAuthor, "@me"), p(fState, "merged")), "",
			&want{"(state IN (?))", []any{int32(3)}, true}},
		{"or of only false disjuncts", orE(p(fAuthor, "@me"), p(fAuthor, "@me")), "", &want{"0", nil, true}},
		{"not of empty and is false", notE(andE()), testUser, &want{"0", nil, true}},
		{"unresolved @me is false", p(fAuthor, "@me"), "", &want{"0", nil, true}},
		{"negated unresolved @me is true", np(fAuthor, "@me"), "", &want{"1", nil, true}},
		{"resolved @me", p(fAuthor, "@me"), "Me", &want{"author_login COLLATE NOCASE IN (?)", []any{"Me"}, true}},
		{"author with NUL is not pushed", p(fAuthor, "a\x00b"), testUser, none},
		{"-author with NUL is not pushed", np(fAuthor, "a\x00b"), testUser, none},
		{"repo with NUL is not pushed", np(fRepo, "a\x00b/r"), testUser, none},
		{"org with NUL is not pushed", np(fOrg, "a\x00"), testUser, none},
	}
	for _, f := range []octodeckv1.Field{fTriage, fNew, fDraft, fTracking, fStarred, fAssignee, fMilestone,
		fLabel, fNo, fIn, fText} {
		values := map[octodeckv1.Field]string{ //nolint:exhaustive // only the fields never pushed down
			fTriage: "acked", fNew: "any", fDraft: "true", fTracking: "true", fStarred: "true",
			fAssignee: "x", fMilestone: "m", fLabel: "l", fNo: "label", fIn: "title", fText: "t",
		}
		tests = append(tests, struct {
			name string
			expr *octodeckv1.Expr
			user string
			want *want
		}{"not pushed: " + f.String(), p(f, values[f]), testUser, none})
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q, err := Compile(tc.expr, Options{CurrentUser: tc.user})
			require.NoError(t, err)
			got, ok := translate(q.Root())
			if tc.want == nil {
				assert.False(t, ok, "got %q", got.sql)
				assert.Nil(t, SQLPrefilter(q))
				return
			}
			require.True(t, ok)
			assert.Equal(t, tc.want.sql, got.sql)
			assert.Equal(t, tc.want.args, got.args)
			assert.Equal(t, tc.want.exact, got.exact)
			f := SQLPrefilter(q)
			if got.konst == constTrue {
				assert.Nil(t, f, "an always-true condition scans every row without a WHERE clause")
				return
			}
			require.NotNil(t, f)
			assert.Equal(t, tc.want.sql, f.Where)
		})
	}
}

func TestSQLPrefilter_EmptyQueryScansEverything(t *testing.T) {
	for _, e := range []*octodeckv1.Expr{nil, andE(), andE(andE(), andE()), orE(p(fState, "open"), andE())} {
		q, err := Compile(e, Options{})
		require.NoError(t, err)
		assert.Nil(t, SQLPrefilter(q))
	}
}

func TestSQLPrefilter_ArgCap(t *testing.T) {
	values := make([]string, maxPrefilterArgs+1)
	for i := range values {
		values[i] = "o/r" + string(rune('a'+i%26))
	}
	q, err := Compile(p(fRepo, values...), Options{})
	require.NoError(t, err)
	assert.Nil(t, SQLPrefilter(q))

	q, err = Compile(p(fRepo, values[:maxPrefilterArgs]...), Options{})
	require.NoError(t, err)
	assert.NotNil(t, SQLPrefilter(q))
}

// repeatExpr returns n copies of e.
func repeatExpr(n int, e *octodeckv1.Expr) []*octodeckv1.Expr {
	out := make([]*octodeckv1.Expr, n)
	for i := range out {
		out[i] = e
	}
	return out
}

// TestSQLPrefilter_WideTreesStaySmall covers wide and/or lists, which SQLite would parse into
// expression trees deeper than its limit of 1000. Constant children are folded away, and any
// remaining condition deeper than maxPrefilterDepth falls back to a full scan.
func TestSQLPrefilter_WideTreesStaySmall(t *testing.T) {
	const wide = 1001
	repoPreds := make([]*octodeckv1.Expr, 300)
	for i := range repoPreds {
		repoPreds[i] = p(fRepo, fmt.Sprintf("o/r%d", i))
	}
	tests := []struct {
		name string
		expr *octodeckv1.Expr
		want *database.ItemFilter
	}{
		{"or of empty ands is true", orE(repeatExpr(wide, andE())...), nil},
		{"or of unresolved @me is false", orE(repeatExpr(wide, p(fAuthor, "@me"))...),
			&database.ItemFilter{Where: "0"}},
		{"and of not(empty and) is false", andE(repeatExpr(wide, notE(andE()))...), &database.ItemFilter{Where: "0"}},
		{"and of empty ands and one predicate", andE(append(repeatExpr(wide, andE()), p(fState, "merged"))...),
			&database.ItemFilter{Where: "(state IN (?))", Args: []any{int32(3)}}},
		{"long or chain falls back to a scan", orE(repoPreds...), nil},
		{"long and chain falls back to a scan", andE(repoPreds...), nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q, err := Compile(tc.expr, Options{})
			require.NoError(t, err)
			assert.Equal(t, tc.want, SQLPrefilter(q))
		})
	}

	// Below the cap a chain is still pushed down.
	q, err := Compile(orE(repoPreds[:10]...), Options{})
	require.NoError(t, err)
	f := SQLPrefilter(q)
	require.NotNil(t, f)
	assert.Len(t, f.Args, 10)
}

// TestSQLPrefilter_DepthBoundIsSafe checks that the deepest condition the prefilter accepts is
// still well within what SQLite parses, so the depth estimate is a sufficient guard.
func TestSQLPrefilter_DepthBoundIsSafe(t *testing.T) {
	db := seedDB(t, buildItems(coreFixtures()))
	// Nest not(or(state:merged, not(or(...)))) to the maximum validated depth.
	expr := p(fState, "merged")
	for range maxDepth / 2 {
		expr = notE(orE(p(fRepo, "golang/go"), expr))
	}
	q, err := Compile(expr, Options{})
	require.NoError(t, err)
	frag, ok := translate(q.Root())
	require.True(t, ok)
	assert.LessOrEqual(t, frag.depth, maxPrefilterDepth, "the deepest valid nesting is still pushed down")
	_, err = db.GetItems(t.Context(), &database.ItemFilter{Where: frag.sql, Args: frag.args})
	require.NoError(t, err, "depth estimate %d", frag.depth)

	// A chain right at the cap is accepted by SQLite.
	repoPreds := make([]*octodeckv1.Expr, 0, maxPrefilterDepth)
	for i := 0; ; i++ {
		next := append(slices.Clone(repoPreds), p(fRepo, fmt.Sprintf("o/r%d", i)))
		longer, cerr := Compile(orE(next...), Options{})
		require.NoError(t, cerr)
		if SQLPrefilter(longer) == nil {
			break
		}
		repoPreds = next
	}
	q, err = Compile(orE(repoPreds...), Options{})
	require.NoError(t, err)
	f := SQLPrefilter(q)
	require.NotNil(t, f)
	_, err = db.GetItems(t.Context(), f)
	require.NoError(t, err)
}
