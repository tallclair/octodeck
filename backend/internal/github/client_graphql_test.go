package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	graphql "github.com/cli/shurcooL-graphql"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

type mockGraphQLClient struct {
	queryFunc func(ctx context.Context, name string, q any, vars map[string]any) error
}

func (m *mockGraphQLClient) QueryWithContext(ctx context.Context, name string, q any,
	vars map[string]any) error {
	return m.queryFunc(ctx, name, q, vars)
}

// transformTimelineNode wraps the flat timeline item into event keys
// to simulate shurcooL/graphql's behavior when using [json.Unmarshal].
func transformTimelineNode(node map[string]any) map[string]any {
	typeName, ok := node["__typename"].(string)
	if !ok {
		return node
	}

	newNode := make(map[string]any)
	newNode["__typename"] = typeName

	switch typeName {
	case "ClosedEvent":
		newNode["closedEvent"] = node
	case "MergedEvent":
		newNode["mergedEvent"] = node
	case "ReopenedEvent":
		newNode["reopenedEvent"] = node
	case "AssignedEvent":
		if assignee, ok := node["assignee"].(map[string]any); ok {
			node["assignee"] = wrapAssigneeMap(assignee)
		}
		newNode["assignedEvent"] = node
	}

	return newNode
}

func wrapAssigneeMap(assignee map[string]any) map[string]any {
	if _, hasUser := assignee["user"]; hasUser {
		return assignee
	}
	if _, hasBot := assignee["bot"]; hasBot {
		return assignee
	}
	assigneeTypename, _ := assignee["__typename"].(string)
	if assigneeTypename == "Bot" {
		return map[string]any{"bot": assignee}
	}
	return map[string]any{"user": assignee}
}

func transformTimelineNodes(nodes []any) []any {
	var transformed []any
	for _, n := range nodes {
		nodeMap, ok := n.(map[string]any)
		if ok {
			transformed = append(transformed, transformTimelineNode(nodeMap))
		}
	}
	return transformed
}

// transformNode wraps the flat node content into "issue" or "pullRequest" keys
// to simulate shurcooL/graphql's behavior when using [json.Unmarshal].
func transformNode(node map[string]any) map[string]any {
	typeName, ok := node["__typename"].(string)
	if !ok {
		return node
	}

	newNode := make(map[string]any)
	newNode["__typename"] = typeName

	if timelineItems, ok := node["timelineItems"].(map[string]any); ok {
		if ns, ok := timelineItems["nodes"].([]any); ok {
			timelineItems["nodes"] = transformTimelineNodes(ns)
		}
	}

	// Create a copy of the node data to put inside the wrapper
	// We can just use the node itself as the content
	switch typeName {
	case "PullRequest":
		newNode["pullRequest"] = node
	case "Issue":
		newNode["issue"] = node
	}

	return newNode
}

func transformNodes(nodes []any) []any {
	var transformed []any
	for _, n := range nodes {
		nodeMap, ok := n.(map[string]any)
		if ok {
			transformed = append(transformed, transformNode(nodeMap))
		}
	}
	return transformed
}

func loadTestResponse(t *testing.T, filename string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filename)
	require.NoError(t, err, "Failed to read %s", filename)

	var root map[string]any
	err = json.Unmarshal(raw, &root)
	require.NoError(t, err, "Failed to parse %s", filename)

	data, ok := root["data"].(map[string]any)
	require.True(t, ok, "Invalid JSON structure in %s: missing 'data'", filename)

	// Try finding nodes in data.search.nodes (for search queries)
	if search, ok := data["search"].(map[string]any); ok {
		if ns, ok := search["nodes"].([]any); ok {
			search["nodes"] = transformNodes(ns)
		}
		// If the response has pageInfo, overwrite it to prevent tested function from attempting to
		// load the additional pages.
		if _, ok := search["pageInfo"]; ok {
			search["pageInfo"] = map[string]any{
				"hasNextPage": false,
				"endCursor":   "cursor",
			}
		}
	} else if ns, ok := data["nodes"].([]any); ok {
		data["nodes"] = transformNodes(ns)
	} else {
		require.Failf(t, "Could not find nodes in %s", filename)
	}

	return data
}

