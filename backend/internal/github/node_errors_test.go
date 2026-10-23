package github

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cli/go-gh/v2/pkg/api"
	graphql "github.com/cli/shurcooL-graphql"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// issueNodeJSON is a minimal flattened nodes(ids:) entry for an open issue.
func issueNodeJSON(id string) map[string]any {
	return map[string]any{
		"__typename": "Issue",
		"id":         id,
		"number":     1,
		"title":      "Issue " + id,
		"state":      "OPEN",
		"url":        "https://github.com/o/r/issues/1",
		"updatedAt":  "2026-09-01T10:00:00Z",
		"repository": map[string]any{"nameWithOwner": "o/r"},
		"author":     map[string]any{"login": "someone"},
	}
}

// nodesServerClient returns a client whose GraphQL requests are answered with body by a real
// GraphQL client, so partial data and errors are decoded exactly as in production.
func nodesServerClient(t *testing.T, body map[string]any) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(server.Close)
	return &Client{GraphQLClient: &testGQLAdapter{client: graphql.NewClient(server.URL, server.Client())}}
}

func TestHydrateItemsByIDs_PartialErrors(t *testing.T) {
	ids := []string{"I_ok", "I_deleted", "I_forbidden", "I_field_error", "I_null"}
	client := nodesServerClient(t, map[string]any{
		"data": map[string]any{"nodes": []any{
			issueNodeJSON("I_ok"),
			nil,
			nil,
			issueNodeJSON("I_field_error"),
			nil,
		}},
		"errors": []any{
			map[string]any{"type": "NOT_FOUND", "path": []any{"nodes", 1},
				"message": "Could not resolve to a node with the global id of 'I_deleted'"},
			map[string]any{"type": "FORBIDDEN", "path": []any{"nodes", 2},
				"message": "Resource protected by organization SAML enforcement."},
			map[string]any{"type": "SERVICE_UNAVAILABLE", "path": []any{"nodes", 3, "timelineItems"},
				"message": "timeline unavailable"},
		},
	})

	res, err := client.HydrateItemsByIDs(t.Context(), ids)
	require.NoError(t, err, "per-node errors must not fail the batch")

	require.Len(t, res.Items, 1)
	assert.Equal(t, "I_ok", res.Items[0].GetId())
	assert.Equal(t, []string{"I_deleted", "I_null"}, res.Missing,
		"NOT_FOUND nodes and plain null nodes are gone")
	require.Len(t, res.Failed, 2)
	assert.Contains(t, res.Failed["I_forbidden"], "SAML")
	assert.Contains(t, res.Failed["I_field_error"], "timeline unavailable",
		"a node with a failed field is incomplete, so it isn't stored")

	// FetchItemsByIDs reports the same items and missing IDs.
	items, _, missing, err := client.FetchItemsByIDs(t.Context(), ids)
	require.NoError(t, err)
	assert.Len(t, items, 1)
	assert.Equal(t, []string{"I_deleted", "I_null"}, missing)
}

func TestHydrateItemsByIDs_AllNodesNotFound(t *testing.T) {
	client := nodesServerClient(t, map[string]any{
		"data": map[string]any{"nodes": []any{nil, nil}},
		"errors": []any{
			map[string]any{"type": "NOT_FOUND", "path": []any{"nodes", 0}, "message": "gone"},
			map[string]any{"type": "NOT_FOUND", "path": []any{"nodes", 1}, "message": "gone"},
		},
	})

	res, err := client.HydrateItemsByIDs(t.Context(), []string{"I_a", "I_b"})
	require.NoError(t, err, "errors that all belong to nodes are per-ID, even if nothing decoded")
	assert.Empty(t, res.Items)
	assert.Equal(t, []string{"I_a", "I_b"}, res.Missing)
	assert.Empty(t, res.Failed)
}

