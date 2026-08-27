package logic

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/github"
)

func TestSyncEngine_AutoAck(t *testing.T) {
	const (
		currentUser = "me"
		expectedID  = "PR_1"
		repoName    = "owner/repo"
	)

	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	mockGQL := &mockGraphQLClient{}

	// TODO: Extract this to a common testing function.
	mockREST := &mockRESTClient{}
	mockREST.doFunc = func(_ context.Context, _ string, path string, _ io.Reader,
		response any) error {
		if path == "user" {
			return json.Unmarshal(fmt.Appendf(nil, `{"login": "%s"}`, currentUser), response)
		}
		return nil
	}

	mockGQL.queryFunc = func(_ context.Context, name string, q any, _ map[string]any) error {
		if name == inventoryQueryName {
			jsonData := fmt.Sprintf(`
            {
                "search": { 
					"nodes": [
						{ 
							"__typename": "PullRequest",
							"pullRequest": {
								"id": "%s",
								"repository": { "nameWithOwner": "%s" },
								"number": 1,
								"state": "OPEN",
								"updatedAt": "2024-01-02T00:00:00Z",
								"title": "PR Title",
								"url": "http://test",
								"author": { "login": "author" },
								"comments": { "nodes": [
									{ "createdAt": "2024-01-01T00:00:00Z", "bodyText": "Question",
										"author": { "login": "other" } },
									{ "createdAt": "2024-01-02T00:00:00Z", "bodyText": "My Answer",
										"author": { "login": "%s" } }
								]},
								"assignees": { "nodes": [] },
								"commits": { "nodes": [] },
								"reviews": { "nodes": [] }
							}
						}
					],
					"pageInfo": {
						"hasNextPage": false,
						"endCursor": "cursor"
					}
				}
            }`, expectedID, repoName, currentUser)
			return json.Unmarshal([]byte(jsonData), q)
		}
		return nil
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL}
	cfg := config.NewForTest(octodeckv1.Config_builder{
		KnownBots:          []string{},
		AutoAckOwnActivity: config.Ptr(true),
	}.Build())
	engine := NewSyncEngine(db, ghClient, cfg)

	err := engine.RunInventorySync(t.Context())
	require.NoError(t, err)

	items, err := db.GetItems(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, items, 1)

	// Last comment was from "me", so it should be auto-acked at the comment time (2024-01-02T00:00:00Z)
	require.NotNil(t, items[0].GetLocal().GetAckedAt())
	assert.Equal(t, "2024-01-02T00:00:00Z", items[0].GetLocal().GetAckedAt().AsTime().Format("2006-01-02T15:04:05Z"))
	statusRes := CalculateStatus(items[0], "me", nil)
	assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, statusRes.Status)
}
