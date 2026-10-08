package logic

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

// Shared fixtures for acknowledgement tests.
const (
	ackTestUser  = "me"
	ackTestOther = "other"
	ackTestBot   = "k8s-ci-robot"
)

func ackTestBots() []string {
	return []string{ackTestBot}
}

// ackTestTime returns the fixture base time (t0) offset by the given minutes.
func ackTestTime(minutes int) time.Time {
	return time.Date(2024, 3, 1, 10, 0, 0, 0, time.UTC).Add(time.Duration(minutes) * time.Minute)
}

func ackTestUserProto(login string) *octodeckv1.User {
	return octodeckv1.User_builder{Login: config.Ptr(login)}.Build()
}

func ackTestComment(author string, at time.Time) *octodeckv1.Comment {
	return octodeckv1.Comment_builder{
		CreatedAt: timestamppb.New(at),
		BodyText:  config.Ptr("A substantive comment"),
		Author:    ackTestUserProto(author),
	}.Build()
}

func ackTestStateEvent(actor string, at time.Time) *octodeckv1.StateEvent {
	return octodeckv1.StateEvent_builder{
		Type:      config.Ptr(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED),
		CreatedAt: timestamppb.New(at),
		Actor:     ackTestUserProto(actor),
	}.Build()
}

func ackTestCommit(author string, at time.Time) *octodeckv1.Commit {
	return octodeckv1.Commit_builder{CommittedDate: timestamppb.New(at), AuthorLogin: config.Ptr(author)}.Build()
}

// ackTestItem returns a viewed PR authored by author with no activity; updated_at is t0.
func ackTestItem(author string) *octodeckv1.Item {
	return octodeckv1.Item_builder{
		Id:        config.Ptr("owner/repo#1"),
		Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		Author:    ackTestUserProto(author),
		CreatedAt: timestamppb.New(ackTestTime(-60)),
		UpdatedAt: timestamppb.New(ackTestTime(0)),
		Local: octodeckv1.ItemLocalState_builder{
			LastViewedAt: timestamppb.New(ackTestTime(-30)),
		}.Build(),
	}.Build()
}

// touch adds activity to item and bumps updated_at to at, as GitHub does.
func touch(item *octodeckv1.Item, at time.Time) {
	if at.After(item.GetUpdatedAt().AsTime()) {
		item.SetUpdatedAt(timestamppb.New(at))
	}
}

func TestAckStateHelpers(t *testing.T) {
	action := ackTestTime(100)
	watermark := ackTestTime(50)

	tests := []struct {
		name          string
		local         *octodeckv1.ItemLocalState
		wantAcked     bool
		wantWatermark time.Time
	}{
		{
			name:  "nil local state",
			local: nil,
		},
		{
			name:  "neither field set",
			local: octodeckv1.ItemLocalState_builder{}.Build(),
		},
		{
			name: "zero timestamps are not acked",
			local: octodeckv1.ItemLocalState_builder{
				AckedAt:         timestamppb.New(time.Unix(0, 0)),
				AckedActivityAt: timestamppb.New(time.Unix(0, 0)),
			}.Build(),
		},
		{
			name:          "legacy row with only acked_at falls back to it",
			local:         octodeckv1.ItemLocalState_builder{AckedAt: timestamppb.New(watermark)}.Build(),
			wantAcked:     true,
			wantWatermark: watermark,
		},
		{
			name:          "only acked_activity_at",
			local:         octodeckv1.ItemLocalState_builder{AckedActivityAt: timestamppb.New(watermark)}.Build(),
			wantAcked:     true,
			wantWatermark: watermark,
		},
		{
			name: "both set: watermark is acked_activity_at",
			local: octodeckv1.ItemLocalState_builder{
				AckedAt:         timestamppb.New(action),
				AckedActivityAt: timestamppb.New(watermark),
			}.Build(),
			wantAcked:     true,
			wantWatermark: watermark,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.wantAcked, IsAcked(tt.local))
			assert.True(t, tt.wantWatermark.Equal(AckedActivityAt(tt.local)),
				"watermark: want %v, got %v", tt.wantWatermark, AckedActivityAt(tt.local))
		})
	}

	t.Run("SetAcked sets both fields and ClearAcked clears both", func(t *testing.T) {
		local := octodeckv1.ItemLocalState_builder{}.Build()
		SetAcked(local, action, watermark)
		assert.True(t, IsAcked(local))
		assert.True(t, action.Equal(local.GetAckedAt().AsTime()))
		assert.True(t, watermark.Equal(local.GetAckedActivityAt().AsTime()))

		ClearAcked(local)
		assert.False(t, IsAcked(local))
		assert.False(t, local.HasAckedAt())
		assert.False(t, local.HasAckedActivityAt())
	})
}

