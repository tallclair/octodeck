package logic

import (
	"context"
	"sort"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/github"
)

func TestRunGarbageCollection_RefreshesUntrackedItemsSooner(t *testing.T) {
	now := time.Now()
	day := 24 * time.Hour
	untrackedStale := now.Add(-config.DefaultUntrackedStaleItemAge - day)
	untrackedFresh := now.Add(-config.DefaultUntrackedStaleItemAge + day)
	stale := now.Add(-config.DefaultStaleItemAge - day)

	type seed struct {
		id           string
		state        octodeckv1.ItemState
		subscription octodeckv1.SubscriptionState
		lastSynced   time.Time
		wantRefresh  bool
	}
	const (
		open    = octodeckv1.ItemState_ITEM_STATE_OPEN
		closed  = octodeckv1.ItemState_ITEM_STATE_CLOSED
		subbed  = octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED
		unsub   = octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED
		ignored = octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_IGNORED
		unknown = octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSPECIFIED
	)
	seeds := []seed{
		{"UNSUBSCRIBED_PAST_UNTRACKED_AGE", open, unsub, untrackedStale, true},
		{"IGNORED_PAST_UNTRACKED_AGE", open, ignored, untrackedStale, true},
		{"UNKNOWN_SUBSCRIPTION_PAST_UNTRACKED_AGE", open, unknown, untrackedStale, true},
		{"UNSUBSCRIBED_WITHIN_UNTRACKED_AGE", open, unsub, untrackedFresh, false},
		{"SUBSCRIBED_PAST_UNTRACKED_AGE", open, subbed, untrackedStale, false},
		{"SUBSCRIBED_PAST_STALE_AGE", open, subbed, stale, true},
		{"CLOSED_UNSUBSCRIBED_PAST_UNTRACKED_AGE", closed, unsub, untrackedStale, false},
	}

	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()
	var items []*octodeckv1.Item
	var want []string
	for i, s := range seeds {
		items = append(items, octodeckv1.Item_builder{
			Id:                 config.Ptr(s.id),
			Repo:               config.Ptr("owner/repo"),
			Number:             config.Ptr(int32(i + 1)),
			Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
			State:              config.Ptr(s.state),
			ViewerSubscription: config.Ptr(s.subscription),
			UpdatedAt:          timestamppb.New(now),
			LastSyncedAt:       timestamppb.New(s.lastSynced),
			Local:              octodeckv1.ItemLocalState_builder{}.Build(),
		}.Build())
		if s.wantRefresh {
			want = append(want, s.id)
		}
	}
	require.NoError(t, db.SaveItems(t.Context(), items))

	var requested []string
	gql := &mockGraphQLClient{queryFunc: func(_ context.Context, name string, _ any, vars map[string]any) error {
		if name == "ItemsFetch" {
			ids, _ := vars["ids"].([]string)
			requested = append(requested, ids...)
		}
		return nil
	}}
	ghClient := &github.Client{GraphQLClient: gql, CurrentUser: "testuser"}
	engine := NewSyncEngine(db, ghClient, config.NewForTest(octodeckv1.Config_builder{}.Build()))

	require.NoError(t, engine.RunGarbageCollection(t.Context()))

	sort.Strings(requested)
	sort.Strings(want)
	assert.Equal(t, want, requested)
}
