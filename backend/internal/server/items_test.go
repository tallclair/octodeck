package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/api/octodeck/v1/octodeckv1connect"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
)

func predicateExpr(field octodeckv1.Field, values ...string) *octodeckv1.Expr {
	return octodeckv1.Expr_builder{Predicate: octodeckv1.Predicate_builder{
		Field: field.Enum(), Values: values,
	}.Build()}.Build()
}

func negatedExpr(field octodeckv1.Field, values ...string) *octodeckv1.Expr {
	return octodeckv1.Expr_builder{Predicate: octodeckv1.Predicate_builder{
		Field: field.Enum(), Values: values, Negated: config.Ptr(true),
	}.Build()}.Build()
}

func andExpr(exprs ...*octodeckv1.Expr) *octodeckv1.Expr {
	return octodeckv1.Expr_builder{And: octodeckv1.ExprList_builder{Exprs: exprs}.Build()}.Build()
}

func notExpr(e *octodeckv1.Expr) *octodeckv1.Expr {
	return octodeckv1.Expr_builder{Not: e}.Build()
}

type itemsTestEnv struct {
	db         *database.DB
	client     octodeckv1connect.OctoDeckServiceClient
	addHeaders func(connect.AnyRequest)
}

// setupItemsTest starts a server with the given config and GitHub client (nil for none).
func setupItemsTest(t *testing.T, cfg *octodeckv1.Config, gh *mockGitHubClient) *itemsTestEnv {
	t.Helper()
	db, err := database.Init(t.Context(), database.InMemoryDSN)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	var client GitHubClient
	if gh != nil {
		client = gh
	}
	s := New(db, client, &mockSyncEngine{}, config.NewForTest(cfg), nil)
	code, err := s.auth.GenerateCode()
	require.NoError(t, err)
	token, err := s.auth.ExchangeCode(t.Context(), code)
	require.NoError(t, err)
	ts := httptest.NewServer(s.router)
	t.Cleanup(ts.Close)

	return &itemsTestEnv{
		db:     db,
		client: octodeckv1connect.NewOctoDeckServiceClient(http.DefaultClient, ts.URL+"/api/v1"),
		addHeaders: func(req connect.AnyRequest) {
			req.Header().Set("Origin", "chrome-extension://"+config.DevExtensionID)
			req.Header().Set("Authorization", "Bearer "+token)
		},
	}
}

type queryItem struct {
	id, repo, author string
	labels           []string
	updated          time.Time
	acked            bool
	starred          bool
}

func (e *itemsTestEnv) seed(t *testing.T, items ...queryItem) {
	t.Helper()
	var out []*octodeckv1.Item
	for i, it := range items {
		b := octodeckv1.Item_builder{
			Id:        config.Ptr(it.id),
			Repo:      config.Ptr(it.repo),
			Number:    config.Ptr(int32(i + 1)),
			Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
			Title:     config.Ptr("Item " + it.id),
			State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			CreatedAt: timestamppb.New(it.updated),
			UpdatedAt: timestamppb.New(it.updated),
			Author:    octodeckv1.User_builder{Login: config.Ptr(it.author)}.Build(),
		}
		for _, l := range it.labels {
			b.Labels = append(b.Labels,
				octodeckv1.Label_builder{Name: config.Ptr(l), Color: config.Ptr("ededed")}.Build())
		}
		local := octodeckv1.ItemLocalState_builder{Starred: config.Ptr(it.starred)}
		if it.acked {
			local.AckedAt = timestamppb.New(it.updated.Add(time.Minute))
			local.AckedActivityAt = timestamppb.New(it.updated)
		}
		b.Local = local.Build()
		out = append(out, b.Build())
	}
	require.NoError(t, e.db.SaveItems(t.Context(), out))
}

func (e *itemsTestEnv) getItems(t *testing.T, q *octodeckv1.Expr, sort *octodeckv1.Sort) ([]string, error) {
	t.Helper()
	req := connect.NewRequest(octodeckv1.GetItemsRequest_builder{Query: q, Sort: sort}.Build())
	e.addHeaders(req)
	resp, err := e.client.GetItems(t.Context(), req)
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, it := range resp.Msg.GetItems() {
		ids = append(ids, it.GetId())
	}
	return ids, nil
}

