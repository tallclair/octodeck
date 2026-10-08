package logic

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

func TestLatestOwnActivityTime(t *testing.T) {
	// Each case adds exactly one own event at ackTestTime(10) on top of activity by others at
	// ackTestTime(20), which must never count.
	cases := map[string]func(item *octodeckv1.Item){
		"comment": func(item *octodeckv1.Item) {
			item.SetComments([]*octodeckv1.Comment{
				ackTestComment(ackTestUser, ackTestTime(10)),
				ackTestComment(ackTestOther, ackTestTime(20)),
			})
		},
		"submitted review": func(item *octodeckv1.Item) {
			item.SetReviews([]*octodeckv1.Review{
				octodeckv1.Review_builder{
					State:       config.Ptr("COMMENTED"),
					Author:      ackTestUserProto(ackTestUser),
					SubmittedAt: timestamppb.New(ackTestTime(10)),
				}.Build(),
				octodeckv1.Review_builder{
					State:       config.Ptr("APPROVED"),
					Author:      ackTestUserProto(ackTestOther),
					SubmittedAt: timestamppb.New(ackTestTime(20)),
				}.Build(),
			})
		},
		"review comment falling back to the review author": func(item *octodeckv1.Item) {
			item.SetReviews([]*octodeckv1.Review{octodeckv1.Review_builder{
				State:       config.Ptr("COMMENTED"),
				Author:      ackTestUserProto(ackTestUser),
				SubmittedAt: timestamppb.New(ackTestTime(5)),
				Comments: []*octodeckv1.ReviewComment{
					octodeckv1.ReviewComment_builder{CreatedAt: timestamppb.New(ackTestTime(10))}.Build(),
					octodeckv1.ReviewComment_builder{
						CreatedAt: timestamppb.New(ackTestTime(20)),
						Author:    ackTestUserProto(ackTestOther),
					}.Build(),
				},
			}.Build()})
		},
		"commit": func(item *octodeckv1.Item) {
			item.SetCommits([]*octodeckv1.Commit{
				ackTestCommit(ackTestUser, ackTestTime(10)),
				ackTestCommit(ackTestOther, ackTestTime(20)),
			})
		},
		"state event": func(item *octodeckv1.Item) {
			item.SetStateEvents([]*octodeckv1.StateEvent{
				ackTestStateEvent(ackTestUser, ackTestTime(10)),
				ackTestStateEvent(ackTestOther, ackTestTime(20)),
			})
		},
	}
	for name, apply := range cases {
		t.Run(name, func(t *testing.T) {
			item := ackTestItem(ackTestOther)
			apply(item)
			touch(item, ackTestTime(20))
			assert.Equal(t, ackTestTime(10), LatestOwnActivityTime(item, ackTestUser))
		})
	}

	t.Run("authoring the item counts at created_at", func(t *testing.T) {
		item := ackTestItem(ackTestUser)
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestOther, ackTestTime(20))})
		assert.Equal(t, ackTestTime(-60), LatestOwnActivityTime(item, ackTestUser))
	})

	t.Run("login comparison ignores case and a leading @", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		item.SetComments([]*octodeckv1.Comment{ackTestComment("ME", ackTestTime(10))})
		assert.Equal(t, ackTestTime(10), LatestOwnActivityTime(item, "@me"))
	})

	t.Run("pending reviews are ignored", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		item.SetReviews([]*octodeckv1.Review{octodeckv1.Review_builder{
			State:       config.Ptr("PENDING"),
			Author:      ackTestUserProto(ackTestUser),
			SubmittedAt: timestamppb.New(ackTestTime(10)),
			Comments: []*octodeckv1.ReviewComment{octodeckv1.ReviewComment_builder{
				CreatedAt: timestamppb.New(ackTestTime(10)),
				Author:    ackTestUserProto(ackTestUser),
			}.Build()},
		}.Build()})
		assert.True(t, LatestOwnActivityTime(item, ackTestUser).IsZero())
	})

	t.Run("zero without own activity or current user", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestOther, ackTestTime(10))})
		assert.True(t, LatestOwnActivityTime(item, ackTestUser).IsZero())

		own := ackTestItem(ackTestUser)
		assert.True(t, LatestOwnActivityTime(own, "").IsZero())
	})
}