func TestHydrateItemsByIDs_RequestLevelErrors(t *testing.T) {
	t.Run("nothing decoded fails the batch", func(t *testing.T) {
		client := nodesServerClient(t, map[string]any{
			"data":   nil,
			"errors": []any{map[string]any{"type": "RATE_LIMITED", "message": "API rate limit exceeded"}},
		})
		_, err := client.HydrateItemsByIDs(t.Context(), []string{"I_a", "I_b"})
		require.ErrorContains(t, err, "rate limit")
	})

	t.Run("decoded nodes are kept and null nodes are not reported gone", func(t *testing.T) {
		client := nodesServerClient(t, map[string]any{
			"data":   map[string]any{"nodes": []any{issueNodeJSON("I_a"), nil}},
			"errors": []any{map[string]any{"message": "Something went wrong while executing your query."}},
		})
		res, err := client.HydrateItemsByIDs(t.Context(), []string{"I_a", "I_b"})
		require.NoError(t, err)
		require.Len(t, res.Items, 1)
		assert.Empty(t, res.Missing, "a null node may be due to the request-level error, not deletion")
		assert.Contains(t, res.Failed["I_b"], "Something went wrong")
	})

	t.Run("transport errors fail the batch", func(t *testing.T) {
		client := &Client{GraphQLClient: &mockGraphQLClient{
			queryFunc: func(context.Context, string, any, map[string]any) error {
				return errors.New("connection reset")
			},
		}}
		_, err := client.HydrateItemsByIDs(t.Context(), []string{"I_a"})
		require.ErrorContains(t, err, "connection reset")
	})
}

func TestHydrateItemsByIDs_GoGHGraphQLError(t *testing.T) {
	// go-gh wraps the errors array in *api.GraphQLError after decoding the data.
	client := &Client{GraphQLClient: &mockGraphQLClient{
		queryFunc: func(_ context.Context, _ string, q any, _ map[string]any) error {
			b, _ := json.Marshal(map[string]any{"nodes": []any{
				map[string]any{"__typename": "Issue", "issue": issueNodeJSON("I_ok")},
				nil,
				nil,
			}})
			if err := json.Unmarshal(b, q); err != nil {
				return err
			}
			return &api.GraphQLError{Errors: []api.GraphQLErrorItem{
				{Type: "NOT_FOUND", Path: []any{"nodes", float64(1)}, Message: "gone"},
				{Type: "FORBIDDEN", Path: []any{"nodes", float64(2)}, Message: "forbidden"},
			}}
		},
	}}

	res, err := client.HydrateItemsByIDs(t.Context(), []string{"I_ok", "I_gone", "I_forbidden"})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	assert.Equal(t, []string{"I_gone"}, res.Missing)
	assert.Equal(t, map[string]string{"I_forbidden": "FORBIDDEN: forbidden"}, res.Failed)
}

func TestNodeErrorIndex(t *testing.T) {
	tests := []struct {
		path      []any
		wantIndex int
		wantWhole bool
		wantOK    bool
	}{
		{path: []any{"nodes", float64(2)}, wantIndex: 2, wantWhole: true, wantOK: true},
		{path: []any{"nodes", 1, "comments"}, wantIndex: 1, wantOK: true},
		{path: []any{"nodes", json.Number("0")}, wantIndex: 0, wantWhole: true, wantOK: true},
		{path: []any{"nodes", float64(5)}},   // out of range
		{path: []any{"nodes", float64(1.5)}}, // not an index
		{path: []any{"nodes", "x"}},
		{path: []any{"search", float64(0)}},
		{path: []any{"nodes"}},
		{path: nil},
	}
	for _, tc := range tests {
		i, whole, ok := nodeErrorIndex(tc.path, 3)
		assert.Equal(t, tc.wantOK, ok, "path %v", tc.path)
		if tc.wantOK {
			assert.Equal(t, tc.wantIndex, i, "path %v", tc.path)
			assert.Equal(t, tc.wantWhole, whole, "path %v", tc.path)
		}
	}
}