func (e *itemsTestEnv) getFacets(
	t *testing.T, q *octodeckv1.Expr, fields ...octodeckv1.Field,
) ([]*octodeckv1.Facet, error) {
	t.Helper()
	req := connect.NewRequest(octodeckv1.GetFacetsRequest_builder{Query: q, Fields: fields}.Build())
	e.addHeaders(req)
	resp, err := e.client.GetFacets(t.Context(), req)
	if err != nil {
		return nil, err
	}
	return resp.Msg.GetFacets(), nil
}

func facetCountMap(f *octodeckv1.Facet) map[string]int32 {
	out := map[string]int32{}
	for _, v := range f.GetValues() {
		out[v.GetValue()] = v.GetCount()
	}
	return out
}

var queryNow = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC) //nolint:gochecknoglobals // test fixture

// standardItems: A and C are in the inbox, B is acked, D is in a repo excluded by config.
func standardItems() []queryItem {
	return []queryItem{
		{id: "A", repo: "acme/web", author: "testuser", labels: []string{"bug", "hidden"}, updated: queryNow},
		{id: "B", repo: "acme/web", author: "alice", updated: queryNow.Add(-time.Hour), acked: true},
		{id: "C", repo: "other/lib", author: "bob", labels: []string{"hidden"}, updated: queryNow.Add(-2 * time.Hour)},
		{id: "D", repo: "excluded/repo", author: "bob", updated: queryNow.Add(-3 * time.Hour)},
	}
}

func standardConfig() *octodeckv1.Config {
	return octodeckv1.Config_builder{
		ExcludedRepos:  []string{"excluded/repo"},
		ExcludedLabels: []string{"hidden"},
	}.Build()
}

func TestGetItems_TriageScope(t *testing.T) {
	env := setupItemsTest(t, standardConfig(), &mockGitHubClient{authenticated: true})
	env.seed(t, standardItems()...)

	ids, err := env.getItems(t, nil, nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"A", "C"}, ids, "the empty query is the inbox, newest first")

	ids, err = env.getItems(t, predicateExpr(octodeckv1.Field_FIELD_TRIAGE, "all"), nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"A", "B", "C"}, ids, "triage:all includes acked items; excluded repos stay hidden")

	ids, err = env.getItems(t, predicateExpr(octodeckv1.Field_FIELD_TRIAGE, "acked"), nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"B"}, ids)

	// A pushable predicate goes through the SQL prefilter and still respects the scope.
	ids, err = env.getItems(t, predicateExpr(octodeckv1.Field_FIELD_REPO, "ACME/web"), nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"A"}, ids)

	ids, err = env.getItems(t, predicateExpr(octodeckv1.Field_FIELD_REPO, "excluded/repo"), nil)
	require.NoError(t, err)
	assert.Empty(t, ids, "config-excluded repos never match")
}

func TestGetItems_Sort(t *testing.T) {
	env := setupItemsTest(t, nil, &mockGitHubClient{authenticated: true})
	items := standardItems()
	items[2].starred = true
	env.seed(t, items...)

	all := predicateExpr(octodeckv1.Field_FIELD_TRIAGE, "all")
	ids, err := env.getItems(t, all, nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"C", "A", "B", "D"}, ids, "starred first, then latest activity descending")

	asc := octodeckv1.Sort_builder{
		Key:   octodeckv1.SortKey_SORT_KEY_CREATED.Enum(),
		Order: octodeckv1.SortOrder_SORT_ORDER_ASC.Enum(),
	}.Build()
	ids, err = env.getItems(t, all, asc)
	require.NoError(t, err)
	assert.Equal(t, []string{"C", "D", "B", "A"}, ids)
}

func TestGetItems_ConfigLabelFilter(t *testing.T) {
	env := setupItemsTest(t, standardConfig(), &mockGitHubClient{authenticated: true})
	env.seed(t, standardItems()...)

	ids, err := env.getItems(t, predicateExpr(octodeckv1.Field_FIELD_LABEL, "hidden"), nil)
	require.NoError(t, err)
	assert.Empty(t, ids, "labels hidden by config never match")

	ids, err = env.getItems(t, predicateExpr(octodeckv1.Field_FIELD_NO, "label"), nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"C"}, ids, "C's only label is hidden, so it has no label")

	facets, err := env.getFacets(t, nil, octodeckv1.Field_FIELD_LABEL, octodeckv1.Field_FIELD_REPO)
	require.NoError(t, err)
	require.Len(t, facets, 2)
	assert.Equal(t, map[string]int32{"bug": 1}, facetCountMap(facets[0]), "hidden labels aren't faceted")
	assert.Equal(t, "ededed", facets[0].GetValues()[0].GetColor())
	assert.Equal(t, map[string]int32{"acme/web": 1, "other/lib": 1}, facetCountMap(facets[1]),
		"excluded repos aren't faceted; the acked item isn't counted")
}

