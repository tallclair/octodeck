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
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW, result, "expected NEW")
	})

	t.Run("returns IDLE if updated before or at lastViewedAt", func(t *testing.T) {
		item := createBaseItem()
		item.SetUpdatedAt(timestamppb.New(lastViewed)) // Exactly equal
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_IDLE, result, "expected IDLE")
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
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result, "expected NEW_ACTIVITY")
	})

	t.Run("returns NEW_CODE if there are new commits and no new activity", func(t *testing.T) {
		item := createBaseItem()
		item.SetCommits([]*octodeckv1.Commit{
			octodeckv1.Commit_builder{CommittedDate: timestamppb.New(oldDate)}.Build(),
			octodeckv1.Commit_builder{CommittedDate: timestamppb.New(newDate)}.Build(), // New!
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE, result, "expected NEW_CODE")
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
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE, result, "expected NEW_CODE")
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
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result, "expected NEW_ACTIVITY")
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
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NOISE, result, "expected NOISE")
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
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NOISE, result, "expected NOISE")
	})

	t.Run("returns IDLE if updated but no commits, comments, or reviews", func(t *testing.T) {
		item := createBaseItem()
		item.SetUpdatedAt(timestamppb.New(newDate))
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_IDLE, result, "expected IDLE")
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
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result, "expected NEW_ACTIVITY")
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
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_IDLE, result, "expected IDLE for self review")
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
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NOISE, result, "expected NOISE for bot review")
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
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result, "expected NEW_ACTIVITY")
	})

	t.Run("combines comments and reviews in NEW_ACTIVITY", func(t *testing.T) {
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
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result, "expected NEW_ACTIVITY")
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
			t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result, "expected NEW_ACTIVITY for merged event",
		)
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
			t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result,
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
			t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result,
			"expected NEW_ACTIVITY when assigned by another user",
		)
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
			t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, result,
			"expected ACKED when self-assigned",
		)
	})

	t.Run("returns IDLE when un-acked item is viewed (lastViewedAt after un-acking activity)", func(t *testing.T) {
		// Simulates PR_kwDOA3OuhM7jxvDA:
		// 1. Acked at tAck
		// 2. Review received at tActivity (un-acking item)
		// 3. User views item at tView (tView > tActivity > tAck)
		tAck := time.Date(2026, 8, 28, 18, 12, 18, 0, time.UTC)
		tActivity := time.Date(2026, 8, 28, 18, 38, 37, 0, time.UTC)
		tView := time.Date(2026, 9, 2, 19, 13, 38, 0, time.UTC)

		item := createBaseItem()
		item.SetUpdatedAt(timestamppb.New(tActivity))
		item.GetLocal().SetAckedAt(timestamppb.New(tAck))
		item.GetLocal().SetLastViewedAt(timestamppb.New(tView))
		item.SetReviews([]*octodeckv1.Review{
			octodeckv1.Review_builder{
				SubmittedAt: timestamppb.New(tActivity),
				State:       config.Ptr("COMMENTED"),
				Author:      octodeckv1.User_builder{Login: config.Ptr("kannon92")}.Build(),
			}.Build(),
		})

		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(
			t, octodeckv1.ItemStatus_ITEM_STATUS_IDLE, result,
			"viewing un-acked item should reset status to IDLE",
		)
	})

	t.Run("remains ACKED when acked item is viewed without new activity", func(t *testing.T) {
		tAck := time.Date(2026, 8, 28, 18, 12, 18, 0, time.UTC)
		tView := time.Date(2026, 9, 2, 19, 13, 38, 0, time.UTC)

		item := createBaseItem()
		item.SetUpdatedAt(timestamppb.New(tAck))
		item.GetLocal().SetAckedAt(timestamppb.New(tAck))
		item.GetLocal().SetLastViewedAt(timestamppb.New(tView))

		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(
			t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, result,
			"viewing acked item without activity should remain ACKED",
		)
	})

	t.Run("returns NEW_ACTIVITY when un-acked item receives new activity after being viewed", func(t *testing.T) {
		tAck := time.Date(2026, 8, 28, 18, 12, 18, 0, time.UTC)
		tActivity1 := time.Date(2026, 8, 28, 18, 38, 37, 0, time.UTC)
		tView := time.Date(2026, 9, 2, 19, 13, 38, 0, time.UTC)
		tActivity2 := time.Date(2026, 9, 2, 20, 0, 0, 0, time.UTC)

		item := createBaseItem()
		item.SetUpdatedAt(timestamppb.New(tActivity2))
		item.GetLocal().SetAckedAt(timestamppb.New(tAck))
		item.GetLocal().SetLastViewedAt(timestamppb.New(tView))
		item.SetReviews([]*octodeckv1.Review{
			octodeckv1.Review_builder{
				SubmittedAt: timestamppb.New(tActivity1),
				State:       config.Ptr("COMMENTED"),
				Author:      octodeckv1.User_builder{Login: config.Ptr("kannon92")}.Build(),
			}.Build(),
		})
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(tActivity2),
				BodyText:  config.Ptr("Subsequent comment after view"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("reviewer")}.Build(),
			}.Build(),
		})

		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result)
	})

	t.Run("returns NEW_CODE when un-acked item receives new commit after being viewed", func(t *testing.T) {
		tAck := time.Date(2026, 8, 28, 18, 12, 18, 0, time.UTC)
		tActivity1 := time.Date(2026, 8, 28, 18, 38, 37, 0, time.UTC)
		tView := time.Date(2026, 9, 2, 19, 13, 38, 0, time.UTC)
		tCommit := time.Date(2026, 9, 2, 20, 0, 0, 0, time.UTC)

		item := createBaseItem()
		item.SetUpdatedAt(timestamppb.New(tCommit))
		item.GetLocal().SetAckedAt(timestamppb.New(tAck))
		item.GetLocal().SetLastViewedAt(timestamppb.New(tView))
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(tActivity1),
				BodyText:  config.Ptr("Old comment"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("reviewer")}.Build(),
			}.Build(),
		})
		item.SetCommits([]*octodeckv1.Commit{
			octodeckv1.Commit_builder{CommittedDate: timestamppb.New(tCommit)}.Build(),
		})

		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE, result)
	})

	t.Run("returns NEW_MENTION when new comment explicitly mentions currentUser", func(t *testing.T) {
		item := createBaseItem()
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(newDate),
				BodyText:  config.Ptr("Hey @me, could you take a look at this?"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION, result)
	})

	t.Run("prioritizes NEW_MENTION over NEW_ACTIVITY and NEW_CODE", func(t *testing.T) {
		item := createBaseItem()
		item.SetCommits([]*octodeckv1.Commit{
			octodeckv1.Commit_builder{CommittedDate: timestamppb.New(newDate)}.Build(),
		})
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(newDate),
				BodyText:  config.Ptr("Regular comment"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("other_user")}.Build(),
			}.Build(),
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(newDate),
				BodyText:  config.Ptr("Pinging @ME for review"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION, result)
	})

	t.Run("prioritizes NEW_MENTION over NEW when never-viewed item has a mention comment", func(t *testing.T) {
		item := createBaseItem()
		item.GetLocal().ClearLastViewedAt()
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(oldDate),
				BodyText:  config.Ptr("cc @me"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION, result)
	})

	t.Run("returns NEW_MENTION even if comment is a slash command or from a bot", func(t *testing.T) {
		item := createBaseItem()
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(newDate),
				BodyText:  config.Ptr("/cc @me"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("k8s-ci-robot")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION, result)
	})

	t.Run("un-acks item and returns NEW_MENTION when mentioned after ack", func(t *testing.T) {
		item := createBaseItem()
		item.GetLocal().SetAckedAt(timestamppb.New(lastViewed))
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(newDate),
				BodyText:  config.Ptr("/assign @me"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION, result)
	})

	t.Run("ignores self-mentions by currentUser", func(t *testing.T) {
		item := createBaseItem()
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(newDate),
				BodyText:  config.Ptr("Note to @me"),
				Author:    octodeckv1.User_builder{Login: config.Ptr(currentUser)}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_IDLE, result)
	})

	t.Run("ignores old mentions before lastViewedAt", func(t *testing.T) {
		item := createBaseItem()
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(oldDate),
				BodyText:  config.Ptr("Hey @me"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
			}.Build(),
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(newDate),
				BodyText:  config.Ptr("Follow-up without mention"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
			}.Build(),
		})
		result := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, result)
	})

	t.Run("returns NEW_MENTION when PR review body or review comment mentions currentUser", func(t *testing.T) {
		item := createBaseItem()
		item.SetReviews([]*octodeckv1.Review{
			octodeckv1.Review_builder{
				SubmittedAt: timestamppb.New(newDate),
				State:       config.Ptr("COMMENTED"),
				Body:        config.Ptr("Looks good, deferring to @me for final approval."),
				Author:      octodeckv1.User_builder{Login: config.Ptr("reviewer")}.Build(),
			}.Build(),
		})
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION, CalculateStatus(item, currentUser, knownBots))

		itemInline := createBaseItem()
		itemInline.SetReviews([]*octodeckv1.Review{
			octodeckv1.Review_builder{
				SubmittedAt: timestamppb.New(newDate),
				State:       config.Ptr("COMMENTED"),
				Author:      octodeckv1.User_builder{Login: config.Ptr("reviewer")}.Build(),
				Comments: []*octodeckv1.ReviewComment{
					octodeckv1.ReviewComment_builder{
						CreatedAt: timestamppb.New(newDate),
						Body:      config.Ptr("What do you think about this line @me?"),
						Author:    octodeckv1.User_builder{Login: config.Ptr("reviewer")}.Build(),
					}.Build(),
				},
			}.Build(),
		})
		assert.Equal(
			t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION,
			CalculateStatus(itemInline, currentUser, knownBots),
		)
	})

	t.Run("returns NEW_MENTION for pending review comment submitted after view", func(t *testing.T) {
		item := createBaseItem()
		item.SetReviews([]*octodeckv1.Review{
			octodeckv1.Review_builder{
				SubmittedAt: timestamppb.New(newDate),
				State:       config.Ptr("COMMENTED"),
				Author:      octodeckv1.User_builder{Login: config.Ptr("reviewer")}.Build(),
				Comments: []*octodeckv1.ReviewComment{
					octodeckv1.ReviewComment_builder{
						CreatedAt: timestamppb.New(oldDate), // drafted before lastViewed
						Body:      config.Ptr("Please check this @me"),
						Author:    octodeckv1.User_builder{Login: config.Ptr("reviewer")}.Build(),
					}.Build(),
				},
			}.Build(),
		})
		assert.Equal(
			t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION,
			CalculateStatus(item, currentUser, knownBots),
		)
	})

	t.Run("returns NEW_MENTION when never-viewed item mentions currentUser in body", func(t *testing.T) {
		item := createBaseItem()
		item.GetLocal().ClearLastViewedAt()
		item.SetCreatedAt(timestamppb.New(oldDate))
		item.SetBody("Opening this PR for @me to review")
		assert.Equal(
			t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION,
			CalculateStatus(item, currentUser, knownBots),
		)

		// Once viewed after creation, the initial body mention does not re-trigger NEW_MENTION on unrelated commits.
		item.GetLocal().SetLastViewedAt(timestamppb.New(lastViewed))
		item.SetCommits([]*octodeckv1.Commit{
			octodeckv1.Commit_builder{CommittedDate: timestamppb.New(newDate)}.Build(),
		})
		assert.Equal(
			t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE,
			CalculateStatus(item, currentUser, knownBots),
		)
	})
}