func TestFetchInventory_RealData(t *testing.T) {
	const (
		expectedTargetNumber = 5761
		expectedTargetRepo   = "kubernetes/enhancements"
		expectedTargetTitle  = "KEP-1287: Mark in-place pod resize as implemented"
		expectedTargetAuthor = "natasha41575"

		expectedCommentAuthor = "tallclair"
		expectedCommentBody   = "/lgtm"

		expectedCommitAuthor = "natasha41575"
		expectedCommitDate   = "2025-12-29T19:06:47Z"
	)

	// 1. Read the real data
	response := loadTestResponse(t, "testdata/inventory_response.json")

	// Mock responses
	mock := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			if name != "InventorySearch" {
				return fmt.Errorf("unexpected query name: %s", name)
			}

			if vars["query"] == nil {
				return errors.New("missing query var")
			}
			queryStr := fmt.Sprint(vars["query"])

			if queryStr != "is:open (assignee:@me OR author:@me) sort:updated-desc" {
				return fmt.Errorf("unexpected query string: %s", queryStr)
			}

			bytes, err := json.Marshal(response)
			if err != nil {
				return err
			}
			return json.Unmarshal(bytes, q)
		},
	}

	client := &Client{GraphQLClient: mock}
	items, err := client.FetchInventory(t.Context())
	require.NoError(t, err, "FetchInventory failed")

	// Validate against known data from the file (PR #5761)
	require.NotEmpty(t, items, "Expected items, got 0")

	// Find the specific item to check
	var targetItem *octodeckv1.Item
	found := false
	for _, item := range items {
		if item.GetNumber() == int32(expectedTargetNumber) && item.GetRepo() == expectedTargetRepo {
			targetItem = item
			found = true
			break
		}
	}

	require.True(t, found, "Expected to find PR #%d in %s, but got: %v",
		expectedTargetNumber, expectedTargetRepo, items)

	assert.Equal(t, octodeckv1.ItemType_ITEM_TYPE_PR, targetItem.GetType(), "Expected ItemTypePR")
	assert.Equal(t, expectedTargetTitle, targetItem.GetTitle(), "Unexpected title")
	assert.Equal(t, expectedTargetAuthor, targetItem.GetAuthor().GetLogin(), "Unexpected author")

	// Check Comments
	assert.NotEmpty(t, targetItem.GetComments(), "Expected comments, got none")
	if len(targetItem.GetComments()) > 0 {
		// Check for specific comment content seen in the file
		commentFound := false
		for _, c := range targetItem.GetComments() {
			if c.GetAuthor().GetLogin() == expectedCommentAuthor && c.GetBodyText() == expectedCommentBody {
				commentFound = true
				break
			}
		}
		assert.True(t, commentFound, "Expected comment '%s' from '%s' not found",
			expectedCommentBody, expectedCommentAuthor)
	}

	// Check Commits
	assert.NotEmpty(t, targetItem.GetCommits(), "Expected commits, got none")
	if len(targetItem.GetCommits()) > 0 {
		assert.Equal(t, expectedCommitAuthor, targetItem.GetCommits()[0].GetAuthorLogin(), "Unexpected commit author")
		expectedTime, _ := time.Parse(time.RFC3339, expectedCommitDate)
		assert.True(t, targetItem.GetCommits()[0].GetCommittedDate().AsTime().Equal(expectedTime),
			"Expected commit time %v, got %v", expectedTime, targetItem.GetCommits()[0].GetCommittedDate())
	}
}

func TestFetchUserUpdates_RealData(t *testing.T) {
	response := loadTestResponse(t, "testdata/search_response.json")
	var capturedQuery string

	mock := &mockGraphQLClient{
		queryFunc: func(_ context.Context, _ string, q any, vars map[string]any) error {
			if vars["query"] != nil {
				capturedQuery = fmt.Sprint(vars["query"])
			}
			bytes, err := json.Marshal(response)
			if err != nil {
				return err
			}
			return json.Unmarshal(bytes, q)
		},
	}

	since := time.Date(2026, 8, 13, 10, 0, 0, 0, time.UTC)
	client := &Client{GraphQLClient: mock}
	items, err := client.FetchUserUpdates(t.Context(), since)
	require.NoError(t, err)
	assert.NotEmpty(t, items)
	assert.Equal(t, "(assignee:@me OR author:@me) updated:>2026-08-13T10:00:00Z sort:updated-desc", capturedQuery)
}

// TestFetchItems_RealData verifies that FetchItems correctly parses a real GitHub API response
// (saved in testdata/items_response.json) which contains both Issue and PR nodes.
func TestFetchItems_RealData(t *testing.T) {
	const (
		expectedPRID              = "PR_kwDOAToIks6zimkN"
		expectedPRNumber          = 135309
		expectedPRCommentCount    = 7
		expectedPRCommitCount     = 2
		expectedIssueID           = "I_kwDOAToIks7gNKvx"
		expectedIssueNumber       = 135929
		expectedIssueCommentCount = 10
	)

	// 1. Load the real response data
	response := loadTestResponse(t, "testdata/items_response.json")

	// 2. Set up the Mock GraphQL Client
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, _ map[string]any) error {
			if name != "ItemsFetch" {
				return fmt.Errorf("Unexpected query name: %s", name)
			}

			bytes, err := json.Marshal(response)
			if err != nil {
				return err
			}
			return json.Unmarshal(bytes, q)
		},
	}

	client := &Client{
		GraphQLClient: mockGQL,
		// RestClient is not used by FetchItems
	}

	// 3. Define the IDs to fetch (must match the IDs in items_response.json)
	itemsToFetch := []*octodeckv1.Item{
		octodeckv1.Item_builder{Id: config.Ptr(expectedPRID)}.Build(),
		octodeckv1.Item_builder{Id: config.Ptr(expectedIssueID)}.Build(),
	}

	// 4. Call FetchItems
	items, missing, err := client.FetchItems(t.Context(), itemsToFetch)
	require.NoError(t, err, "FetchItems failed")

	// 5. Verify Results
	assert.Empty(t, missing, "Expected 0 missing items")
	require.Len(t, items, 2, "Expected 2 items")

	// Verify PR
	pr := items[0]
	assert.Equal(t, expectedPRID, pr.GetId())
	assert.Equal(t, octodeckv1.ItemType_ITEM_TYPE_PR, pr.GetType())
	assert.Equal(t, int32(expectedPRNumber), pr.GetNumber())
	assert.Len(t, pr.GetComments(), expectedPRCommentCount)
	assert.Len(t, pr.GetCommits(), expectedPRCommitCount)

	// Verify Issue
	issue := items[1]
	assert.Equal(t, expectedIssueID, issue.GetId())
	assert.Equal(t, octodeckv1.ItemType_ITEM_TYPE_ISSUE, issue.GetType())
	assert.Equal(t, int32(expectedIssueNumber), issue.GetNumber())
	assert.Len(t, issue.GetComments(), expectedIssueCommentCount)
}

