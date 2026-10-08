package logic

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

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

	// The comments and updatedAt served by the mock; changed between sync passes.
	updatedAt := "2024-01-02T00:00:00Z"
	comments := fmt.Sprintf(`
		{ "createdAt": "2024-01-01T00:00:00Z", "bodyText": "Question",
			"author": { "login": "other" } },
		{ "createdAt": "2024-01-02T00:00:00Z", "bodyText": "My Answer",
			"author": { "login": "%s" } }`, currentUser)

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
								"updatedAt": "%s",
								"title": "PR Title",
								"url": "http://test",
								"author": { "login": "author" },
								"comments": { "nodes": [%s]},
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
            }`, expectedID, repoName, updatedAt, comments)
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
	firstComment := time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC)
	assertAckFields(t, items[0], firstComment, firstComment)
	status := CalculateStatus(items[0], "me", nil)
	assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, status)

	// A second pass where the user commented again: the item is still ACKED (own activity never
	// un-acks), and the watermark must advance to the new comment.
	updatedAt = "2024-01-03T00:00:00Z"
	comments += fmt.Sprintf(`,
		{ "createdAt": "2024-01-03T00:00:00Z", "bodyText": "Follow-up",
			"author": { "login": "%s" } }`, currentUser)
	require.NoError(t, engine.RunInventorySync(t.Context()))

	items, err = db.GetItems(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, items, 1)
	secondComment := time.Date(2024, 1, 3, 0, 0, 0, 0, time.UTC)
	assertAckFields(t, items[0], secondComment, secondComment)
	assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, CalculateStatus(items[0], "me", nil))
}

func newAutoAckTestEngine(enabled bool) *SyncEngine {
	return &SyncEngine{
		cfg: config.NewForTest(octodeckv1.Config_builder{
			KnownBots:          ackTestBots(),
			AutoAckOwnActivity: config.Ptr(enabled),
		}.Build()),
		gh: &github.Client{CurrentUser: ackTestUser},
	}
}

func assertAckFields(t *testing.T, item *octodeckv1.Item, wantAction, wantWatermark time.Time) {
	t.Helper()
	local := item.GetLocal()
	require.True(t, IsAcked(local))
	assert.True(t, wantAction.Equal(local.GetAckedAt().AsTime()),
		"acked_at: want %v, got %v", wantAction, local.GetAckedAt().AsTime())
	assert.True(t, wantWatermark.Equal(local.GetAckedActivityAt().AsTime()),
		"acked_activity_at: want %v, got %v", wantWatermark, local.GetAckedActivityAt().AsTime())
}

func TestCalculateItemState_AutoAck(t *testing.T) {
	t.Run("auto-ack sets both fields to the own event time", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		item.SetComments([]*octodeckv1.Comment{
			ackTestComment(ackTestOther, ackTestTime(1)),
			ackTestComment(ackTestUser, ackTestTime(2)),
		})
		touch(item, ackTestTime(2))
		newAutoAckTestEngine(true).calculateItemState(item)
		assertAckFields(t, item, ackTestTime(2), ackTestTime(2))
	})

	t.Run("regression: own comment after an existing ack advances the watermark", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		w := ackTestTime(1)
		SetAcked(item.GetLocal(), ackTestTime(5), w)
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestUser, ackTestTime(10))})
		touch(item, ackTestTime(10))
		require.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, CalculateStatus(item, ackTestUser, ackTestBots()),
			"precondition: own activity never un-acks")

		newAutoAckTestEngine(true).calculateItemState(item)
		assertAckFields(t, item, ackTestTime(10), ackTestTime(10))
	})

	t.Run("legacy row: own comment after acked_at-only watermark advances both fields", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		item.GetLocal().SetAckedAt(timestamppb.New(ackTestTime(1)))
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestUser, ackTestTime(10))})
		touch(item, ackTestTime(10))
		newAutoAckTestEngine(true).calculateItemState(item)
		assertAckFields(t, item, ackTestTime(10), ackTestTime(10))
	})

	t.Run("no write when own event is not after the watermark", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		action, w := ackTestTime(100), ackTestTime(10)
		SetAcked(item.GetLocal(), action, w)
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestUser, w)})
		newAutoAckTestEngine(true).calculateItemState(item)
		assertAckFields(t, item, action, w)
	})

	t.Run("never moves the watermark backwards", func(t *testing.T) {
		// Someone else's commit after the watermark un-acks the item, but the latest significant
		// event (commits are not significant) is the user's own older comment.
		item := ackTestItem(ackTestOther)
		action, w := ackTestTime(100), ackTestTime(10)
		SetAcked(item.GetLocal(), action, w)
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestUser, ackTestTime(5))})
		item.SetCommits([]*octodeckv1.Commit{ackTestCommit(ackTestOther, ackTestTime(20))})
		touch(item, ackTestTime(20))
		require.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE, CalculateStatus(item, ackTestUser, ackTestBots()))

		newAutoAckTestEngine(true).calculateItemState(item)
		assertAckFields(t, item, action, w)
	})

	t.Run("own commit after own comment does not regress anything", func(t *testing.T) {
		for _, prAuthor := range []string{ackTestUser, ackTestOther} {
			item := ackTestItem(prAuthor)
			item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestUser, ackTestTime(5))})
			item.SetCommits([]*octodeckv1.Commit{ackTestCommit(ackTestUser, ackTestTime(20))})
			touch(item, ackTestTime(20))
			newAutoAckTestEngine(true).calculateItemState(item)
			assertAckFields(t, item, ackTestTime(5), ackTestTime(5))
			assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED,
				CalculateStatus(item, ackTestUser, ackTestBots()), "PR author %q", prAuthor)
		}
	})

	t.Run("bot state event after own comment does not block auto-ack", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestUser, ackTestTime(5))})
		item.SetStateEvents([]*octodeckv1.StateEvent{ackTestStateEvent(ackTestBot, ackTestTime(6))})
		touch(item, ackTestTime(6))
		newAutoAckTestEngine(true).calculateItemState(item)
		assertAckFields(t, item, ackTestTime(5), ackTestTime(5))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, CalculateStatus(item, ackTestUser, ackTestBots()))
	})

	t.Run("regression: bot review after own comment does not block advancing the watermark", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		SetAcked(item.GetLocal(), ackTestTime(1), ackTestTime(1))
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestUser, ackTestTime(10))})
		item.SetReviews([]*octodeckv1.Review{ackTestBotReview(ackTestTime(11))})
		touch(item, ackTestTime(11))
		require.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, CalculateStatus(item, ackTestUser, ackTestBots()),
			"precondition: bot reviews are noise")

		newAutoAckTestEngine(true).calculateItemState(item)
		assertAckFields(t, item, ackTestTime(10), ackTestTime(10))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, CalculateStatus(item, ackTestUser, ackTestBots()))
	})

	t.Run("keeps a later explicit acked_at while advancing the watermark", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		explicitAck := ackTestTime(100)
		SetAcked(item.GetLocal(), explicitAck, ackTestTime(1))
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestUser, ackTestTime(10))})
		touch(item, ackTestTime(10))

		newAutoAckTestEngine(true).calculateItemState(item)
		assertAckFields(t, item, explicitAck, ackTestTime(10))
	})

	t.Run("pending review does not auto-ack", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestOther, ackTestTime(1))})
		item.SetReviews([]*octodeckv1.Review{octodeckv1.Review_builder{
			State:  config.Ptr("PENDING"),
			Author: ackTestUserProto(ackTestUser),
			Comments: []*octodeckv1.ReviewComment{octodeckv1.ReviewComment_builder{
				CreatedAt: timestamppb.New(ackTestTime(2)),
			}.Build()},
		}.Build()})
		touch(item, ackTestTime(2))
		newAutoAckTestEngine(true).calculateItemState(item)
		assert.False(t, IsAcked(item.GetLocal()))
	})

	t.Run("disabled config does nothing", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestUser, ackTestTime(2))})
		newAutoAckTestEngine(false).calculateItemState(item)
		assert.False(t, IsAcked(item.GetLocal()))
	})
}