func TestContainsMention(t *testing.T) {
	tests := []struct {
		name     string
		text     string
		username string
		expected bool
	}{
		{"exact match", "@tallclair", "tallclair", true},
		{"case insensitive", "Hey @TallClair!", "tallclair", true},
		{"username with leading at", "cc @tallclair", "@tallclair", true},
		{"followed by period at end of sentence", "Thanks @tallclair.", "tallclair", true},
		{"followed by period and space", "Ask @tallclair. They know.", "tallclair", true},
		{"in parentheses", "(cc @tallclair)", "tallclair", true},
		{"prefix substring mismatch", "Hey @tallclair2", "tallclair", false},
		{"hyphenated suffix mismatch", "Hey @tallclair-bot", "tallclair", false},
		{"underscore suffix mismatch", "Hey @tallclair_dev", "tallclair", false},
		{"email address mismatch", "Contact user@tallclair.com for info", "tallclair", false},
		{"domain like suffix mismatch", "Visit @tallclair.com", "tallclair", false},
		{"team mention mismatch", "Ping @tallclair/maintainers", "tallclair", false},
		{"inline code ignored", "Use `@tallclair` in config", "tallclair", false},
		{"multi-backtick inline code ignored", "Use `` `@tallclair` `` in config", "tallclair", false},
		{
			"mention after multi-backtick inline code",
			"Here is `` ` `` and @tallclair outside `code`",
			"tallclair",
			true,
		},
		{"fenced code block ignored", "```yaml\nowner: @tallclair\n```", "tallclair", false},
		{"blockquote reply ignored", "> Hey @tallclair, PTAL\n\nDone!", "tallclair", false},
		{"indented blockquote ignored", "  > cc @tallclair\nFixed.", "tallclair", false},
		{"mention outside blockquote detected", "> Quoted line\n\nHey @tallclair, PTAL!", "tallclair", true},
		{"html comment ignored", "<!-- cc @tallclair -->\nLGTM", "tallclair", false},
		{"mention outside inline code", "Run `make test` and ping @tallclair", "tallclair", true},
		{"empty username", "Hey @tallclair", "", false},
		{"empty text", "", "tallclair", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.expected, ContainsMention(tc.text, tc.username))
		})
	}
}