func TestFetchInventory_Pagination(t *testing.T) {
	pageCalls := 0
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			require.Equal(t, "InventorySearch", name)
			pageCalls++

			var respData map[string]any
			if pageCalls == 1 {
				// Page 1: hasNextPage = true
				require.Nil(t, vars["cursor"], "Page 1 cursor should be nil")
				respData = map[string]any{
					"search": map[string]any{
						"nodes": []any{
							map[string]any{
								"__typename": "Issue",
								"issue": map[string]any{
									"id":         "I_1",
									"number":     float64(101),
									"title":      "Issue Page 1",
									"updatedAt":  "2026-08-01T00:00:00Z",
									"url":        "https://github.com/org/repo/issues/101",
									"state":      "OPEN",
									"author":     map[string]any{"login": "author1", "avatarUrl": "https://avatar.url"},
									"repository": map[string]any{"nameWithOwner": "org/repo"},
								},
							},
						},
						"pageInfo": map[string]any{
							"hasNextPage": true,
							"endCursor":   "cursor_page_1",
						},
					},
				}
			} else {
				// Page 2: hasNextPage = false
				require.NotNil(t, vars["cursor"], "Page 2 cursor should not be nil")
				respData = map[string]any{
					"search": map[string]any{
						"nodes": []any{
							map[string]any{
								"__typename": "Issue",
								"issue": map[string]any{
									"id":         "I_2",
									"number":     float64(102),
									"title":      "Issue Page 2",
									"updatedAt":  "2026-08-01T01:00:00Z",
									"url":        "https://github.com/org/repo/issues/102",
									"state":      "OPEN",
									"author":     map[string]any{"login": "author2", "avatarUrl": "https://avatar.url"},
									"repository": map[string]any{"nameWithOwner": "org/repo"},
								},
							},
						},
						"pageInfo": map[string]any{
							"hasNextPage": false,
							"endCursor":   "cursor_page_2",
						},
					},
				}
			}

			bytes, err := json.Marshal(respData)
			if err != nil {
				return err
			}
			return json.Unmarshal(bytes, q)
		},
	}

	client := &Client{GraphQLClient: mockGQL}
	items, err := client.FetchInventory(t.Context())
	require.NoError(t, err)
	assert.Equal(t, 2, pageCalls, "Expected 2 page queries")
	require.Len(t, items, 2, "Expected 2 items accumulated across pages")
	assert.Equal(t, int32(101), items[0].GetNumber())
	assert.Equal(t, int32(102), items[1].GetNumber())
}

func TestToProto_Body(t *testing.T) {
	issue := gqlIssue{
		ID:        "issue_1",
		Number:    42,
		Title:     "Bug in foo",
		Body:      "### Description\nThis is the issue body with markdown.",
		UpdatedAt: "2026-08-01T00:00:00Z",
		URL:       "https://github.com/org/repo/issues/42",
		State:     "OPEN",
		Author:    gqlUser{Login: "dev1", AvatarURL: "https://avatar.url"},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}

	issueProto, err := issue.toProto()
	require.NoError(t, err)
	assert.Equal(t, "### Description\nThis is the issue body with markdown.", issueProto.GetBody())

	pr := gqlPullRequest{
		ID:        "pr_1",
		Number:    43,
		Title:     "Fix bug in foo",
		Body:      "## Changes\n- Fixes #42\n- Adds tests",
		UpdatedAt: "2026-08-01T00:00:00Z",
		URL:       "https://github.com/org/repo/pull/43",
		State:     "OPEN",
		Author:    gqlUser{Login: "dev1", AvatarURL: "https://avatar.url"},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}

	prProto, err := pr.toProto()
	require.NoError(t, err)
	assert.Equal(t, "## Changes\n- Fixes #42\n- Adds tests", prProto.GetBody())
}