func TestGetItems_WatchedRepos(t *testing.T) {
	cfg := octodeckv1.Config_builder{WatchedRepos: []string{"acme/*"}}.Build()
	env := setupItemsTest(t, cfg, &mockGitHubClient{authenticated: true})
	env.seed(t, standardItems()...)

	ids, err := env.getItems(t, predicateExpr(octodeckv1.Field_FIELD_TRIAGE, "all"), nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"A", "B"}, ids)

	facets, err := env.getFacets(t, nil, octodeckv1.Field_FIELD_REPO)
	require.NoError(t, err)
	assert.Equal(t, map[string]int32{"acme/web": 1}, facetCountMap(facets[0]))
}

func TestGetFacets_TriageAndZeroCounts(t *testing.T) {
	env := setupItemsTest(t, nil, &mockGitHubClient{authenticated: true})
	env.seed(t,
		queryItem{id: "A", repo: "acme/web", author: "x", updated: queryNow},
		queryItem{id: "B", repo: "zeta/old", author: "y", updated: queryNow.Add(-time.Hour), acked: true},
	)
	facets, err := env.getFacets(t, predicateExpr(octodeckv1.Field_FIELD_REPO, "acme/web"),
		octodeckv1.Field_FIELD_TRIAGE, octodeckv1.Field_FIELD_REPO)
	require.NoError(t, err)
	require.Len(t, facets, 2)
	assert.Equal(t, octodeckv1.Field_FIELD_TRIAGE, facets[0].GetField())
	assert.Equal(t, map[string]int32{"inbox": 1, "acked": 0}, facetCountMap(facets[0]))
	assert.Equal(t, map[string]int32{"acme/web": 1, "zeta/old": 0}, facetCountMap(facets[1]),
		"own-field exclusion keeps other repos, and the acked-only repo is listed with 0")
	for _, v := range facets[1].GetValues() {
		assert.True(t, v.HasLatestActivityAt(), "repo %s has latest activity", v.GetValue())
	}
}

// requireExprError checks err is InvalidArgument with an ExprError detail at path.
func requireExprError(t *testing.T, err error, path string) *octodeckv1.ExprError {
	t.Helper()
	require.Error(t, err)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)
	var cerr *connect.Error
	require.ErrorAs(t, err, &cerr)
	for _, d := range cerr.Details() {
		v, derr := d.Value()
		require.NoError(t, derr)
		if ee, ok := v.(*octodeckv1.ExprError); ok {
			assert.Equal(t, path, ee.GetPath())
			assert.NotEmpty(t, ee.GetMessage())
			return ee
		}
	}
	require.FailNow(t, "no ExprError detail", "details: %v", cerr.Details())
	return nil
}

