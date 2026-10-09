package query

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

func TestCompile_ValidationErrors(t *testing.T) {
	deep := p(fRepo, "a/b")
	for range maxDepth + 1 {
		deep = notE(deep)
	}
	deepPath := ""
	for range maxDepth {
		deepPath = joinPath(deepPath, "not")
	}
	deepPath = joinPath(deepPath, "not") // the node at depth maxDepth+1 is the predicate's parent

	tests := []struct {
		name      string
		expr      *octodeckv1.Expr
		wantPath  string
		wantField octodeckv1.Field
		wantValue string
	}{
		{"unspecified field", p(octodeckv1.Field_FIELD_UNSPECIFIED, "x"), "predicate.field", 0, ""},
		{"unknown field number", p(octodeckv1.Field(999), "x"), "predicate.field", octodeckv1.Field(999), ""},
		{
			"unknown field nested under not inside and",
			andE(p(fRepo, "a/b"), notE(p(octodeckv1.Field(42), "x"))),
			"and.exprs[1].not.predicate.field", octodeckv1.Field(42), "",
		},
		{"no values", andE(p(fRepo, "golang/go"), p(fLabel)), "and.exprs[1].predicate.values", fLabel, ""},
		{"blank value", p(fAuthor, "alice", "  "), "predicate.values[1]", fAuthor, "  "},
		{"empty value", p(fText, ""), "predicate.values[0]", fText, ""},
		{"illegal state", p(fState, "open", "draft"), "predicate.values[1]", fState, "draft"},
		{
			"illegal triage nested under not",
			andE(p(fRepo, "x"), notE(p(fTriage, "bogus"))),
			"and.exprs[1].not.predicate.values[0]", fTriage, "bogus",
		},
		{"illegal draft", p(fDraft, "yes"), "predicate.values[0]", fDraft, "yes"},
		{"illegal tracking", p(fTracking, "tracked"), "predicate.values[0]", fTracking, "tracked"},
		{"illegal starred", p(fStarred, "1"), "predicate.values[0]", fStarred, "1"},
		{"illegal no", p(fNo, "assignees"), "predicate.values[0]", fNo, "assignees"},
		{"illegal new", p(fNew, "unread"), "predicate.values[0]", fNew, "unread"},
		{"illegal type", p(fType, "discussion"), "predicate.values[0]", fType, "discussion"},
		{"in:comments is not supported", p(fIn, "comments"), "predicate.values[0]", fIn, "comments"},
		{"negated in", np(fIn, "title"), "predicate.negated", fIn, ""},
		{"in under or", orE(p(fIn, "title"), p(fRepo, "x")), "or.exprs[0].predicate", fIn, ""},
		{"in under not", notE(p(fIn, "title")), "not.predicate", fIn, ""},
		{"in in a nested and", andE(andE(p(fIn, "title"))), "and.exprs[0].and.exprs[0].predicate", fIn, ""},
		{"empty or", orE(), "or.exprs", 0, ""},
		{"nested unset expr", andE(&octodeckv1.Expr{}), "and.exprs[0]", 0, ""},
		{"nested nil expr in list", andE(nil), "and.exprs[0]", 0, ""},
		{"not with unset child", notE(&octodeckv1.Expr{}), "not", 0, ""},
		{"author @ only", p(fAuthor, "@"), "predicate.values[0]", fAuthor, "@"},
		{"too deep", deep, deepPath, 0, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Compile(tc.expr, Options{CurrentUser: testUser})
			require.Error(t, err)
			var ve *ValidationError
			require.ErrorAs(t, err, &ve)
			assert.Equal(t, tc.wantPath, ve.Path)
			assert.Equal(t, tc.wantField, ve.Field)
			assert.Equal(t, tc.wantValue, ve.Value)
			assert.NotEmpty(t, ve.Message)
			assert.Contains(t, err.Error(), ve.Message)

			pb := ve.Proto()
			assert.Equal(t, tc.wantPath, pb.GetPath())
			assert.Equal(t, ve.Message, pb.GetMessage())
			assert.Equal(t, tc.wantField, pb.GetField())
			assert.Equal(t, tc.wantValue, pb.GetValue())
		})
	}
}

func TestCompile_NotWithoutChildIsEmptyQuery(t *testing.T) {
	// A nil oneof message leaves the kind unset, so at the root it is the empty query.
	q, err := Compile(octodeckv1.Expr_builder{Not: nil}.Build(), Options{})
	require.NoError(t, err)
	assert.Equal(t, KindTrue, q.Root().Kind)
}

func TestCompile_Valid(t *testing.T) {
	deep := p(fRepo, "a/b")
	for range maxDepth {
		deep = notE(deep)
	}
	tests := []struct {
		name string
		expr *octodeckv1.Expr
	}{
		{"nil", nil},
		{"unset root", &octodeckv1.Expr{}},
		{"empty and", andE()},
		{"closed values are case-insensitive", andE(p(fNew, "ANY"), p(fState, "Closed"), p(fTriage, "All"))},
		{"malformed repo is not validated", p(fRepo, "foo")},
		{"label with spaces", p(fLabel, "good first issue")},
		{"@me on other fields is a literal", p(fLabel, "@me")},
		{"in at root", p(fIn, "title")},
		{"in in root and", andE(p(fIn, "body"), p(fText, "x"))},
		{"maximum depth", deep},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Compile(tc.expr, Options{CurrentUser: testUser})
			assert.NoError(t, err)
		})
	}
}

func TestCompile_Normalisation(t *testing.T) {
	q, err := Compile(andE(
		p(fTriage, " ALL "),
		p(fAuthor, "@Alice", "@me"),
		np(fAssignee, "@me"),
		p(fState, "Open"),
		p(fLabel, "  Good First Issue "),
	), Options{CurrentUser: "@Me"})
	require.NoError(t, err)
	root := q.Root()
	require.Equal(t, KindAnd, root.Kind)
	require.Len(t, root.Children, 5)
	assert.Equal(t, []string{"inbox", "acked"}, root.Children[0].Pred.Values)
	assert.Equal(t, []string{"Alice", "Me"}, root.Children[1].Pred.Values)
	assert.Equal(t, []string{"Me"}, root.Children[2].Pred.Values)
	assert.True(t, root.Children[2].Pred.Negated)
	assert.Equal(t, []string{"open"}, root.Children[3].Pred.Values)
	assert.Equal(t, []string{"Good First Issue"}, root.Children[4].Pred.Values)
	assert.False(t, q.ImplicitInbox())
}

func TestCompile_UnresolvedMeIsExplicitFalse(t *testing.T) {
	q, err := Compile(andE(p(fAuthor, "@me"), np(fAssignee, "@ME"), p(fAuthor, "@me", "bob")), Options{})
	require.NoError(t, err)
	root := q.Root()
	require.Len(t, root.Children, 3)
	assert.Equal(t, KindFalse, root.Children[0].Kind)
	require.Equal(t, KindNot, root.Children[1].Kind)
	assert.Equal(t, KindFalse, root.Children[1].Children[0].Kind)
	assert.Equal(t, []string{"bob"}, root.Children[2].Pred.Values)
}

func TestCompile_TextFields(t *testing.T) {
	q, err := Compile(p(fText, "x"), Options{})
	require.NoError(t, err)
	assert.Equal(t, textFields{title: true, body: true}, q.text)

	q, err = Compile(andE(p(fIn, "TITLE"), p(fText, "x")), Options{})
	require.NoError(t, err)
	assert.Equal(t, textFields{title: true}, q.text)
}