func TestToProto_Milestone(t *testing.T) {
	issue := gqlIssue{
		ID:        "issue_1",
		Number:    42,
		Title:     "Bug in foo",
		UpdatedAt: "2026-08-01T00:00:00Z",
		URL:       "https://github.com/org/repo/issues/42",
		State:     "OPEN",
		Author:    gqlUser{Login: "dev1", AvatarURL: "https://avatar.url"},
		Milestone: &gqlMilestone{
			Title: "v1.32",
		},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}

	issueProto, err := issue.toProto()
	require.NoError(t, err)
	require.NotNil(t, issueProto.GetMilestone())
	assert.Equal(t, "v1.32", issueProto.GetMilestone().GetTitle())

	pr := gqlPullRequest{
		ID:        "pr_1",
		Number:    43,
		Title:     "Fix bug in foo",
		UpdatedAt: "2026-08-01T00:00:00Z",
		URL:       "https://github.com/org/repo/pull/43",
		State:     "OPEN",
		Author:    gqlUser{Login: "dev1", AvatarURL: "https://avatar.url"},
		Milestone: &gqlMilestone{
			Title: "v1.33",
		},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}

	prProto, err := pr.toProto()
	require.NoError(t, err)
	require.NotNil(t, prProto.GetMilestone())
	assert.Equal(t, "v1.33", prProto.GetMilestone().GetTitle())
}

func TestToProto_Labels(t *testing.T) {
	issue := gqlIssue{
		ID:        "issue_1",
		Number:    42,
		Title:     "Bug in foo",
		UpdatedAt: "2026-08-01T00:00:00Z",
		URL:       "https://github.com/org/repo/issues/42",
		State:     "OPEN",
		Author:    gqlUser{Login: "dev1", AvatarURL: "https://avatar.url"},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}
	issue.Labels.Nodes = []gqlLabel{
		{Name: "kind/bug", Color: "d73a4a"},
		{Name: "size/M", Color: "0075ca"},
	}

	issueProto, err := issue.toProto()
	require.NoError(t, err)
	require.Len(t, issueProto.GetLabels(), 2)
	assert.Equal(t, "kind/bug", issueProto.GetLabels()[0].GetName())
	assert.Equal(t, "d73a4a", issueProto.GetLabels()[0].GetColor())
	assert.Equal(t, "size/M", issueProto.GetLabels()[1].GetName())
	assert.Equal(t, "0075ca", issueProto.GetLabels()[1].GetColor())

	pr := gqlPullRequest{
		ID:        "pr_1",
		Number:    43,
		Title:     "Fix bug in foo",
		UpdatedAt: "2026-08-01T00:00:00Z",
		URL:       "https://github.com/org/repo/pull/43",
		State:     "OPEN",
		Author:    gqlUser{Login: "dev1", AvatarURL: "https://avatar.url"},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}
	pr.Labels.Nodes = []gqlLabel{
		{Name: "sig/node", Color: "ededed"},
	}

	prProto, err := pr.toProto()
	require.NoError(t, err)
	require.Len(t, prProto.GetLabels(), 1)
	assert.Equal(t, "sig/node", prProto.GetLabels()[0].GetName())
	assert.Equal(t, "ededed", prProto.GetLabels()[0].GetColor())
}

func TestToProto_IsDraft(t *testing.T) {
	prDraft := gqlPullRequest{
		ID:        "pr_draft",
		Number:    101,
		Title:     "Draft PR",
		UpdatedAt: "2026-08-01T00:00:00Z",
		URL:       "https://github.com/org/repo/pull/101",
		State:     "OPEN",
		IsDraft:   true,
		Author:    gqlUser{Login: "dev1", AvatarURL: "https://avatar.url"},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}

	protoDraft, err := prDraft.toProto()
	require.NoError(t, err)
	assert.True(t, protoDraft.GetIsDraft(), "expected is_draft to be true")

	prNonDraft := gqlPullRequest{
		ID:        "pr_ready",
		Number:    102,
		Title:     "Ready PR",
		UpdatedAt: "2026-08-01T00:00:00Z",
		URL:       "https://github.com/org/repo/pull/102",
		State:     "OPEN",
		IsDraft:   false,
		Author:    gqlUser{Login: "dev1", AvatarURL: "https://avatar.url"},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}

	protoNonDraft, err := prNonDraft.toProto()
	require.NoError(t, err)
	assert.False(t, protoNonDraft.GetIsDraft(), "expected is_draft to be false")
}

