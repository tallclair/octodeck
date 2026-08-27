package github

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

type mockHTTPDoer struct {
	doFunc func(req *http.Request) (*http.Response, error)
}

func (m *mockHTTPDoer) Do(req *http.Request) (*http.Response, error) {
	return m.doFunc(req)
}

// TestChallenger_ResolveNodeIDs_LargeBatchStress tests batching >30 targets across multiple GraphQL requests.
func TestChallenger_ResolveNodeIDs_LargeBatchStress(t *testing.T) {
	const totalTargets = 75 // 30 + 30 + 15 = 3 batches
	var targets []ItemTarget
	for i := 1; i <= totalTargets; i++ {
		targets = append(targets, ItemTarget{
			Owner:  "kubernetes",
			Repo:   fmt.Sprintf("repo-%d", i),
			Number: int32(i),
		})
	}

	requestCount := 0
	mockHTTP := &mockHTTPDoer{
		doFunc: func(req *http.Request) (*http.Response, error) {
			requestCount++
			bodyBytes, err := io.ReadAll(req.Body)
			require.NoError(t, err)

			var reqMap map[string]string
			require.NoError(t, json.Unmarshal(bodyBytes, &reqMap))
			query := reqMap["query"]

			// Construct response containing q0, q1, ... based on query
			dataMap := make(map[string]any)
			for idx := range resolveNodeIDsBatchSize {
				alias := fmt.Sprintf("q%d", idx)
				if strings.Contains(query, alias+":") {
					// Make odd items present, even items null/missing
					if idx%2 == 1 {
						dataMap[alias] = map[string]any{
							"issueOrPullRequest": map[string]any{
								"id": fmt.Sprintf("NODE_ID_%d_%d", requestCount, idx),
							},
						}
					} else {
						dataMap[alias] = map[string]any{
							"issueOrPullRequest": nil,
						}
					}
				}
			}

			respData := map[string]any{"data": dataMap}
			respBytes, err := json.Marshal(respData)
			require.NoError(t, err)

			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(bytes.NewReader(respBytes)),
				Header:     make(http.Header),
			}, nil
		},
	}

	client := &Client{HTTPClient: mockHTTP}
	resolved, err := client.ResolveNodeIDs(t.Context(), targets)
	require.NoError(t, err)

	assert.Equal(t, 3, requestCount, "Expected 3 batched GraphQL requests for 75 targets (30+30+15)")
	// Check that resolved items match odd indices
	for i, target := range targets {
		idxInBatch := i % resolveNodeIDsBatchSize
		if idxInBatch%2 == 1 {
			expectedID := fmt.Sprintf("NODE_ID_%d_%d", (i/resolveNodeIDsBatchSize)+1, idxInBatch)
			assert.Equal(t, expectedID, resolved[target], "Target %s should resolve to %s", target.Key(), expectedID)
		} else {
			_, exists := resolved[target]
			assert.False(t, exists, "Even target %s should be omitted (nil node)", target.Key())
		}
	}
}

// TestChallenger_ResolveNodeIDs_SpecialCharacters tests repo/owner with unusual characters.
func TestChallenger_ResolveNodeIDs_SpecialCharacters(t *testing.T) {
	targets := []ItemTarget{
		{Owner: "owner.with.dots", Repo: "repo-with-dashes", Number: 10},
		{Owner: "owner_with_underscores", Repo: "repo.name_with-mixed", Number: 20},
	}

	var capturedQuery string
	mockHTTP := &mockHTTPDoer{
		doFunc: func(req *http.Request) (*http.Response, error) {
			bodyBytes, err := io.ReadAll(req.Body)
			require.NoError(t, err)
			var reqMap map[string]string
			require.NoError(t, json.Unmarshal(bodyBytes, &reqMap))
			capturedQuery = reqMap["query"]

			respData := map[string]any{
				"data": map[string]any{
					"q0": map[string]any{"issueOrPullRequest": map[string]any{"id": "NODE_1"}},
					"q1": map[string]any{"issueOrPullRequest": map[string]any{"id": "NODE_2"}},
				},
			}
			respBytes, _ := json.Marshal(respData)
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(bytes.NewReader(respBytes)),
			}, nil
		},
	}

	client := &Client{HTTPClient: mockHTTP}
	res, err := client.ResolveNodeIDs(t.Context(), targets)
	require.NoError(t, err)
	assert.Equal(t, "NODE_1", res[targets[0]])
	assert.Equal(t, "NODE_2", res[targets[1]])
	assert.Contains(t, capturedQuery, `owner: "owner.with.dots"`)
	assert.Contains(t, capturedQuery, `name: "repo.name_with-mixed"`)
}