func TestLatestActivityTime(t *testing.T) {
	latest := ackTestTime(500)

	sources := map[string]func(item *octodeckv1.Item){
		"updated_at": func(item *octodeckv1.Item) { item.SetUpdatedAt(timestamppb.New(latest)) },
		"created_at": func(item *octodeckv1.Item) { item.SetCreatedAt(timestamppb.New(latest)) },
		"comment": func(item *octodeckv1.Item) {
			item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestOther, latest)})
		},
		"review submitted_at": func(item *octodeckv1.Item) {
			item.SetReviews([]*octodeckv1.Review{octodeckv1.Review_builder{
				State:       config.Ptr("COMMENTED"),
				SubmittedAt: timestamppb.New(latest),
			}.Build()})
		},
		"review comment created_at": func(item *octodeckv1.Item) {
			item.SetReviews([]*octodeckv1.Review{octodeckv1.Review_builder{
				State:       config.Ptr("COMMENTED"),
				SubmittedAt: timestamppb.New(ackTestTime(1)),
				Comments: []*octodeckv1.ReviewComment{octodeckv1.ReviewComment_builder{
					CreatedAt: timestamppb.New(latest),
				}.Build()},
			}.Build()})
		},
		"commit committed_date": func(item *octodeckv1.Item) {
			item.SetCommits([]*octodeckv1.Commit{ackTestCommit(ackTestOther, latest)})
		},
		"state event": func(item *octodeckv1.Item) {
			item.SetStateEvents([]*octodeckv1.StateEvent{ackTestStateEvent(ackTestOther, latest)})
		},
	}
	for name, apply := range sources {
		t.Run(name+" wins", func(t *testing.T) {
			item := ackTestItem(ackTestOther)
			apply(item)
			assert.True(t, latest.Equal(LatestActivityTime(item)), "got %v", LatestActivityTime(item))

			// Invariant: an item acked at its latest activity time is ACKED.
			SetAcked(item.GetLocal(), time.Now(), LatestActivityTime(item))
			assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, CalculateStatus(item, ackTestUser, ackTestBots()))
		})
	}

	t.Run("pending reviews are ignored", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		item.SetReviews([]*octodeckv1.Review{octodeckv1.Review_builder{
			State: config.Ptr("PENDING"),
			Comments: []*octodeckv1.ReviewComment{octodeckv1.ReviewComment_builder{
				CreatedAt: timestamppb.New(latest),
			}.Build()},
		}.Build()})
		assert.True(t, ackTestTime(0).Equal(LatestActivityTime(item)))
	})

	t.Run("zero when there are no timestamps", func(t *testing.T) {
		assert.True(t, LatestActivityTime(octodeckv1.Item_builder{}.Build()).IsZero())
	})
}

func TestCalculateStatus_UsesActivityWatermark(t *testing.T) {
	t.Run("acked_at far in the future does not hide newer activity", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		SetAcked(item.GetLocal(), ackTestTime(10_000), ackTestTime(0))
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestOther, ackTestTime(1))})
		touch(item, ackTestTime(1))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY,
			CalculateStatus(item, ackTestUser, ackTestBots()))
	})

	t.Run("legacy row with only acked_at uses it as the watermark", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		item.GetLocal().SetAckedAt(timestamppb.New(ackTestTime(0)))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, CalculateStatus(item, ackTestUser, ackTestBots()))

		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestOther, ackTestTime(1))})
		touch(item, ackTestTime(1))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY,
			CalculateStatus(item, ackTestUser, ackTestBots()))
	})
}