func TestToProto_Reviews(t *testing.T) {
	pr := gqlPullRequest{
		ID:        "pr_1",
		Number:    43,
		Title:     "Fix bug in foo",
		UpdatedAt: "2026-08-01T00:00:00Z",
		URL:       "https://github.com/org/repo/pull/43",
		State:     "OPEN",
		Author:    gqlUser{Login: "dev1", AvatarURL: "https://avatar.url"},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}
	pr.Reviews.Nodes = []gqlReview{
		{
			State:       "APPROVED",
			SubmittedAt: "2026-08-01T12:00:00Z",
			Body:        "LGTM! Looks good.",
			URL:         "https://github.com/org/repo/pull/43#pullrequestreview-1",
			Author:      gqlUser{Login: "reviewer1", AvatarURL: "https://avatar1.url"},
			Comments: struct {
				TotalCount int32              `json:"totalCount"`
				Nodes      []gqlReviewComment `json:"nodes"`
			}{
				TotalCount: 3,
				Nodes: []gqlReviewComment{
					{ID: "c1", ReplyTo: nil},
					{ID: "c2", ReplyTo: nil},
					{ID: "c3", ReplyTo: &struct {
						ID string `json:"id"`
					}{ID: "c1"}},
				},
			},
		},
		{
			State:       "PENDING",
			SubmittedAt: "", // Draft review should be skipped without error
			Author:      gqlUser{Login: "reviewer2", AvatarURL: "https://avatar2.url"},
		},
		{
			State:       "COMMENTED",
			SubmittedAt: "invalid-timestamp", // Unparseable review should be skipped with warning
			Author:      gqlUser{Login: "reviewer3", AvatarURL: "https://avatar3.url"},
		},
		{
			State:       "CHANGES_REQUESTED",
			SubmittedAt: "2026-08-02T15:30:00Z",
			Body:        "",
			URL:         "https://github.com/org/repo/pull/43#pullrequestreview-4",
			Author:      gqlUser{Login: "reviewer4", AvatarURL: "https://avatar4.url"},
			Comments: struct {
				TotalCount int32              `json:"totalCount"`
				Nodes      []gqlReviewComment `json:"nodes"`
			}{
				TotalCount: 5,
				Nodes: []gqlReviewComment{
					{ID: "c4", ReplyTo: nil},
					{ID: "c5", ReplyTo: nil},
					{ID: "c6", ReplyTo: nil},
					{ID: "c7", ReplyTo: nil},
					{ID: "c8", ReplyTo: &struct {
						ID string `json:"id"`
					}{ID: "c4"}},
				},
			},
		},
	}

	proto, err := pr.toProto()
	require.NoError(t, err)
	require.Len(t, proto.GetReviews(), 2)
	assert.Equal(t, "APPROVED", proto.GetReviews()[0].GetState())
	assert.Equal(t, "reviewer1", proto.GetReviews()[0].GetAuthor().GetLogin())
	assert.Equal(t, "LGTM! Looks good.", proto.GetReviews()[0].GetBody())
	assert.Equal(t, int32(3), proto.GetReviews()[0].GetCommentCount())
	assert.Equal(t, int32(2), proto.GetReviews()[0].GetNewThreadsCount())
	assert.Equal(t, int32(1), proto.GetReviews()[0].GetReplyCount())
	assert.Equal(t, "https://github.com/org/repo/pull/43#pullrequestreview-1", proto.GetReviews()[0].GetUrl())

	assert.Equal(t, "CHANGES_REQUESTED", proto.GetReviews()[1].GetState())
	assert.Equal(t, "reviewer4", proto.GetReviews()[1].GetAuthor().GetLogin())
	assert.Empty(t, proto.GetReviews()[1].GetBody())
	assert.Equal(t, int32(5), proto.GetReviews()[1].GetCommentCount())
	assert.Equal(t, int32(4), proto.GetReviews()[1].GetNewThreadsCount())
	assert.Equal(t, int32(1), proto.GetReviews()[1].GetReplyCount())
	assert.Equal(t, "https://github.com/org/repo/pull/43#pullrequestreview-4", proto.GetReviews()[1].GetUrl())
}

