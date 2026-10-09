package logic

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

func TestComputeActivity(t *testing.T) {
	viewed := time.Date(2023, 1, 1, 12, 0, 0, 0, time.UTC)
	older := time.Date(2023, 1, 1, 10, 0, 0, 0, time.UTC)
	newer := time.Date(2023, 1, 2, 12, 0, 0, 0, time.UTC)
	const currentUser = "me"
	knownBots := []string{"k8s-ci-robot"}

	baseItem := func() *octodeckv1.Item {
		return octodeckv1.Item_builder{
			Id:        config.Ptr("PR_1"),
			Number:    config.Ptr(int32(1)),
			State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			CreatedAt: timestamppb.New(older),
			UpdatedAt: timestamppb.New(newer),
			Author:    octodeckv1.User_builder{Login: config.Ptr("other")}.Build(),
			Local: octodeckv1.ItemLocalState_builder{
				LastViewedAt: timestamppb.New(viewed),
			}.Build(),
		}.Build()
	}
	comment := func(login, body string, at time.Time) *octodeckv1.Comment {
		return octodeckv1.Comment_builder{
			CreatedAt: timestamppb.New(at),
			BodyText:  config.Ptr(body),
			Author:    octodeckv1.User_builder{Login: config.Ptr(login)}.Build(),
		}.Build()
	}
	commit := func(login string, at time.Time) *octodeckv1.Commit {
		return octodeckv1.Commit_builder{CommittedDate: timestamppb.New(at), AuthorLogin: config.Ptr(login)}.Build()
	}

	t.Run("flags are independent: one item has mention, comment and code", func(t *testing.T) {
		item := baseItem()
		item.SetComments([]*octodeckv1.Comment{comment("bob", "ping @me please", newer)})
		item.SetCommits([]*octodeckv1.Commit{commit("carol", newer)})

		a := ComputeActivity(item, currentUser, knownBots)
		assert.Equal(t, Activity{Mention: true, Comment: true, Code: true}, a)
		assert.True(t, a.Any())
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION, a.Status())
	})

	t.Run("unseen item matches item plus the content it contains", func(t *testing.T) {
		item := baseItem()
		item.GetLocal().ClearLastViewedAt()
		item.SetComments([]*octodeckv1.Comment{comment("frank", "looks good", older)})
		item.SetCommits([]*octodeckv1.Commit{commit("eve", older)})

		a := ComputeActivity(item, currentUser, knownBots)
		assert.Equal(t, Activity{Item: true, Comment: true, Code: true}, a)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW, a.Status())
	})

	t.Run("unseen item with only a bot comment is item and noise, and any via item", func(t *testing.T) {
		item := baseItem()
		item.GetLocal().ClearLastViewedAt()
		item.SetComments([]*octodeckv1.Comment{comment("k8s-ci-robot", "/retest", older)})

		a := ComputeActivity(item, currentUser, knownBots)
		assert.Equal(t, Activity{Item: true, Noise: true}, a)
		assert.True(t, a.Any())
	})

	t.Run("new:any excludes noise", func(t *testing.T) {
		item := baseItem()
		item.SetComments([]*octodeckv1.Comment{comment("k8s-ci-robot", "CI passed", newer)})

		a := ComputeActivity(item, currentUser, knownBots)
		assert.Equal(t, Activity{Noise: true}, a)
		assert.False(t, a.Any())
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NOISE, a.Status())
	})

	t.Run("noise and real activity set both flags", func(t *testing.T) {
		item := baseItem()
		item.SetComments([]*octodeckv1.Comment{
			comment("k8s-ci-robot", "CI passed", newer),
			comment("bob", "please rebase", newer),
		})

		a := ComputeActivity(item, currentUser, knownBots)
		assert.Equal(t, Activity{Comment: true, Noise: true}, a)
		assert.True(t, a.Any())
	})

	t.Run("acked item has no flags even with later noise", func(t *testing.T) {
		item := baseItem()
		SetAcked(item.GetLocal(), viewed, viewed)
		item.SetComments([]*octodeckv1.Comment{comment("k8s-ci-robot", "CI passed", newer)})

		a := ComputeActivity(item, currentUser, knownBots)
		assert.Equal(t, Activity{Acked: true}, a)
		assert.False(t, a.Any())
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, a.Status())
	})

	t.Run("superseded ack gets flags relative to the ack watermark", func(t *testing.T) {
		item := baseItem()
		item.GetLocal().ClearLastViewedAt()
		SetAcked(item.GetLocal(), viewed, viewed)
		item.SetComments([]*octodeckv1.Comment{
			comment("bob", "old comment", older), // before the ack: already accepted
			comment("bob", "new comment", newer),
		})
		item.SetCommits([]*octodeckv1.Commit{commit("carol", older)})

		a := ComputeActivity(item, currentUser, knownBots)
		assert.Equal(t, Activity{Comment: true}, a)
	})

	t.Run("seen item without updates has no flags even with stale newer timestamps", func(t *testing.T) {
		item := baseItem()
		item.SetUpdatedAt(timestamppb.New(viewed))
		item.SetCommits([]*octodeckv1.Commit{commit("carol", newer)})

		assert.Equal(t, Activity{}, ComputeActivity(item, currentUser, knownBots))
	})

	t.Run("state event by a human is comment activity", func(t *testing.T) {
		item := baseItem()
		item.SetStateEvents([]*octodeckv1.StateEvent{octodeckv1.StateEvent_builder{
			Type:      octodeckv1.StateChangeType_STATE_CHANGE_TYPE_CLOSED.Enum(),
			CreatedAt: timestamppb.New(newer),
			Actor:     octodeckv1.User_builder{Login: config.Ptr("bob")}.Build(),
		}.Build()})

		assert.Equal(t, Activity{Comment: true}, ComputeActivity(item, currentUser, knownBots))
	})

	t.Run("status always equals CalculateStatus", func(t *testing.T) {
		unseen := baseItem()
		unseen.GetLocal().ClearLastViewedAt()
		unseenMention := baseItem()
		unseenMention.GetLocal().ClearLastViewedAt()
		unseenMention.SetBody("cc @me")
		code := baseItem()
		code.SetCommits([]*octodeckv1.Commit{commit("carol", newer)})
		for _, item := range []*octodeckv1.Item{baseItem(), unseen, unseenMention, code} {
			assert.Equal(t, CalculateStatus(item, currentUser, knownBots),
				ComputeActivity(item, currentUser, knownBots).Status())
		}
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION,
			ComputeActivity(unseenMention, currentUser, knownBots).Status())
	})
}