func TestCalculateStatus_BotStateEventsAreNoise(t *testing.T) {
	t.Run("bot state event after ack keeps the item ACKED", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		SetAcked(item.GetLocal(), ackTestTime(0), ackTestTime(0))
		item.SetStateEvents([]*octodeckv1.StateEvent{ackTestStateEvent(ackTestBot, ackTestTime(1))})
		touch(item, ackTestTime(1))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, CalculateStatus(item, ackTestUser, ackTestBots()))
	})

	t.Run("bot state event on an un-acked item is NOISE", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		item.SetStateEvents([]*octodeckv1.StateEvent{ackTestStateEvent(ackTestBot, ackTestTime(1))})
		touch(item, ackTestTime(1))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NOISE, CalculateStatus(item, ackTestUser, ackTestBots()))
	})

	t.Run("bot detected by user type", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		SetAcked(item.GetLocal(), ackTestTime(0), ackTestTime(0))
		e := ackTestStateEvent("some-app", ackTestTime(1))
		e.GetActor().SetType(octodeckv1.UserType_USER_TYPE_BOT)
		item.SetStateEvents([]*octodeckv1.StateEvent{e})
		touch(item, ackTestTime(1))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, CalculateStatus(item, ackTestUser, nil))
	})

	t.Run("human state event still un-acks", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		SetAcked(item.GetLocal(), ackTestTime(0), ackTestTime(0))
		item.SetStateEvents([]*octodeckv1.StateEvent{ackTestStateEvent(ackTestOther, ackTestTime(1))})
		touch(item, ackTestTime(1))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY,
			CalculateStatus(item, ackTestUser, ackTestBots()))
	})
}

func TestCalculateStatus_OwnCommits(t *testing.T) {
	t.Run("own commit to own PR after ack keeps it ACKED", func(t *testing.T) {
		item := ackTestItem(ackTestUser)
		SetAcked(item.GetLocal(), ackTestTime(0), ackTestTime(0))
		item.SetCommits([]*octodeckv1.Commit{ackTestCommit(ackTestUser, ackTestTime(1))})
		touch(item, ackTestTime(1))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, CalculateStatus(item, ackTestUser, ackTestBots()))
	})

	t.Run("own commit to someone else's PR after ack keeps it ACKED", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		SetAcked(item.GetLocal(), ackTestTime(0), ackTestTime(0))
		item.SetCommits([]*octodeckv1.Commit{ackTestCommit(ackTestUser, ackTestTime(1))})
		touch(item, ackTestTime(1))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, CalculateStatus(item, ackTestUser, ackTestBots()))
	})

	t.Run("commit by someone else to someone else's PR after ack un-acks as NEW_CODE", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		SetAcked(item.GetLocal(), ackTestTime(0), ackTestTime(0))
		item.SetCommits([]*octodeckv1.Commit{ackTestCommit(ackTestOther, ackTestTime(1))})
		touch(item, ackTestTime(1))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE, CalculateStatus(item, ackTestUser, ackTestBots()))
	})

	t.Run("own commit to un-acked PR is still NEW_CODE", func(t *testing.T) {
		item := ackTestItem(ackTestUser)
		item.SetCommits([]*octodeckv1.Commit{ackTestCommit(ackTestUser, ackTestTime(1))})
		touch(item, ackTestTime(1))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE, CalculateStatus(item, ackTestUser, ackTestBots()))
	})

	t.Run("commit by someone else to own PR after ack un-acks as NEW_CODE", func(t *testing.T) {
		for _, author := range []string{ackTestOther, ackTestBot} {
			item := ackTestItem(ackTestUser)
			SetAcked(item.GetLocal(), ackTestTime(0), ackTestTime(0))
			item.SetCommits([]*octodeckv1.Commit{
				ackTestCommit(ackTestUser, ackTestTime(1)),
				ackTestCommit(author, ackTestTime(2)),
			})
			touch(item, ackTestTime(2))
			assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE,
				CalculateStatus(item, ackTestUser, ackTestBots()), "author %q", author)
		}
	})

	t.Run("commit with no author login un-acks even on own PR", func(t *testing.T) {
		for _, prAuthor := range []string{ackTestUser, ackTestOther} {
			item := ackTestItem(prAuthor)
			SetAcked(item.GetLocal(), ackTestTime(0), ackTestTime(0))
			item.SetCommits([]*octodeckv1.Commit{ackTestCommit("", ackTestTime(1))})
			touch(item, ackTestTime(1))
			assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE,
				CalculateStatus(item, ackTestUser, ackTestBots()), "PR author %q", prAuthor)
		}
	})
}