func TestToProto_StateEvents(t *testing.T) {
	pr := gqlPullRequest{
		ID:        "pr_state",
		Number:    99,
		Title:     "State PR",
		UpdatedAt: "2026-08-05T00:00:00Z",
		URL:       "https://github.com/org/repo/pull/99",
		State:     "MERGED",
		Author:    gqlUser{Login: "dev1", AvatarURL: "https://avatar.url"},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}
	pr.TimelineItems.Nodes = []gqlTimelineItemNode{
		{
			Typename: "ClosedEvent",
			ClosedEvent: gqlClosedEvent{
				CreatedAt: "2026-08-04T10:00:00Z",
				URL:       "https://github.com/org/repo/pull/99#event-1",
				Actor:     gqlUser{Login: "closer", AvatarURL: "https://closer.url"},
			},
		},
		{
			Typename: "ReopenedEvent",
			ReopenedEvent: gqlReopenedEvent{
				CreatedAt: "2026-08-04T11:00:00Z",
				Actor:     gqlUser{Login: "reopener", AvatarURL: "https://reopener.url"},
			},
		},
		{
			Typename: "MergedEvent",
			MergedEvent: gqlMergedEvent{
				CreatedAt: "2026-08-05T12:00:00Z",
				URL:       "https://github.com/org/repo/pull/99#event-2",
				Actor:     gqlUser{Login: "merger", AvatarURL: "https://merger.url"},
			},
		},
	}

	proto, err := pr.toProto()
	require.NoError(t, err)
	require.Len(t, proto.GetStateEvents(), 3)

	assert.Equal(t, octodeckv1.StateChangeType_STATE_CHANGE_TYPE_CLOSED, proto.GetStateEvents()[0].GetType())
	assert.Equal(t, "closer", proto.GetStateEvents()[0].GetActor().GetLogin())
	assert.Equal(t, "https://github.com/org/repo/pull/99#event-1", proto.GetStateEvents()[0].GetUrl())

	assert.Equal(t, octodeckv1.StateChangeType_STATE_CHANGE_TYPE_REOPENED, proto.GetStateEvents()[1].GetType())
	assert.Equal(t, "reopener", proto.GetStateEvents()[1].GetActor().GetLogin())

	assert.Equal(t, octodeckv1.StateChangeType_STATE_CHANGE_TYPE_MERGED, proto.GetStateEvents()[2].GetType())
	assert.Equal(t, "merger", proto.GetStateEvents()[2].GetActor().GetLogin())
	assert.Equal(t, "https://github.com/org/repo/pull/99#event-2", proto.GetStateEvents()[2].GetUrl())

	// Test Issue toProto StateEvents (no MergedEvent)
	issue := gqlIssue{
		ID:        "issue_state",
		Number:    100,
		Title:     "State Issue",
		UpdatedAt: "2026-08-05T00:00:00Z",
		URL:       "https://github.com/org/repo/issues/100",
		State:     "CLOSED",
		Author:    gqlUser{Login: "dev2", AvatarURL: "https://avatar2.url"},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}
	issue.TimelineItems.Nodes = []gqlIssueTimelineItemNode{
		{
			Typename: "ClosedEvent",
			ClosedEvent: gqlClosedEvent{
				CreatedAt: "2026-08-04T10:00:00Z",
				URL:       "https://github.com/org/repo/issues/100#event-1",
				Actor:     gqlUser{Login: "closer", AvatarURL: "https://closer.url"},
			},
		},
		{
			Typename: "ReopenedEvent",
			ReopenedEvent: gqlReopenedEvent{
				CreatedAt: "2026-08-04T11:00:00Z",
				Actor:     gqlUser{Login: "reopener", AvatarURL: "https://reopener.url"},
			},
		},
	}

	issueProto, err := issue.toProto()
	require.NoError(t, err)
	require.Len(t, issueProto.GetStateEvents(), 2)
	assert.Equal(t, octodeckv1.StateChangeType_STATE_CHANGE_TYPE_CLOSED, issueProto.GetStateEvents()[0].GetType())
	assert.Equal(t, octodeckv1.StateChangeType_STATE_CHANGE_TYPE_REOPENED, issueProto.GetStateEvents()[1].GetType())
}

func TestParseItemTarget(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		want      ItemTarget
		wantError bool
	}{
		{
			name:  "valid target",
			input: "kubernetes/kubernetes#123",
			want: ItemTarget{
				Owner:  "kubernetes",
				Repo:   "kubernetes",
				Number: 123,
			},
		},
		{
			name:  "valid target with whitespace",
			input: "  owner/repo#456  ",
			want: ItemTarget{
				Owner:  "owner",
				Repo:   "repo",
				Number: 456,
			},
		},
		{
			name:      "missing repo",
			input:     "kubernetes#123",
			wantError: true,
		},
		{
			name:      "missing number",
			input:     "kubernetes/kubernetes#",
			wantError: true,
		},
		{
			name:      "invalid number",
			input:     "kubernetes/kubernetes#abc",
			wantError: true,
		},
		{
			name:      "empty",
			input:     "",
			wantError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseItemTarget(tt.input)
			if tt.wantError {
				assert.Error(t, err)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tt.want, got)
				assert.Equal(t, fmt.Sprintf("%s/%s#%d", tt.want.Owner, tt.want.Repo, tt.want.Number), got.Key())
			}
		})
	}
}