func TestGetItems_InvalidQuery(t *testing.T) {
	env := setupItemsTest(t, nil, &mockGitHubClient{authenticated: true})
	env.seed(t, standardItems()...)

	unknown := andExpr(
		predicateExpr(octodeckv1.Field_FIELD_REPO, "acme/web"),
		notExpr(predicateExpr(octodeckv1.Field(99), "x")),
	)
	_, err := env.getItems(t, unknown, nil)
	ee := requireExprError(t, err, "and.exprs[1].not.predicate.field")
	assert.Equal(t, octodeckv1.Field(99), ee.GetField())

	_, err = env.getItems(t, predicateExpr(octodeckv1.Field_FIELD_LABEL), nil)
	requireExprError(t, err, "predicate.values")

	_, err = env.getItems(t, andExpr(negatedExpr(octodeckv1.Field_FIELD_STATE, "open", "bogus")), nil)
	ee = requireExprError(t, err, "and.exprs[0].predicate.values[1]")
	assert.Equal(t, octodeckv1.Field_FIELD_STATE, ee.GetField())
	assert.Equal(t, "bogus", ee.GetValue())

	_, err = env.getFacets(t, unknown, octodeckv1.Field_FIELD_REPO)
	requireExprError(t, err, "and.exprs[1].not.predicate.field")

	_, err = env.getFacets(t, nil, octodeckv1.Field_FIELD_TEXT)
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestGetItems_AuthorMe(t *testing.T) {
	items := standardItems()

	env := setupItemsTest(t, nil, &mockGitHubClient{authenticated: true, login: "testuser"})
	env.seed(t, items...)
	ids, err := env.getItems(t, predicateExpr(octodeckv1.Field_FIELD_AUTHOR, "@me"), nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"A"}, ids)

	// With no known login, @me matches nothing (and its negation matches everything in scope).
	unknown := setupItemsTest(t, nil, &mockGitHubClient{})
	unknown.seed(t, items...)
	ids, err = unknown.getItems(t, predicateExpr(octodeckv1.Field_FIELD_AUTHOR, "@me"), nil)
	require.NoError(t, err)
	assert.Empty(t, ids)
	ids, err = unknown.getItems(t, negatedExpr(octodeckv1.Field_FIELD_AUTHOR, "@me"), nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"A", "C", "D"}, ids)
}

func orExpr(exprs ...*octodeckv1.Expr) *octodeckv1.Expr {
	return octodeckv1.Expr_builder{Or: octodeckv1.ExprList_builder{Exprs: exprs}.Build()}.Build()
}

func repeatedExpr(n int, e *octodeckv1.Expr) []*octodeckv1.Expr {
	out := make([]*octodeckv1.Expr, n)
	for i := range out {
		out[i] = e
	}
	return out
}

// TestGetItems_WideQueries checks that valid but very wide expressions are answered like their
// simple equivalents instead of failing in SQLite (whose expression depth limit is 1000).
func TestGetItems_WideQueries(t *testing.T) {
	env := setupItemsTest(t, nil, &mockGitHubClient{})
	env.seed(t, standardItems()...)
	const wide = 1001
	repos := make([]*octodeckv1.Expr, 0, 400)
	for i := range 400 {
		repos = append(repos, predicateExpr(octodeckv1.Field_FIELD_REPO, fmt.Sprintf("filler/r%d", i)))
	}
	repos = append(repos, predicateExpr(octodeckv1.Field_FIELD_REPO, "other/lib"))
	empty := andExpr()
	tests := []struct {
		name string
		expr *octodeckv1.Expr
		want []string
	}{
		{"or of empty ands", orExpr(repeatedExpr(wide, empty)...), []string{"A", "C", "D"}},
		{"or of unresolved author:@me",
			orExpr(repeatedExpr(wide, predicateExpr(octodeckv1.Field_FIELD_AUTHOR, "@me"))...), nil},
		{"and of not(empty and)", andExpr(repeatedExpr(wide, notExpr(empty))...), nil},
		{"or of many repos", orExpr(repos...), []string{"C"}},
		{"or of many repos and empty ands", orExpr(append(slices.Clone(repos), repeatedExpr(600, empty)...)...),
			[]string{"A", "C", "D"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ids, err := env.getItems(t, tc.expr, nil)
			require.NoError(t, err)
			assert.Equal(t, tc.want, ids)
		})
	}
}

// TestLoadCandidates_FallsBackWhenPrefilterFails checks that an SQL error from the prefilter falls
// back to loading every row, since the prefilter never decides membership.
func TestLoadCandidates_FallsBackWhenPrefilterFails(t *testing.T) {
	env := setupItemsTest(t, nil, nil)
	env.seed(t, standardItems()...)
	h := &octoDeckHandler{db: env.db}

	items, err := h.loadCandidates(t.Context(), &database.ItemFilter{Where: "no_such_column = ?", Args: []any{1}})
	require.NoError(t, err)
	assert.Len(t, items, len(standardItems()))

	items, err = h.loadCandidates(t.Context(), &database.ItemFilter{Where: "repo = ?", Args: []any{"other/lib"}})
	require.NoError(t, err)
	require.Len(t, items, 1, "a working prefilter is used as is")
	assert.Equal(t, "C", items[0].GetId())

	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = h.loadCandidates(ctx, &database.ItemFilter{Where: "no_such_column = ?", Args: []any{1}})
	require.Error(t, err, "a cancelled request is not retried")
}