func ackTestBotReview(at time.Time, comments ...*octodeckv1.ReviewComment) *octodeckv1.Review {
	return octodeckv1.Review_builder{
		State:       config.Ptr("COMMENTED"),
		Author:      ackTestUserProto(ackTestBot),
		Body:        config.Ptr("Automated review summary"),
		SubmittedAt: timestamppb.New(at),
		Comments:    comments,
	}.Build()
}

// TestAutoAckAgreesWithStatus checks that ShouldAutoAck and CalculateStatus agree on what is noise:
// noise following the user's own action must neither block auto-ack nor un-ack the item, otherwise
// the watermark gets stuck behind the user's latest action.
func TestAutoAckAgreesWithStatus(t *testing.T) {
	ownAt, noiseAt := ackTestTime(10), ackTestTime(11)

	noise := map[string]func(item *octodeckv1.Item){
		"bot comment": func(item *octodeckv1.Item) {
			item.SetComments(append(item.GetComments(), ackTestComment(ackTestBot, noiseAt)))
		},
		"slash command": func(item *octodeckv1.Item) {
			c := ackTestComment(ackTestOther, noiseAt)
			c.SetBodyText("/lgtm")
			item.SetComments(append(item.GetComments(), c))
		},
		"bot review": func(item *octodeckv1.Item) {
			item.SetReviews([]*octodeckv1.Review{ackTestBotReview(noiseAt)})
		},
		"bot review comment": func(item *octodeckv1.Item) {
			item.SetReviews([]*octodeckv1.Review{ackTestBotReview(noiseAt,
				octodeckv1.ReviewComment_builder{
					CreatedAt: timestamppb.New(ackTestTime(12)),
					Body:      config.Ptr("Consider renaming this variable."),
					Author:    ackTestUserProto(ackTestBot),
				}.Build())})
		},
		"bot state event": func(item *octodeckv1.Item) {
			item.SetStateEvents([]*octodeckv1.StateEvent{ackTestStateEvent(ackTestBot, noiseAt)})
		},
	}
	for name, apply := range noise {
		t.Run(name, func(t *testing.T) {
			item := ackTestItem(ackTestOther)
			SetAcked(item.GetLocal(), ackTestTime(0), ackTestTime(0))
			item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestUser, ownAt)})
			apply(item)
			touch(item, LatestActivityTime(item))

			shouldAck, ackTime := ShouldAutoAck(item, ackTestUser, ackTestBots())
			require.True(t, shouldAck)
			assert.True(t, ownAt.Equal(ackTime), "ackTime: want %v, got %v", ownAt, ackTime)

			SetAcked(item.GetLocal(), ackTime, ackTime)
			assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, CalculateStatus(item, ackTestUser, ackTestBots()))
		})
	}

	t.Run("bot review that mentions the user is significant for both", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		SetAcked(item.GetLocal(), ackTestTime(0), ackTestTime(0))
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestUser, ownAt)})
		r := ackTestBotReview(noiseAt)
		r.SetBody("@me please take a look")
		item.SetReviews([]*octodeckv1.Review{r})
		touch(item, noiseAt)

		shouldAck, _ := ShouldAutoAck(item, ackTestUser, ackTestBots())
		assert.False(t, shouldAck)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION,
			CalculateStatus(item, ackTestUser, ackTestBots()))
	})
}

func TestCalculateStatus_PendingReviewsIgnored(t *testing.T) {
	item := ackTestItem(ackTestOther)
	SetAcked(item.GetLocal(), ackTestTime(0), ackTestTime(0))
	item.SetReviews([]*octodeckv1.Review{octodeckv1.Review_builder{
		State:  config.Ptr("PENDING"),
		Author: ackTestUserProto(ackTestOther),
		Body:   config.Ptr("@me draft"),
		Comments: []*octodeckv1.ReviewComment{octodeckv1.ReviewComment_builder{
			CreatedAt: timestamppb.New(ackTestTime(1)),
			Body:      config.Ptr("@me draft comment"),
		}.Build()},
	}.Build()})
	touch(item, ackTestTime(1))
	require.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, CalculateStatus(item, ackTestUser, ackTestBots()))
}