func TestResolveNodeIDs(t *testing.T) {
	t.Run("empty targets", func(t *testing.T) {
		client := &Client{}
		res, err := client.ResolveNodeIDs(t.Context(), nil)
		require.NoError(t, err)
		assert.Empty(t, res)
	})

	t.Run("valid and missing targets from fixture", func(t *testing.T) {
		fixtureBytes, err := os.ReadFile("testdata/resolve_node_ids_response.json")
		require.NoError(t, err)

		var capturedQuery string
		mockHTTP := &mockHTTPClient{
			doFunc: func(req *http.Request) (*http.Response, error) {
				bodyBytes, readErr := io.ReadAll(req.Body)
				require.NoError(t, readErr)

				var bodyMap map[string]string
				require.NoError(t, json.Unmarshal(bodyBytes, &bodyMap))
				capturedQuery = bodyMap["query"]

				return &http.Response{
					StatusCode: http.StatusOK,
					Body:       io.NopCloser(strings.NewReader(string(fixtureBytes))),
					Header:     make(http.Header),
				}, nil
			},
		}

		client := &Client{HTTPClient: mockHTTP}
		targets := []ItemTarget{
			{Owner: "kubernetes", Repo: "kubernetes", Number: 135309},
			{Owner: "kubernetes", Repo: "kubernetes", Number: 135929},
			{Owner: "kubernetes", Repo: "kubernetes", Number: 999999},
		}

		res, err := client.ResolveNodeIDs(t.Context(), targets)
		require.NoError(t, err)
		assert.Contains(t, capturedQuery, `q0: repository(owner: "kubernetes", name: "kubernetes")`)
		assert.Contains(t, capturedQuery, `q1: repository(owner: "kubernetes", name: "kubernetes")`)
		assert.Contains(t, capturedQuery, `q2: repository(owner: "kubernetes", name: "kubernetes")`)

		assert.Len(t, res, 2)
		assert.Equal(t, "PR_kwDOAToIks6zimkN", res[targets[0]])
		assert.Equal(t, "I_kwDOAToIks7gNKvx", res[targets[1]])
		_, exists := res[targets[2]]
		assert.False(t, exists, "missing node should not be in result map")
	})

	t.Run("http error", func(t *testing.T) {
		mockHTTP := &mockHTTPClient{
			doFunc: func(_ *http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode: http.StatusInternalServerError,
					Body:       io.NopCloser(strings.NewReader("server error")),
				}, nil
			},
		}
		client := &Client{HTTPClient: mockHTTP}
		_, err := client.ResolveNodeIDs(t.Context(), []ItemTarget{
			{Owner: "k8s", Repo: "k8s", Number: 1},
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "status 500")
	})
}

func TestToProto_ViewerSubscription(t *testing.T) {
	issue := gqlIssue{
		ID:                 "issue_sub",
		Number:             10,
		Title:              "Sub Issue",
		UpdatedAt:          "2026-08-05T00:00:00Z",
		URL:                "https://github.com/org/repo/issues/10",
		State:              "OPEN",
		ViewerSubscription: "SUBSCRIBED",
		Author:             gqlUser{Login: "author1"},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}

	proto, err := issue.toProto()
	require.NoError(t, err)
	assert.Equal(t, octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED, proto.GetViewerSubscription())

	pr := gqlPullRequest{
		ID:                 "pr_sub",
		Number:             20,
		Title:              "Sub PR",
		UpdatedAt:          "2026-08-05T00:00:00Z",
		URL:                "https://github.com/org/repo/pull/20",
		State:              "OPEN",
		ViewerSubscription: "UNSUBSCRIBED",
		Author:             gqlUser{Login: "author2"},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}

	prProto, err := pr.toProto()
	require.NoError(t, err)
	assert.Equal(t, octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED, prProto.GetViewerSubscription())

	// Test IGNORED
	pr.ViewerSubscription = "IGNORED"
	prProto, err = pr.toProto()
	require.NoError(t, err)
	assert.Equal(t, octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_IGNORED, prProto.GetViewerSubscription())

	// Test Unspecified/Empty
	pr.ViewerSubscription = ""
	prProto, err = pr.toProto()
	require.NoError(t, err)
	assert.Equal(t, octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSPECIFIED, prProto.GetViewerSubscription())
}

func TestToProto_AssignedEvent(t *testing.T) {
	pr := gqlPullRequest{
		ID:        "pr_assigned",
		Number:    50,
		Title:     "Assigned PR",
		UpdatedAt: "2026-08-05T00:00:00Z",
		URL:       "https://github.com/org/repo/pull/50",
		State:     "OPEN",
		Author:    gqlUser{Login: "author"},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}

	var assigneeUser gqlAssignee
	assigneeUser.User.Login = "myuser"
	assigneeUser.User.AvatarURL = "https://avatar.url/myuser"

	var otherAssignee gqlAssignee
	otherAssignee.User.Login = "otheruser"

	pr.TimelineItems.Nodes = []gqlTimelineItemNode{
		{
			Typename: "AssignedEvent",
			AssignedEvent: gqlAssignedEvent{
				CreatedAt: "2026-08-05T10:00:00Z",
				Actor:     gqlUser{Login: "manager", AvatarURL: "https://avatar.url/manager"},
				Assignee:  assigneeUser,
			},
		},
		{
			Typename: "AssignedEvent",
			AssignedEvent: gqlAssignedEvent{
				CreatedAt: "2026-08-05T11:00:00Z",
				Actor:     gqlUser{Login: "manager", AvatarURL: "https://avatar.url/manager"},
				Assignee:  otherAssignee,
			},
		},
	}

	// 1. When currentUser is "myuser", only assignment to "myuser" is retained
	proto, err := pr.toProto("myuser")
	require.NoError(t, err)
	require.Len(t, proto.GetStateEvents(), 1)
	assert.Equal(t, octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED, proto.GetStateEvents()[0].GetType())
	assert.Equal(t, "manager", proto.GetStateEvents()[0].GetActor().GetLogin())

	// 2. When currentUser is "otheruser", only assignment to "otheruser" is retained
	protoOther, err := pr.toProto("otheruser")
	require.NoError(t, err)
	require.Len(t, protoOther.GetStateEvents(), 1)
	assert.Equal(t, octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED, protoOther.GetStateEvents()[0].GetType())

	// 3. When currentUser is "thirduser", no assignment events match
	protoThird, err := pr.toProto("thirduser")
	require.NoError(t, err)
	assert.Empty(t, protoThird.GetStateEvents())

	// 4. Test on Issue with Bot assignee
	issue := gqlIssue{
		ID:        "issue_assigned",
		Number:    51,
		Title:     "Assigned Issue",
		UpdatedAt: "2026-08-05T00:00:00Z",
		URL:       "https://github.com/org/repo/issues/51",
		State:     "OPEN",
		Author:    gqlUser{Login: "author"},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}
	issue.TimelineItems.Nodes = []gqlIssueTimelineItemNode{
		{
			Typename: "AssignedEvent",
			AssignedEvent: gqlAssignedEvent{
				CreatedAt: "2026-08-05T12:00:00Z",
				Actor:     gqlUser{Login: "assigner"},
				Assignee:  assigneeUser,
			},
		},
	}
	issueProto, err := issue.toProto("myuser")
	require.NoError(t, err)
	require.Len(t, issueProto.GetStateEvents(), 1)
	assert.Equal(t, octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED, issueProto.GetStateEvents()[0].GetType())
}

