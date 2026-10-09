package logic

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/github"
)

func secs(s int64) *timestamppb.Timestamp {
	return &timestamppb.Timestamp{Seconds: s}
}

func TestProtoMs(t *testing.T) {
	assert.Equal(t, int64(0), ProtoMs(nil))
	assert.Equal(t, int64(1700000000500), ProtoMs(&timestamppb.Timestamp{Seconds: 1700000000, Nanos: 500_000_000}))
	// Sub-millisecond precision is truncated, not rounded.
	assert.Equal(t, int64(1700000000999), ProtoMs(&timestamppb.Timestamp{Seconds: 1700000000, Nanos: 999_999_999}))
}

func TestLatestNonNoiseActivityMs(t *testing.T) {
	stateEvent := func(typ octodeckv1.StateChangeType, s int64) *octodeckv1.StateEvent {
		return octodeckv1.StateEvent_builder{Type: typ.Enum(), CreatedAt: secs(s)}.Build()
	}

	tests := []struct {
		name string
		item *octodeckv1.Item
		want int64
	}{
		{
			name: "latest human comment when a bot comment is newer",
			item: octodeckv1.Item_builder{
				CreatedAt: secs(1700000000),
				UpdatedAt: secs(1700000900),
				Comments: []*octodeckv1.Comment{
					octodeckv1.Comment_builder{CreatedAt: secs(1700000500)}.Build(),
					octodeckv1.Comment_builder{
						CreatedAt: secs(1700000900),
						NoiseType: octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_BOT_AUTHOR.Enum(),
					}.Build(),
				},
			}.Build(),
			want: 1700000500000,
		},
		{
			name: "only a noise comment falls back to created_at",
			item: octodeckv1.Item_builder{
				CreatedAt: secs(1700000000),
				UpdatedAt: secs(1700000900),
				Comments: []*octodeckv1.Comment{octodeckv1.Comment_builder{
					CreatedAt: secs(1700000900),
					NoiseType: octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_SLASH_COMMAND.Enum(),
				}.Build()},
			}.Build(),
			want: 1700000000000,
		},
		{
			name: "no created_at and no activity falls back to updated_at",
			item: octodeckv1.Item_builder{UpdatedAt: secs(1700000900)}.Build(),
			want: 1700000900000,
		},
		{
			name: "latest of several commits",
			item: octodeckv1.Item_builder{
				CreatedAt: secs(1700000000),
				Commits: []*octodeckv1.Commit{
					octodeckv1.Commit_builder{CommittedDate: secs(1700000300)}.Build(),
					octodeckv1.Commit_builder{CommittedDate: secs(1700000700)}.Build(),
					octodeckv1.Commit_builder{CommittedDate: secs(1700000100)}.Build(),
				},
			}.Build(),
			want: 1700000700000,
		},
		{
			name: "pending and unsubmitted reviews are ignored, bot reviews count",
			item: octodeckv1.Item_builder{
				CreatedAt: secs(1700000000),
				Reviews: []*octodeckv1.Review{
					octodeckv1.Review_builder{
						State:       config.Ptr(github.ReviewStatePending),
						SubmittedAt: secs(1700000900),
					}.Build(),
					octodeckv1.Review_builder{State: config.Ptr("COMMENTED")}.Build(),
					octodeckv1.Review_builder{
						State:       config.Ptr("COMMENTED"),
						SubmittedAt: secs(1700000400),
						Author: octodeckv1.User_builder{
							Login: config.Ptr("k8s-ci-robot"),
							Type:  octodeckv1.UserType_USER_TYPE_BOT.Enum(),
						}.Build(),
					}.Build(),
				},
			}.Build(),
			want: 1700000400000,
		},
		{
			name: "closed item without state events uses updated_at",
			item: octodeckv1.Item_builder{
				State:     octodeckv1.ItemState_ITEM_STATE_CLOSED.Enum(),
				CreatedAt: secs(1700000000),
				UpdatedAt: secs(1700000800),
			}.Build(),
			want: 1700000800000,
		},
		{
			name: "open item without activity ignores updated_at",
			item: octodeckv1.Item_builder{
				State:     octodeckv1.ItemState_ITEM_STATE_OPEN.Enum(),
				CreatedAt: secs(1700000000),
				UpdatedAt: secs(1700000800),
			}.Build(),
			want: 1700000000000,
		},
		{
			name: "close after merge is part of the merge",
			item: octodeckv1.Item_builder{
				State:     octodeckv1.ItemState_ITEM_STATE_MERGED.Enum(),
				CreatedAt: secs(1700000000),
				StateEvents: []*octodeckv1.StateEvent{
					stateEvent(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_MERGED, 1700000500),
					stateEvent(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_CLOSED, 1700000505),
				},
			}.Build(),
			want: 1700000500000,
		},
		{
			name: "close well before a merge is kept but the merge is later",
			item: octodeckv1.Item_builder{
				CreatedAt: secs(1700000000),
				StateEvents: []*octodeckv1.StateEvent{
					stateEvent(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_CLOSED, 1700000600),
					stateEvent(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_REOPENED, 1700000700),
					stateEvent(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_MERGED, 1700000650),
				},
			}.Build(),
			want: 1700000700000,
		},
		{
			name: "unspecified state events trigger the closed fallback",
			item: octodeckv1.Item_builder{
				State:     octodeckv1.ItemState_ITEM_STATE_CLOSED.Enum(),
				CreatedAt: secs(1700000000),
				UpdatedAt: secs(1700000800),
				StateEvents: []*octodeckv1.StateEvent{
					stateEvent(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_UNSPECIFIED, 1700000900),
				},
			}.Build(),
			want: 1700000800000,
		},
		{
			name: "created_at later than all activity wins",
			item: octodeckv1.Item_builder{
				CreatedAt: secs(1700000900),
				Comments:  []*octodeckv1.Comment{octodeckv1.Comment_builder{CreatedAt: secs(1700000500)}.Build()},
			}.Build(),
			want: 1700000900000,
		},
		{
			name: "comment without a timestamp sits at the epoch",
			item: octodeckv1.Item_builder{
				UpdatedAt: secs(1700000900),
				Comments:  []*octodeckv1.Comment{octodeckv1.Comment_builder{}.Build()},
			}.Build(),
			want: 0,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, LatestNonNoiseActivityMs(tc.item))
		})
	}
}

func TestLatestNonNoiseActivityMs_ClassifiedComments(t *testing.T) {
	// Noise is read from noise_type, so classification must happen first.
	created := time.Unix(1700000000, 0)
	item := octodeckv1.Item_builder{
		CreatedAt: timestamppb.New(created),
		Comments: []*octodeckv1.Comment{octodeckv1.Comment_builder{
			CreatedAt: timestamppb.New(created.Add(time.Minute)),
			BodyText:  config.Ptr("CI passed"),
			Author:    octodeckv1.User_builder{Login: config.Ptr("k8s-ci-robot")}.Build(),
		}.Build()},
	}.Build()
	assert.Equal(t, created.Add(time.Minute).UnixMilli(), LatestNonNoiseActivityMs(item))

	ClassifyCommentsForUser([]string{"k8s-ci-robot"}, "me", item)
	assert.Equal(t, created.UnixMilli(), LatestNonNoiseActivityMs(item))
}