// TestChallenger_FetchItemsByIDs_LargeBatchStress tests batching >50 IDs across multiple GraphQL requests.
func TestChallenger_FetchItemsByIDs_LargeBatchStress(t *testing.T) {
	const totalIDs = 135 // 50 + 50 + 35 = 3 batches
	var ids []string
	for i := 1; i <= totalIDs; i++ {
		ids = append(ids, fmt.Sprintf("NODE_%03d", i))
	}

	queryCalls := 0
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, vars map[string]any) error {
			assert.Equal(t, "ItemsFetch", name)
			queryCalls++

			batchIDs, ok := vars["ids"].([]string)
			require.True(t, ok)

			var nodes []any
			for i, id := range batchIDs {
				// Simulate: every 5th item is deleted (null node)
				if i%5 == 0 {
					nodes = append(nodes, nil)
				} else {
					nodes = append(nodes, map[string]any{
						"__typename": "PullRequest",
						"pullRequest": map[string]any{
							"id":                 id,
							"repository":         map[string]any{"nameWithOwner": "k8s/k8s"},
							"number":             float64(i + 1),
							"title":              fmt.Sprintf("PR for %s", id),
							"state":              "OPEN",
							"updatedAt":          "2026-08-14T00:00:00Z",
							"url":                fmt.Sprintf("https://github.com/k8s/k8s/pull/%d", i+1),
							"author":             map[string]any{"login": "author1"},
							"viewerSubscription": "SUBSCRIBED",
						},
					})
				}
			}

			data := map[string]any{
				"nodes": nodes,
			}
			b, _ := json.Marshal(data)
			return json.Unmarshal(b, q)
		},
	}

	client := &Client{GraphQLClient: mockGQL}
	items, missing, err := client.FetchItemsByIDs(t.Context(), ids)
	require.NoError(t, err)

	assert.Equal(t, 3, queryCalls, "Expected 3 GraphQL batch calls (50+50+35)")
	// In each batch:
	// Batch 1 (50 items): indices 0, 5, 10, 15, 20, 25, 30, 35, 40, 45 -> 10 missing, 40 found
	// Batch 2 (50 items): indices 0, 5, 10, 15, 20, 25, 30, 35, 40, 45 -> 10 missing, 40 found
	// Batch 3 (35 items): indices 0, 5, 10, 15, 20, 25, 30 -> 7 missing, 28 found
	// Total missing = 27, Total found = 108
	assert.Len(t, missing, 27)
	assert.Len(t, items, 108)

	// Verify all returned items have valid properties
	for _, it := range items {
		assert.Equal(t, octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED, it.GetViewerSubscription())
		assert.NotEmpty(t, it.GetId())
		assert.NotEmpty(t, it.GetTitle())
	}
}