func TestActivityStatusPriority(t *testing.T) {
	tests := []struct {
		name string
		a    Activity
		want octodeckv1.ItemStatus
	}{
		{"none is idle", Activity{}, octodeckv1.ItemStatus_ITEM_STATUS_IDLE},
		{"acked wins", Activity{Acked: true}, octodeckv1.ItemStatus_ITEM_STATUS_ACKED},
		{
			"unseen with mention", Activity{Item: true, Mention: true, Code: true},
			octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION,
		},
		{"unseen", Activity{Item: true, Comment: true, Noise: true}, octodeckv1.ItemStatus_ITEM_STATUS_NEW},
		{"mention over code", Activity{Mention: true, Code: true}, octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION},
		{"comment over code", Activity{Comment: true, Code: true}, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY},
		{"code over noise", Activity{Code: true, Noise: true}, octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE},
		{"noise alone", Activity{Noise: true}, octodeckv1.ItemStatus_ITEM_STATUS_NOISE},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, tc.a.Status())
		})
	}
}

func TestActivityAny(t *testing.T) {
	assert.False(t, Activity{}.Any())
	assert.False(t, Activity{Noise: true}.Any())
	assert.False(t, Activity{Acked: true}.Any())
	assert.True(t, Activity{Item: true}.Any())
	assert.True(t, Activity{Mention: true}.Any())
	assert.True(t, Activity{Comment: true}.Any())
	assert.True(t, Activity{Code: true}.Any())
}
