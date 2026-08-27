package logic

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

func TestShouldAutoAck(t *testing.T) {
	currentUser := "me"
	knownBots := []string{"github-actions[bot]"}

	baseItem := octodeckv1.Item_builder{
		Id:     config.Ptr("1"),
		Number: config.Ptr(int32(1)),
		Title:  config.Ptr("Test PR"),
		State:  config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		Url:    config.Ptr("http://github.com/owner/repo/pull/1"),
		Author: octodeckv1.User_builder{Login: config.Ptr("other")}.Build(),
	}.Build()

	createComments := func(lastAuthor, lastBody string, lastTime time.Time) []*octodeckv1.Comment {
		return []*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(time.Now().Add(-2 * time.Hour)),
				BodyText:  config.Ptr("Hello"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("other")}.Build(),
			}.Build(),
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(lastTime),
				BodyText:  config.Ptr(lastBody),
				Author:    octodeckv1.User_builder{Login: config.Ptr(lastAuthor)}.Build(),
			}.Build(),
		}
	}

	t.Run("should return false if there are no events", func(t *testing.T) {
		shouldAck, _ := ShouldAutoAck(baseItem, currentUser, knownBots)
		assert.False(t, shouldAck)
	})

	t.Run("should return true if the last comment is from the current user", func(t *testing.T) {
		item := proto.Clone(baseItem).(*octodeckv1.Item)
		myCommentTime := time.Now().Add(-1 * time.Hour).Truncate(time.Second)
		item.SetComments(createComments(currentUser, "My reply", myCommentTime))
		shouldAck, ackTime := ShouldAutoAck(item, currentUser, knownBots)
		assert.True(t, shouldAck)
		assert.True(t, ackTime.Equal(myCommentTime))
	})

	t.Run("should return true if own comment contains slash commands", func(t *testing.T) {
		item := proto.Clone(baseItem).(*octodeckv1.Item)
		myCommentTime := time.Now().Add(-1 * time.Hour).Truncate(time.Second)
		item.SetComments(createComments(currentUser, "/lgtm\n/approve", myCommentTime))
		shouldAck, ackTime := ShouldAutoAck(item, currentUser, knownBots)
		assert.True(t, shouldAck)
		assert.True(t, ackTime.Equal(myCommentTime))
	})

	t.Run("should return false if the last comment is from another user", func(t *testing.T) {
		item := proto.Clone(baseItem).(*octodeckv1.Item)
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(time.Now().Add(-2 * time.Hour)),
				BodyText:  config.Ptr("My reply"),
				Author:    octodeckv1.User_builder{Login: config.Ptr(currentUser)}.Build(),
			}.Build(),
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(time.Now().Add(-1 * time.Hour)),
				BodyText:  config.Ptr("Response"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("other")}.Build(),
			}.Build(),
		})
		shouldAck, _ := ShouldAutoAck(item, currentUser, knownBots)
		assert.False(t, shouldAck)
	})

	t.Run("should ignore bot comments (noise) when determining last action", func(t *testing.T) {
		item := proto.Clone(baseItem).(*octodeckv1.Item)
		myCommentTime := time.Now().Add(-2 * time.Hour).Truncate(time.Second)
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(myCommentTime),
				BodyText:  config.Ptr("My reply"),
				Author:    octodeckv1.User_builder{Login: config.Ptr(currentUser)}.Build(),
			}.Build(),
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(time.Now().Add(-1 * time.Hour)),
				BodyText:  config.Ptr("Automated message"),
				Author: octodeckv1.User_builder{
					Login: config.Ptr("github-actions[bot]"),
					Type:  config.Ptr(octodeckv1.UserType_USER_TYPE_BOT),
				}.Build(),
			}.Build(),
		})
		shouldAck, ackTime := ShouldAutoAck(item, currentUser, knownBots)
		assert.True(t, shouldAck)
		assert.True(t, ackTime.Equal(myCommentTime))
	})

	t.Run("should consider reviews as actions", func(t *testing.T) {
		item := proto.Clone(baseItem).(*octodeckv1.Item)
		reviewTime := time.Now().Add(-1 * time.Hour).Truncate(time.Second)
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(time.Now().Add(-2 * time.Hour)),
				BodyText:  config.Ptr("Some comment"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("other")}.Build(),
			}.Build(),
		})
		item.SetReviews([]*octodeckv1.Review{
			octodeckv1.Review_builder{
				SubmittedAt: timestamppb.New(reviewTime),
				State:       config.Ptr("APPROVED"),
				Author:      octodeckv1.User_builder{Login: config.Ptr(currentUser)}.Build(),
			}.Build(),
		})
		shouldAck, ackTime := ShouldAutoAck(item, currentUser, knownBots)
		assert.True(t, shouldAck)
		assert.True(t, ackTime.Equal(reviewTime))
	})

	t.Run("should ignore commits", func(t *testing.T) {
		item := proto.Clone(baseItem).(*octodeckv1.Item)
		item.SetComments([]*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CreatedAt: timestamppb.New(time.Now().Add(-2 * time.Hour)),
				BodyText:  config.Ptr("Some comment"),
				Author:    octodeckv1.User_builder{Login: config.Ptr("other")}.Build(),
			}.Build(),
		})
		item.SetCommits([]*octodeckv1.Commit{
			octodeckv1.Commit_builder{
				CommittedDate: timestamppb.New(time.Now().Add(-1 * time.Hour)),
				AuthorLogin:   config.Ptr(currentUser),
			}.Build(),
		})
		// Should be false because the last RELEVANT action (comment) is from "other"
		shouldAck, _ := ShouldAutoAck(item, currentUser, knownBots)
		assert.False(t, shouldAck)
	})
}