// TestChallenger_ViewerSubscription_AllEnumValues tests all variations of viewerSubscription string mapping.
func TestChallenger_ViewerSubscription_AllEnumValues(t *testing.T) {
	tests := []struct {
		input    string
		expected octodeckv1.SubscriptionState
	}{
		{"SUBSCRIBED", octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED},
		{"UNSUBSCRIBED", octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED},
		{"IGNORED", octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_IGNORED},
		{"", octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSPECIFIED},
		{"UNKNOWN_VALUE", octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSPECIFIED},
	}

	for _, tt := range tests {
		t.Run("Issue_"+tt.input, func(t *testing.T) {
			issue := gqlIssue{
				ID:                 "issue_sub_test",
				Number:             1,
				Title:              "Sub Test",
				UpdatedAt:          "2026-08-01T00:00:00Z",
				State:              "OPEN",
				ViewerSubscription: tt.input,
				Author:             gqlUser{Login: "user"},
				Repository: struct {
					NameWithOwner string `json:"nameWithOwner"`
				}{NameWithOwner: "org/repo"},
			}
			proto, err := issue.toProto()
			require.NoError(t, err)
			assert.Equal(t, tt.expected, proto.GetViewerSubscription())
		})

		t.Run("PR_"+tt.input, func(t *testing.T) {
			pr := gqlPullRequest{
				ID:                 "pr_sub_test",
				Number:             2,
				Title:              "PR Sub Test",
				UpdatedAt:          "2026-08-01T00:00:00Z",
				State:              "OPEN",
				ViewerSubscription: tt.input,
				Author:             gqlUser{Login: "user"},
				Repository: struct {
					NameWithOwner string `json:"nameWithOwner"`
				}{NameWithOwner: "org/repo"},
			}
			proto, err := pr.toProto()
			require.NoError(t, err)
			assert.Equal(t, tt.expected, proto.GetViewerSubscription())
		})
	}
}

// TestChallenger_AssignedEvent_BotAndUserHandling verifies timeline ASSIGNED_EVENT conversion for Bots and Users.
func TestChallenger_AssignedEvent_BotAndUserHandling(t *testing.T) {
	pr := gqlPullRequest{
		ID:        "pr_assigned_edge",
		Number:    100,
		Title:     "Bot Assignment Test",
		UpdatedAt: "2026-08-01T00:00:00Z",
		State:     "OPEN",
		Author:    gqlUser{Login: "author"},
		Repository: struct {
			NameWithOwner string `json:"nameWithOwner"`
		}{NameWithOwner: "org/repo"},
	}

	var botAssignee gqlAssignee
	botAssignee.Bot.Login = "mybot"
	botAssignee.Bot.AvatarURL = "https://avatar.url/mybot"

	var userAssignee gqlAssignee
	userAssignee.User.Login = "myuser"
	userAssignee.User.AvatarURL = "https://avatar.url/myuser"

	pr.TimelineItems.Nodes = []gqlTimelineItemNode{
		{
			Typename: "AssignedEvent",
			AssignedEvent: gqlAssignedEvent{
				CreatedAt: "2026-08-01T10:00:00Z",
				Actor:     gqlUser{Login: "admin"},
				Assignee:  botAssignee,
			},
		},
		{
			Typename: "AssignedEvent",
			AssignedEvent: gqlAssignedEvent{
				CreatedAt: "2026-08-01T11:00:00Z",
				Actor:     gqlUser{Login: "admin"},
				Assignee:  userAssignee,
			},
		},
	}

	// 1. When currentUser = "mybot", bot assignment is ingested
	protoBot, err := pr.toProto("mybot")
	require.NoError(t, err)
	require.Len(t, protoBot.GetStateEvents(), 1)
	assert.Equal(t, octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED, protoBot.GetStateEvents()[0].GetType())
	assert.Equal(t, "admin", protoBot.GetStateEvents()[0].GetActor().GetLogin())

	// 2. When currentUser = "myuser", user assignment is ingested
	protoUser, err := pr.toProto("myuser")
	require.NoError(t, err)
	require.Len(t, protoUser.GetStateEvents(), 1)
	assert.Equal(t, octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED, protoUser.GetStateEvents()[0].GetType())

	// 3. When currentUser = "other", neither is ingested
	protoOther, err := pr.toProto("other")
	require.NoError(t, err)
	assert.Empty(t, protoOther.GetStateEvents())
}