func TestFetchItemsByIDs(t *testing.T) {
	response := loadTestResponse(t, "testdata/items_response.json")

	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			require.Equal(t, "ItemsFetch", name)
			require.NotNil(t, vars["ids"])

			bytes, err := json.Marshal(response)
			if err != nil {
				return err
			}
			return json.Unmarshal(bytes, q)
		},
	}

	client := &Client{GraphQLClient: mockGQL}
	items, missing, err := client.FetchItemsByIDs(t.Context(), []string{
		"PR_kwDOAToIks6zimkN",
		"I_kwDOAToIks7gNKvx",
	})
	require.NoError(t, err)
	assert.Empty(t, missing)
	require.Len(t, items, 2)
}

func TestGraphQLQueryConstruction_NoUnionSelectionErrors(t *testing.T) {
	var recordedQueries []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		var req struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal(body, &req)
		recordedQueries = append(recordedQueries, req.Query)
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(req.Query, "search(") {
			_, _ = w.Write([]byte(`{"data":{"search":{"nodes":[]}}}`))
		} else {
			_, _ = w.Write([]byte(`{"data":{"nodes":[]}}`))
		}
	}))
	defer server.Close()

	gqlClient := graphql.NewClient(server.URL, server.Client())

	// 1. Verify fetchAllItems search query
	var searchQuery struct {
		Search struct {
			Nodes    []gqlSearchResultNode
			PageInfo pageInfo
		} `graphql:"search(query: $query, type: ISSUE_ADVANCED, first: $first, after: $cursor)"`
	}
	searchVars := map[string]any{
		"query":  graphql.String("is:open (assignee:@me OR author:@me) sort:updated-desc"),
		"first":  graphql.Int(10),
		"cursor": (*graphql.String)(nil),
	}
	err := gqlClient.Query(t.Context(), &searchQuery, searchVars)
	require.NoError(t, err)
	require.NotEmpty(t, recordedQueries)

	searchQueryStr := recordedQueries[0]
	assert.Contains(t, searchQueryStr, "... on AssignedEvent")
	assert.Contains(t, searchQueryStr, "assignee")
	assert.Contains(t, searchQueryStr, "... on User")
	assert.Contains(t, searchQueryStr, "... on Bot")
	assert.NotContains(t, searchQueryStr, "assignee{login", "Direct selection on union Assignee is invalid")
	assert.NotContains(t, searchQueryStr, "assignee{avatarUrl", "Direct selection on union Assignee is invalid")
	assert.NotContains(t, searchQueryStr, "-", "Hyphen is not a valid GraphQL field")

	// 2. Verify FetchItemsByIDs nodes query
	var nodesQuery struct {
		Nodes []*gqlSearchResultNode `graphql:"nodes(ids: $ids)"`
	}
	nodesVars := map[string]any{
		"ids": []graphql.ID{graphql.ID("test_id")},
	}
	err = gqlClient.Query(t.Context(), &nodesQuery, nodesVars)
	require.NoError(t, err)
	require.Len(t, recordedQueries, 2)

	nodesQueryStr := recordedQueries[1]
	assert.NotContains(t, nodesQueryStr, "assignee{login", "Direct selection on union Assignee is invalid")
	assert.NotContains(t, nodesQueryStr, "assignee{avatarUrl", "Direct selection on union Assignee is invalid")
	assert.NotContains(t, nodesQueryStr, "-", "Hyphen is not a valid GraphQL field")
}
