package logic

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

func TestCalculateStatus(t *testing.T) {
	// Setup dates
	lastViewed := time.Date(2023, 1, 1, 12, 0, 0, 0, time.UTC)
	oldDate := time.Date(2023, 1, 1, 10, 0, 0, 0, time.UTC)
	newDate := time.Date(2023, 1, 2, 12, 0, 0, 0, time.UTC)
	currentUser := "me"
	knownBots := []string{"k8s-ci-robot"}

	// Helper to create base item
	createBaseItem := func() *octodeckv1.Item {
		return octodeckv1.Item_builder{
			Id:        config.Ptr("PR_1"),
			Number:    config.Ptr(int32(1)),
			Title:     config.Ptr("Test PR"),
			State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			UpdatedAt: timestamppb.New(newDate),
			Url:       config.Ptr("http://github.com/owner/repo/pull/1"),
			Author:    octodeckv1.User_builder{Login: config.Ptr("other")}.Build(),
			Comments:  []*octodeckv1.Comment{},
			Commits:   []*octodeckv1.Commit{},
			Assignees: []*octodeckv1.User{},
			Local: octodeckv1.ItemLocalState_builder{
				LastViewedAt: timestamppb.New(lastViewed),
			}.Build(),
		}.Build()
	}

	t.Run("returns NEW if lastViewedAt is zero", func(t *testing.T) {
		item := createBaseItem()
		item.GetLocal().ClearLastViewedAt()
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW, result.Status, "expected NEW")
	})

	t.Run("returns IDLE if updated before or at lastViewedAt", func(t *testing.T) {
		item := createBaseItem()
		item.SetUpdatedAt(timestamppb.New(lastViewed)) // Exactly equal
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_IDLE, result.Status, "expected IDLE")
	})

	t.Run("prioritizes NEW_ACTIVITY over NEW_CODE", func(t *testing.T) {
		item := createBaseItem()
		item.SetCommits([]*octodeckv1.Commit{
			octodeckv1.Commit_builder{CommittedDate: timestamppb.New(newDate)}.Build(),
		})
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(newDate),
				BodyText:  config.Ptr("Human comment"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result.Status, "expected NEW_ACTIVITY")
	})

	t.Run("returns NEW_CODE if there are new commits and no new activity", func(t *testing.T) {
		item := createBaseItem()
		item.SetCommits([]*octodeckv1.Commit{
			octodeckv1.Commit_builder{CommittedDate: timestamppb.New(oldDate)}.Build(),
			octodeckv1.Commit_builder{CommittedDate: timestamppb.New(newDate)}.Build(), // New!
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE, result.Status, "expected NEW_CODE")
		assert.Equal(t, 1, result.NewCommitsCount, "expected 1 new commit")
	})

	t.Run("prioritizes NEW_CODE over NOISE", func(t *testing.T) {
		item := createBaseItem()
		item.SetCommits([]*octodeckv1.Commit{
			octodeckv1.Commit_builder{CommittedDate: timestamppb.New(newDate)}.Build(),
		})
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(newDate),
				BodyText:  config.Ptr("CI Successful"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("k8s-ci-robot")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE, result.Status, "expected NEW_CODE")
	})

	t.Run("returns NEW_ACTIVITY for new human comments", func(t *testing.T) {
		item := createBaseItem()
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(oldDate),
				BodyText:  config.Ptr("Old comment"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
			}.Build(),
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(newDate),
				BodyText:  config.Ptr("New comment"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result.Status, "expected NEW_ACTIVITY")
		assert.Equal(t, 1, result.NewCommentsCount, "expected 1 new comment")
	})

	t.Run("returns NOISE if new comments are only bots", func(t *testing.T) {
		item := createBaseItem()
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(newDate),
				BodyText:  config.Ptr("CI Successful"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("k8s-ci-robot")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NOISE, result.Status, "expected NOISE")
		assert.Equal(t, 1, result.NewCommentsCount, "expected 1 new noise comment")
	})

	t.Run("returns NOISE if new comments are only slash commands", func(t *testing.T) {
		item := createBaseItem()
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(newDate),
				BodyText:  config.Ptr("/lgtm"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NOISE, result.Status, "expected NOISE")
	})

	t.Run("returns IDLE if updated but no commits, comments, or reviews", func(t *testing.T) {
		item := createBaseItem()
		item.SetUpdatedAt(timestamppb.New(newDate))
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_IDLE, result.Status, "expected IDLE")
	})

	t.Run("returns NEW_ACTIVITY for new human PR reviews", func(t *testing.T) {
		item := createBaseItem()
		item.SetReviews([]*octodeckv1.Review{
			octodeckv1.Review_builder{
				SubmittedAt: timestamppb.New(oldDate),
				State:       config.Ptr("COMMENTED"),
				Author:      octodeckv1.User_builder{Login: config.Ptr("reviewer")}.Build(),
			}.Build(),
			octodeckv1.Review_builder{
				SubmittedAt: timestamppb.New(newDate),
				State:       config.Ptr("APPROVED"),
				Author:      octodeckv1.User_builder{Login: config.Ptr("reviewer")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result.Status, "expected NEW_ACTIVITY")
		assert.Equal(t, 1, result.NewCommentsCount, "expected 1 new review activity")
	})

	t.Run("ignores self-reviews by currentUser for NEW_ACTIVITY", func(t *testing.T) {
		item := createBaseItem()
		item.SetReviews([]*octodeckv1.Review{
			octodeckv1.Review_builder{
				SubmittedAt: timestamppb.New(newDate),
				State:       config.Ptr("APPROVED"),
				Author:      octodeckv1.User_builder{Login: config.Ptr(currentUser)}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_IDLE, result.Status, "expected IDLE for self review")
	})

	t.Run("returns NOISE for bot PR reviews", func(t *testing.T) {
		item := createBaseItem()
		item.SetReviews([]*octodeckv1.Review{
			octodeckv1.Review_builder{
				SubmittedAt: timestamppb.New(newDate),
				State:       config.Ptr("COMMENTED"),
				Author:      octodeckv1.User_builder{Login: config.Ptr("k8s-ci-robot")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NOISE, result.Status, "expected NOISE for bot review")
	})

	t.Run("returns NEW_ACTIVITY when acked item receives new PR review", func(t *testing.T) {
		item := createBaseItem()
		item.GetLocal().SetAckedAt(timestamppb.New(lastViewed))
		item.SetReviews([]*octodeckv1.Review{
			octodeckv1.Review_builder{
				SubmittedAt: timestamppb.New(newDate),
				State:       config.Ptr("CHANGES_REQUESTED"),
				Author:      octodeckv1.User_builder{Login: config.Ptr("reviewer")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result.Status, "expected NEW_ACTIVITY")
		assert.Equal(t, 1, result.NewCommentsCount, "expected 1 new review count")
	})

	t.Run("combines comments and reviews count in NEW_ACTIVITY", func(t *testing.T) {
		item := createBaseItem()
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(newDate),
				BodyText:  config.Ptr("A comment"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
			}.Build(),
		})
		item.SetReviews([]*octodeckv1.Review{
			octodeckv1.Review_builder{
				SubmittedAt: timestamppb.New(newDate),
				State:       config.Ptr("APPROVED"),
				Author:      octodeckv1.User_builder{Login: config.Ptr("reviewer")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result.Status, "expected NEW_ACTIVITY")
		assert.Equal(t, 2, result.NewCommentsCount, "expected 2 total new activities (1 comment + 1 review)")
	})

	t.Run("returns NEW_ACTIVITY when item receives new state event (closed/merged/reopened)", func(t *testing.T) {
		item := createBaseItem()
		item.SetStateEvents([]*octodeckv1.StateEvent{
			octodeckv1.StateEvent_builder{
				Type:      config.Ptr(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_MERGED),
				CreatedAt: timestamppb.New(newDate),
				Actor:     octodeckv1.User_builder{Login: config.Ptr("merger")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(
			t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result.Status, "expected NEW_ACTIVITY for merged event",
		)
		assert.Equal(t, 1, result.NewCommentsCount)
	})

	t.Run("returns NEW_ACTIVITY when acked item receives new state event", func(t *testing.T) {
		item := createBaseItem()
		item.GetLocal().SetAckedAt(timestamppb.New(lastViewed))
		item.SetStateEvents([]*octodeckv1.StateEvent{
			octodeckv1.StateEvent_builder{
				Type:      config.Ptr(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_REOPENED),
				CreatedAt: timestamppb.New(newDate),
				Actor:     octodeckv1.User_builder{Login: config.Ptr("reopener")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(
			t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result.Status,
			"expected NEW_ACTIVITY for reopened event",
		)
	})

	t.Run("returns NEW_ACTIVITY and un-acks when assigned by another user", func(t *testing.T) {
		item := createBaseItem()
		item.GetLocal().SetAckedAt(timestamppb.New(lastViewed))
		item.SetStateEvents([]*octodeckv1.StateEvent{
			octodeckv1.StateEvent_builder{
				Type:      config.Ptr(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED),
				CreatedAt: timestamppb.New(newDate),
				Actor:     octodeckv1.User_builder{Login: config.Ptr("lead_dev")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(
			t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result.Status,
			"expected NEW_ACTIVITY when assigned by another user",
		)
		assert.Equal(t, 1, result.NewCommentsCount)
	})

	t.Run("does not un-ack when self-assigned", func(t *testing.T) {
		item := createBaseItem()
		item.GetLocal().SetAckedAt(timestamppb.New(lastViewed))
		item.SetStateEvents([]*octodeckv1.StateEvent{
			octodeckv1.StateEvent_builder{
				Type:      config.Ptr(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED),
				CreatedAt: timestamppb.New(newDate),
				Actor:     octodeckv1.User_builder{Login: config.Ptr(currentUser)}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(
			t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, result.Status,
			"expected ACKED when self-assigned",
		)
		assert.Equal(t, 0, result.NewCommentsCount)
	})
}