func TestEffectiveLastViewedAt(t *testing.T) {
	t.Run("own activity after last view wins", func(t *testing.T) {
		item := ackTestItem(ackTestOther) // last viewed at -30
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestUser, ackTestTime(10))})
		assert.Equal(t, ackTestTime(10), EffectiveLastViewedAt(item, ackTestUser))
	})

	t.Run("never older than last_viewed_at", func(t *testing.T) {
		item := ackTestItem(ackTestUser) // created at -60, last viewed at -30
		assert.Equal(t, ackTestTime(-30), EffectiveLastViewedAt(item, ackTestUser))
	})

	t.Run("own activity alone counts as viewed", func(t *testing.T) {
		item := ackTestItem(ackTestUser)
		item.GetLocal().ClearLastViewedAt()
		assert.Equal(t, ackTestTime(-60), EffectiveLastViewedAt(item, ackTestUser))
	})

	t.Run("zero when never viewed and no own activity", func(t *testing.T) {
		item := ackTestItem(ackTestOther)
		item.GetLocal().ClearLastViewedAt()
		assert.True(t, EffectiveLastViewedAt(item, ackTestUser).IsZero())
	})
}

func TestSetComputedLastViewedAt(t *testing.T) {
	item := ackTestItem(ackTestOther)
	item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestUser, ackTestTime(10))})
	SetComputedLastViewedAt(item, ackTestUser)
	assert.Equal(t, ackTestTime(10), item.GetLocal().GetComputedLastViewedAt().AsTime())

	// A stale value (e.g. one that reached storage) is cleared when there is nothing to report.
	unviewed := ackTestItem(ackTestOther)
	unviewed.GetLocal().ClearLastViewedAt()
	unviewed.GetLocal().SetComputedLastViewedAt(timestamppb.New(ackTestTime(99)))
	SetComputedLastViewedAt(unviewed, ackTestUser)
	assert.False(t, unviewed.GetLocal().HasComputedLastViewedAt())
}

func TestCalculateStatus_OwnActivityCountsAsViewed(t *testing.T) {
	// An item opened by someone else that the user never viewed through OctoDeck or GitHub's page
	// tracking, but commented on (e.g. via email reply or another client).
	unviewedWithOwnComment := func(ownAt time.Time) *octodeckv1.Item {
		item := ackTestItem(ackTestOther)
		item.GetLocal().ClearLastViewedAt()
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestUser, ownAt)})
		touch(item, ownAt)
		return item
	}

	t.Run("never-viewed item with only earlier activity by others is IDLE", func(t *testing.T) {
		item := unviewedWithOwnComment(ackTestTime(10))
		mention := ackTestComment(ackTestOther, ackTestTime(5))
		mention.SetBodyText("PTAL @me")
		item.SetComments(append([]*octodeckv1.Comment{mention}, item.GetComments()...))
		item.SetBody("cc @me")
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_IDLE, CalculateStatus(item, ackTestUser, ackTestBots()))
	})

	t.Run("activity by others after the user's comment is new", func(t *testing.T) {
		item := unviewedWithOwnComment(ackTestTime(10))
		item.SetComments(append(item.GetComments(), ackTestComment(ackTestOther, ackTestTime(11))))
		touch(item, ackTestTime(11))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY,
			CalculateStatus(item, ackTestUser, ackTestBots()))
	})

	t.Run("stale last view: activity between the view and the user's comment is not new", func(t *testing.T) {
		item := ackTestItem(ackTestOther) // last viewed at -30
		item.SetComments([]*octodeckv1.Comment{
			ackTestComment(ackTestOther, ackTestTime(5)),
			ackTestComment(ackTestUser, ackTestTime(10)),
		})
		item.SetCommits([]*octodeckv1.Commit{ackTestCommit(ackTestOther, ackTestTime(6))})
		touch(item, ackTestTime(10))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_IDLE, CalculateStatus(item, ackTestUser, ackTestBots()))
	})

	t.Run("own commit after the last view hides earlier activity by others", func(t *testing.T) {
		item := ackTestItem(ackTestUser) // last viewed at -30
		item.SetComments([]*octodeckv1.Comment{ackTestComment(ackTestBot, ackTestTime(5))})
		item.SetCommits([]*octodeckv1.Commit{ackTestCommit(ackTestUser, ackTestTime(10))})
		touch(item, ackTestTime(10))
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_IDLE, CalculateStatus(item, ackTestUser, ackTestBots()))
	})
}
