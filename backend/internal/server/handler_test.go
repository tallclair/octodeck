package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/api/octodeck/v1/octodeckv1connect"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
)

func setupTestHandler(
	t *testing.T,
) (
	*database.DB,
	octodeckv1connect.OctoDeckServiceClient,
	func(connect.AnyRequest),
	*mockSyncEngine,
) {
	db, err := database.Init(t.Context(), database.InMemoryDSN)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	mockSync := &mockSyncEngine{}
	mockGH := &mockGitHubClient{authenticated: true}
	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())

	s := New(db, mockGH, mockSync, cfg, nil)
	code, err := s.auth.GenerateCode()
	require.NoError(t, err)
	token, err := s.auth.ExchangeCode(t.Context(), code)
	require.NoError(t, err)

	ts := httptest.NewServer(s.router)
	t.Cleanup(ts.Close)

	client := octodeckv1connect.NewOctoDeckServiceClient(
		http.DefaultClient,
		ts.URL+"/api/v1",
	)

	addHeaders := func(req connect.AnyRequest) {
		req.Header().Set("Origin", "chrome-extension://"+config.DevExtensionID)
		req.Header().Set("Authorization", "Bearer "+token)
	}

	return db, client, addHeaders, mockSync
}

func TestOctoDeckHandler_GetItems(t *testing.T) {
	db, client, addHeaders, _ := setupTestHandler(t)

	t.Run("GetItems", func(t *testing.T) {
		// Seed DB without any local computed status or noise_type
		c1 := octodeckv1.Comment_builder{
			CommentId: config.Ptr(int64(101)),
			Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
			BodyText:  config.Ptr("Hello human!"),
		}.Build()
		c2 := octodeckv1.Comment_builder{
			CommentId: config.Ptr(int64(102)),
			Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
			BodyText:  config.Ptr("/lgtm"),
		}.Build()
		c3 := octodeckv1.Comment_builder{
			CommentId: config.Ptr(int64(103)),
			Author:    octodeckv1.User_builder{Login: config.Ptr("k8s-ci-robot[bot]")}.Build(),
			BodyText:  config.Ptr("Build succeeded"),
		}.Build()

		item := octodeckv1.Item_builder{
			Id:        config.Ptr("1"),
			Repo:      config.Ptr("owner/repo"),
			Number:    config.Ptr(int32(1)),
			Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
			Title:     config.Ptr("Test Issue"),
			State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			UpdatedAt: timestamppb.New(time.Now()),
			Author:    octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
			Comments:  []*octodeckv1.Comment{c1, c2, c3},
		}.Build()
		err := db.SaveItems(t.Context(), []*octodeckv1.Item{item})
		require.NoError(t, err)

		// Verify that the saved item in DB has UNSPECIFIED noise_type
		rawItem, err := db.GetItem(t.Context(), "1")
		require.NoError(t, err)
		for _, c := range rawItem.GetComments() {
			assert.Equal(t,
				octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_UNSPECIFIED,
				c.GetNoiseType(),
				"noise_type should not be stored in DB",
			)
		}

		req := connect.NewRequest(&octodeckv1.GetItemsRequest{})
		addHeaders(req)

		resp, err := client.GetItems(t.Context(), req)
		require.NoError(t, err)

		require.Len(t, resp.Msg.GetItems(), 1)
		gotItem := resp.Msg.GetItems()[0]
		assert.Equal(t, "1", gotItem.GetId())
		assert.Equal(t, "Test Issue", gotItem.GetTitle())
		// Status is calculated dynamically on read
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW, gotItem.GetLocal().GetComputedStatus())

		// Verify comment noise types were populated dynamically on read
		require.Len(t, gotItem.GetComments(), 3)
		assert.Equal(t,
			octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_UNSPECIFIED,
			gotItem.GetComments()[0].GetNoiseType(),
		)
		assert.Equal(t,
			octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_SLASH_COMMAND,
			gotItem.GetComments()[1].GetNoiseType(),
		)
		assert.Equal(t,
			octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_BOT_AUTHOR,
			gotItem.GetComments()[2].GetNoiseType(),
		)

		// Test status filtering in GetItems
		filterReq := connect.NewRequest(octodeckv1.GetItemsRequest_builder{
			Filter: octodeckv1.Filter_builder{
				Status: []octodeckv1.ItemStatus{octodeckv1.ItemStatus_ITEM_STATUS_IDLE},
			}.Build(),
		}.Build())
		addHeaders(filterReq)
		filterResp, err := client.GetItems(t.Context(), filterReq)
		require.NoError(t, err)
		assert.Empty(t, filterResp.Msg.GetItems())

		// Test milestone filtering in GetItems
		itemWithMilestone := octodeckv1.Item_builder{
			Id:        config.Ptr("milestone_item"),
			Repo:      config.Ptr("owner/repo"),
			Number:    config.Ptr(int32(2)),
			Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
			Title:     config.Ptr("Milestone Issue"),
			State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			UpdatedAt: timestamppb.New(time.Now()),
			Milestone: octodeckv1.Milestone_builder{
				Title: config.Ptr("v1.32"),
			}.Build(),
		}.Build()
		err = db.SaveItems(t.Context(), []*octodeckv1.Item{itemWithMilestone})
		require.NoError(t, err)

		msFilterReq := connect.NewRequest(octodeckv1.GetItemsRequest_builder{
			Filter: octodeckv1.Filter_builder{
				Milestones: []string{"v1.32"},
			}.Build(),
		}.Build())
		addHeaders(msFilterReq)
		msFilterResp, err := client.GetItems(t.Context(), msFilterReq)
		require.NoError(t, err)
		require.Len(t, msFilterResp.Msg.GetItems(), 1)
		assert.Equal(t, "milestone_item", msFilterResp.Msg.GetItems()[0].GetId())
		assert.Equal(t, "v1.32", msFilterResp.Msg.GetItems()[0].GetMilestone().GetTitle())

		msMismatchFilterReq := connect.NewRequest(octodeckv1.GetItemsRequest_builder{
			Filter: octodeckv1.Filter_builder{
				Milestones: []string{"nonexistent"},
			}.Build(),
		}.Build())
		addHeaders(msMismatchFilterReq)
		msMismatchFilterResp, err := client.GetItems(t.Context(), msMismatchFilterReq)
		require.NoError(t, err)
		assert.Empty(t, msMismatchFilterResp.Msg.GetItems())

		// Test with Labels filter & items with labels
		itemWithLabels := octodeckv1.Item_builder{
			Id:        config.Ptr("labeled_item"),
			Repo:      config.Ptr("owner/repo"),
			Number:    config.Ptr(int32(3)),
			Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
			Title:     config.Ptr("Labeled Issue"),
			State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			UpdatedAt: timestamppb.New(time.Now()),
			Labels: []*octodeckv1.Label{
				octodeckv1.Label_builder{Name: config.Ptr("kind/bug"), Color: config.Ptr("d73a4a")}.Build(),
				octodeckv1.Label_builder{Name: config.Ptr("size/small"), Color: config.Ptr("0075ca")}.Build(),
			},
		}.Build()
		err = db.SaveItems(t.Context(), []*octodeckv1.Item{itemWithLabels})
		require.NoError(t, err)

		labelFilterReq := connect.NewRequest(octodeckv1.GetItemsRequest_builder{
			Filter: octodeckv1.Filter_builder{
				Labels: []string{"kind/bug"},
			}.Build(),
		}.Build())
		addHeaders(labelFilterReq)
		labelFilterResp, err := client.GetItems(t.Context(), labelFilterReq)
		require.NoError(t, err)
		require.Len(t, labelFilterResp.Msg.GetItems(), 1)
		assert.Equal(t, "labeled_item", labelFilterResp.Msg.GetItems()[0].GetId())

		labelMismatchReq := connect.NewRequest(octodeckv1.GetItemsRequest_builder{
			Filter: octodeckv1.Filter_builder{
				Labels: []string{"nonexistent-label"},
			}.Build(),
		}.Build())
		addHeaders(labelMismatchReq)
		labelMismatchResp, err := client.GetItems(t.Context(), labelMismatchReq)
		require.NoError(t, err)
		assert.Empty(t, labelMismatchResp.Msg.GetItems())
	})
}

func TestOctoDeckHandler_Mutators(t *testing.T) {
	db, client, addHeaders, _ := setupTestHandler(t)

	t.Run("AckItem", func(t *testing.T) {
		t1 := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
		t2 := time.Date(2026, 1, 1, 11, 0, 0, 0, time.UTC)
		t3 := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
		t4 := time.Date(2026, 1, 1, 13, 0, 0, 0, time.UTC)

		// Seed DB with UpdatedAt=t1, Comment=t2, Review=t3, StateEvent=t4
		item := octodeckv1.Item_builder{
			Id:        config.Ptr("2"),
			Title:     config.Ptr("To Ack"),
			UpdatedAt: timestamppb.New(t1),
			Comments: []*octodeckv1.Comment{
				octodeckv1.Comment_builder{CreatedAt: timestamppb.New(t2)}.Build(),
			},
			Reviews: []*octodeckv1.Review{
				octodeckv1.Review_builder{SubmittedAt: timestamppb.New(t3)}.Build(),
			},
			StateEvents: []*octodeckv1.StateEvent{
				octodeckv1.StateEvent_builder{CreatedAt: timestamppb.New(t4)}.Build(),
			},
		}.Build()
		err := db.SaveItems(t.Context(), []*octodeckv1.Item{item})
		require.NoError(t, err)

		req := connect.NewRequest(octodeckv1.AckItemRequest_builder{ItemId: config.Ptr("2")}.Build())
		addHeaders(req)

		resp, err := client.AckItem(t.Context(), req)
		require.NoError(t, err)

		assert.NotNil(t, resp.Msg.GetItem().GetLocal().GetAckedAt())
		assert.Equal(
			t,
			t4,
			resp.Msg.GetItem().GetLocal().GetAckedAt().AsTime().UTC(),
			"AckedAt should match latestActivityTimestamp (t4)",
		)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, resp.Msg.GetItem().GetLocal().GetComputedStatus())

		// Verify DB
		updated, err := db.GetItem(t.Context(), "2")
		require.NoError(t, err)
		assert.NotNil(t, updated.GetLocal().GetAckedAt())
		assert.Equal(t, t4, updated.GetLocal().GetAckedAt().AsTime().UTC())

		// Verify idempotency on repeated call
		resp2, err := client.AckItem(t.Context(), req)
		require.NoError(t, err)
		assert.Equal(t, t4, resp2.Msg.GetItem().GetLocal().GetAckedAt().AsTime().UTC())
	})

	t.Run("ViewItem", func(t *testing.T) {
		// Seed DB with an unviewed item
		item := octodeckv1.Item_builder{
			Id:        config.Ptr("view_test_item"),
			Repo:      config.Ptr("owner/repo"),
			Title:     config.Ptr("To View"),
			UpdatedAt: timestamppb.New(time.Now()),
		}.Build()
		err := db.SaveItems(t.Context(), []*octodeckv1.Item{item})
		require.NoError(t, err)

		req := connect.NewRequest(octodeckv1.ViewItemRequest_builder{ItemId: config.Ptr("view_test_item")}.Build())
		addHeaders(req)

		resp, err := client.ViewItem(t.Context(), req)
		require.NoError(t, err)

		assert.NotNil(t, resp.Msg.GetItem().GetLocal().GetLastViewedAt())
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_IDLE, resp.Msg.GetItem().GetLocal().GetComputedStatus())

		// Verify DB has LastViewedAt persisted
		updated, err := db.GetItem(t.Context(), "view_test_item")
		require.NoError(t, err)
		assert.NotNil(t, updated.GetLocal().GetLastViewedAt())
	})
}

func TestOctoDeckHandler_SyncAndConfig(t *testing.T) {
	db, client, addHeaders, mockSync := setupTestHandler(t)

	t.Run("Sync", func(t *testing.T) {
		mockSync.forceSyncCalled = false
		req := connect.NewRequest(&octodeckv1.SyncRequest{})
		addHeaders(req)

		stream, err := client.Sync(t.Context(), req)
		require.NoError(t, err)

		// Read stream
		var responses []*octodeckv1.SyncResponse
		for stream.Receive() {
			responses = append(responses, stream.Msg())
		}
		require.NoError(t, stream.Err())

		assert.True(t, mockSync.forceSyncCalled)
		require.Len(t, responses, 2)
		assert.Equal(t, octodeckv1.SyncResponse_STAGE_FETCHING, responses[0].GetStage())
		assert.Equal(t, octodeckv1.SyncResponse_STAGE_COMPLETE, responses[1].GetStage())
	})

	t.Run("Config", func(t *testing.T) {
		// 1. Get Config
		reqGet := connect.NewRequest(&octodeckv1.GetConfigRequest{})
		addHeaders(reqGet)
		respGet, err := client.GetConfig(t.Context(), reqGet)
		require.NoError(t, err)
		// Default config values
		assert.Equal(t, int32(0), respGet.Msg.GetConfig().GetPollingIntervalMin())
		assert.Equal(t, "testuser", respGet.Msg.GetCurrentUserLogin())

		// 2. Update Config
		newCfg := octodeckv1.Config_builder{
			PollingIntervalMin: config.Ptr(int32(30)),
			AutoAckOwnActivity: config.Ptr(true),
			WatchedRepos:       []string{"owner/repo"},
		}.Build()
		reqUpdate := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{Config: newCfg}.Build())
		addHeaders(reqUpdate)
		respUpdate, err := client.UpdateConfig(t.Context(), reqUpdate)
		require.NoError(t, err)
		assert.Equal(t, int32(30), respUpdate.Msg.GetConfig().GetPollingIntervalMin())
		assert.True(t, mockSync.resetTickerCalled)

		// 3. Verify Update via Get
		respGet2, err := client.GetConfig(t.Context(), reqGet)
		require.NoError(t, err)
		assert.Equal(t, int32(30), respGet2.Msg.GetConfig().GetPollingIntervalMin())
		assert.Equal(t, []string{"owner/repo"}, respGet2.Msg.GetConfig().GetWatchedRepos())

		// 4. Partial Update via FieldMask
		partialCfg := octodeckv1.Config_builder{
			PollingIntervalMin: config.Ptr(int32(60)),
			WatchedRepos:       []string{"other/repo"}, // Should NOT be updated
		}.Build()
		reqPartial := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config:     partialCfg,
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"polling_interval_min"}},
		}.Build())
		addHeaders(reqPartial)
		respPartial, err := client.UpdateConfig(t.Context(), reqPartial)
		require.NoError(t, err)
		assert.Equal(t, int32(60), respPartial.Msg.GetConfig().GetPollingIntervalMin())
		assert.Equal(t, []string{"owner/repo"}, respPartial.Msg.GetConfig().GetWatchedRepos())

		// 5. Update Label Filters with validation
		invalidLabelCfg := octodeckv1.Config_builder{
			IncludedLabels: []string{"invalid/\nlabel"},
		}.Build()
		reqInvalidLabel := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: invalidLabelCfg,
		}.Build())
		addHeaders(reqInvalidLabel)
		_, err = client.UpdateConfig(t.Context(), reqInvalidLabel)
		require.Error(t, err)

		// Valid Label Filter (Include size/*)
		validLabelCfg := octodeckv1.Config_builder{
			IncludedLabels: []string{"size/*"},
		}.Build()
		reqValidLabel := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config:     validLabelCfg,
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"included_labels"}},
		}.Build())
		addHeaders(reqValidLabel)
		respValidLabel, err := client.UpdateConfig(t.Context(), reqValidLabel)
		require.NoError(t, err)
		assert.Equal(t, []string{"size/*"}, respValidLabel.Msg.GetConfig().GetIncludedLabels())

		// Verify that GetItems filters labels on read
		readReq := connect.NewRequest(&octodeckv1.GetItemsRequest{})
		addHeaders(readReq)
		readResp, err := client.GetItems(t.Context(), readReq)
		require.NoError(t, err)
		for _, it := range readResp.Msg.GetItems() {
			if it.GetId() == "labeled_item" {
				require.Len(t, it.GetLabels(), 1)
				assert.Equal(t, "size/small", it.GetLabels()[0].GetName())
			}
		}
	})

	t.Run("RefetchItem", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.RefetchItemRequest_builder{
			ItemId: config.Ptr("item1"),
		}.Build())
		addHeaders(req)
		resp, err := client.RefetchItem(t.Context(), req)
		require.NoError(t, err)
		assert.Equal(t, "item1", resp.Msg.GetItem().GetId())

		// Verify RefetchItem using reference ID (owner/repo#number) sent by companion extension
		reqRef := connect.NewRequest(octodeckv1.RefetchItemRequest_builder{
			ItemId: config.Ptr("kubernetes/kubernetes#1234"),
		}.Build())
		addHeaders(reqRef)
		respRef, err := client.RefetchItem(t.Context(), reqRef)
		require.NoError(t, err)
		assert.Equal(t, "kubernetes/kubernetes#1234", respRef.Msg.GetItem().GetId())
	})

	t.Run("DeleteItem", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.DeleteItemRequest_builder{
			ItemId: config.Ptr("item1"),
		}.Build())
		addHeaders(req)
		_, err := client.DeleteItem(t.Context(), req)
		require.NoError(t, err)

		// Verify deleted from database
		item, err := db.GetItem(t.Context(), "item1")
		require.Error(t, err)
		assert.Nil(t, item)
	})
}

func TestOctoDeckHandler_SingleItem(t *testing.T) {
	db, client, addHeaders, _ := setupTestHandler(t)

	// Seed item "1" for GetItem, SetNotes, GetItemByRef, StarItem
	item1 := octodeckv1.Item_builder{
		Id:        config.Ptr("1"),
		Repo:      config.Ptr("owner/repo"),
		Number:    config.Ptr(int32(1)),
		Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:     config.Ptr("Test Issue 1"),
		State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		UpdatedAt: timestamppb.New(time.Now()),
	}.Build()
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{item1}))

	t.Run("StarItem", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.StarItemRequest_builder{
			ItemId:  config.Ptr("1"),
			Starred: config.Ptr(true),
		}.Build())
		addHeaders(req)
		resp, err := client.StarItem(t.Context(), req)
		require.NoError(t, err)
		assert.True(t, resp.Msg.GetItem().GetLocal().GetStarred())

		// Unstar item
		reqUnstar := connect.NewRequest(octodeckv1.StarItemRequest_builder{
			ItemId:  config.Ptr("1"),
			Starred: config.Ptr(false),
		}.Build())
		addHeaders(reqUnstar)
		respUnstar, err := client.StarItem(t.Context(), reqUnstar)
		require.NoError(t, err)
		assert.False(t, respUnstar.Msg.GetItem().GetLocal().GetStarred())
	})

	t.Run("GetItem", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.GetItemRequest_builder{
			ItemId: config.Ptr("1"),
		}.Build())
		addHeaders(req)
		resp, err := client.GetItem(t.Context(), req)
		require.NoError(t, err)
		assert.Equal(t, "1", resp.Msg.GetItem().GetId())
		assert.Equal(
			t,
			octodeckv1.ItemStatus_ITEM_STATUS_NEW,
			resp.Msg.GetItem().GetLocal().GetComputedStatus(),
		)

		// Test non-existent item
		reqNotFound := connect.NewRequest(octodeckv1.GetItemRequest_builder{
			ItemId: config.Ptr("non_existent"),
		}.Build())
		addHeaders(reqNotFound)
		_, errNotFound := client.GetItem(t.Context(), reqNotFound)
		require.Error(t, errNotFound)
	})

	t.Run("SetNotes", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.SetNotesRequest_builder{
			ItemId: config.Ptr("1"),
			Notes:  config.Ptr("These are private maintainer notes"),
		}.Build())
		addHeaders(req)
		resp, err := client.SetNotes(t.Context(), req)
		require.NoError(t, err)
		assert.Equal(t, "These are private maintainer notes", resp.Msg.GetItem().GetLocal().GetPrivateNotes())

		// Verify persisted in DB
		dbItem, err := db.GetItem(t.Context(), "1")
		require.NoError(t, err)
		assert.Equal(t, "These are private maintainer notes", dbItem.GetLocal().GetPrivateNotes())

		// Set notes using repo#number reference
		reqByRef := connect.NewRequest(octodeckv1.SetNotesRequest_builder{
			ItemId: config.Ptr("owner/repo#1"),
			Notes:  config.Ptr("Updated via reference"),
		}.Build())
		addHeaders(reqByRef)
		respByRef, err := client.SetNotes(t.Context(), reqByRef)
		require.NoError(t, err)
		assert.Equal(t, "Updated via reference", respByRef.Msg.GetItem().GetLocal().GetPrivateNotes())
	})

	t.Run("GetItemByRef", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.GetItemRequest_builder{
			ItemId: config.Ptr("owner/repo#1"),
		}.Build())
		addHeaders(req)
		resp, err := client.GetItem(t.Context(), req)
		require.NoError(t, err)
		assert.Equal(t, "1", resp.Msg.GetItem().GetId())
		assert.Equal(t, "owner/repo", resp.Msg.GetItem().GetRepo())
	})
}

func TestOctoDeckHandler_UntrackedItems_ReadDoesNotFetch(t *testing.T) {
	_, client, addHeaders, mockSync := setupTestHandler(t)

	t.Run("GetItem_UntrackedItemDoesNotFetch", func(t *testing.T) {
		mockSync.refetchItemFn = func(ctx context.Context, id string) (*octodeckv1.Item, error) {
			t.Fatalf("RefetchItem should NOT be called on GetItem for untracked item %s", id)
			return nil, errors.New("not reached")
		}

		req := connect.NewRequest(octodeckv1.GetItemRequest_builder{
			ItemId: config.Ptr("untracked-node-id"),
		}.Build())
		addHeaders(req)
		_, err := client.GetItem(t.Context(), req)
		require.Error(t, err)
		assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	})

	t.Run("ViewItem_UntrackedItemDoesNotFetch", func(t *testing.T) {
		mockSync.refetchItemFn = func(ctx context.Context, id string) (*octodeckv1.Item, error) {
			t.Fatalf("RefetchItem should NOT be called on ViewItem for untracked item %s", id)
			return nil, errors.New("not reached")
		}

		req := connect.NewRequest(octodeckv1.ViewItemRequest_builder{
			ItemId: config.Ptr("untracked-view-id"),
		}.Build())
		addHeaders(req)
		_, err := client.ViewItem(t.Context(), req)
		require.Error(t, err)
		assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	})
}

func TestOctoDeckHandler_UntrackedItems_Star(t *testing.T) {
	db, client, addHeaders, mockSync := setupTestHandler(t)

	mockSync.refetchItemFn = func(ctx context.Context, id string) (*octodeckv1.Item, error) {
		if id == "untracked-for-star" {
			item := octodeckv1.Item_builder{
				Id:     config.Ptr("untracked-for-star"),
				Repo:   config.Ptr("new/repo"),
				Number: config.Ptr(int32(88)),
				Title:  config.Ptr("Untracked For Star"),
				Local:  octodeckv1.ItemLocalState_builder{}.Build(),
			}.Build()
			if err := db.SaveItems(ctx, []*octodeckv1.Item{item}); err != nil {
				return nil, err
			}
			return item, nil
		}
		return nil, errors.New("not found")
	}

	req := connect.NewRequest(octodeckv1.StarItemRequest_builder{
		ItemId:  config.Ptr("untracked-for-star"),
		Starred: config.Ptr(true),
	}.Build())
	addHeaders(req)
	resp, err := client.StarItem(t.Context(), req)
	require.NoError(t, err)
	assert.True(t, resp.Msg.GetItem().GetLocal().GetStarred())

	// Verify in DB
	saved, err := db.GetItem(t.Context(), "untracked-for-star")
	require.NoError(t, err)
	assert.True(t, saved.GetLocal().GetStarred())
}

func TestOctoDeckHandler_UntrackedItems_Ack(t *testing.T) {
	db, client, addHeaders, mockSync := setupTestHandler(t)

	mockSync.refetchItemFn = func(ctx context.Context, id string) (*octodeckv1.Item, error) {
		if id == "untracked-for-ack" {
			item := octodeckv1.Item_builder{
				Id:        config.Ptr("untracked-for-ack"),
				Repo:      config.Ptr("new/repo"),
				Number:    config.Ptr(int32(77)),
				Title:     config.Ptr("Untracked For Ack"),
				UpdatedAt: timestamppb.New(time.Now()),
				Local:     octodeckv1.ItemLocalState_builder{}.Build(),
			}.Build()
			if err := db.SaveItems(ctx, []*octodeckv1.Item{item}); err != nil {
				return nil, err
			}
			return item, nil
		}
		return nil, errors.New("not found")
	}

	req := connect.NewRequest(octodeckv1.AckItemRequest_builder{
		ItemId: config.Ptr("untracked-for-ack"),
	}.Build())
	addHeaders(req)
	resp, err := client.AckItem(t.Context(), req)
	require.NoError(t, err)
	assert.NotNil(t, resp.Msg.GetItem().GetLocal().GetAckedAt())

	// Verify in DB
	saved, err := db.GetItem(t.Context(), "untracked-for-ack")
	require.NoError(t, err)
	assert.NotNil(t, saved.GetLocal().GetAckedAt())
}

func TestOctoDeckHandler_UntrackedItems_SetNotes(t *testing.T) {
	db, client, addHeaders, mockSync := setupTestHandler(t)

	mockSync.refetchItemFn = func(ctx context.Context, id string) (*octodeckv1.Item, error) {
		if id == "untracked-for-notes" {
			item := octodeckv1.Item_builder{
				Id:     config.Ptr("untracked-for-notes"),
				Repo:   config.Ptr("new/repo"),
				Number: config.Ptr(int32(99)),
				Title:  config.Ptr("Untracked For Notes"),
				Local:  octodeckv1.ItemLocalState_builder{}.Build(),
			}.Build()
			if err := db.SaveItems(ctx, []*octodeckv1.Item{item}); err != nil {
				return nil, err
			}
			return item, nil
		}
		return nil, errors.New("not found")
	}

	req := connect.NewRequest(octodeckv1.SetNotesRequest_builder{
		ItemId: config.Ptr("untracked-for-notes"),
		Notes:  config.Ptr("Note on newly imported item"),
	}.Build())
	addHeaders(req)
	resp, err := client.SetNotes(t.Context(), req)
	require.NoError(t, err)
	assert.Equal(t, "Note on newly imported item", resp.Msg.GetItem().GetLocal().GetPrivateNotes())

	// Verify in DB
	saved, err := db.GetItem(t.Context(), "untracked-for-notes")
	require.NoError(t, err)
	assert.Equal(t, "Note on newly imported item", saved.GetLocal().GetPrivateNotes())
}

func TestOctoDeckHandler_StatsAndTraces(t *testing.T) {
	db, client, addHeaders, _ := setupTestHandler(t)

	t.Run("GetSyncStatus", func(t *testing.T) {
		req := connect.NewRequest(&octodeckv1.GetSyncStatusRequest{})
		addHeaders(req)
		resp, err := client.GetSyncStatus(t.Context(), req)
		require.NoError(t, err)
		assert.NotNil(t, resp.Msg.GetStatus())
	})

	t.Run("GetSyncTraces", func(t *testing.T) {
		// Seed a trace in DB
		payload := []byte(`{"test": "payload"}`)
		compressed, err := database.CompressPayload(payload)
		require.NoError(t, err)

		rateLimit := int32(4900)
		trace := &database.SyncTrace{
			ID:                   "trace-rpc-test",
			TraceType:            "heartbeat",
			TriggerSource:        "ticker",
			QueryString:          "repo:test/repo updated:>2026-08-13T00:00:00Z",
			ReposEvaluated:       `["test/repo"]`,
			SinceTimestamp:       "2026-08-13T00:00:00Z",
			DurationMs:           120,
			PagesCount:           1,
			ItemsFetched:         2,
			ItemsPersisted:       2,
			RateLimitRemaining:   &rateLimit,
			RawPayloadCompressed: compressed,
			CreatedAt:            time.Now().UTC().Format(time.RFC3339),
		}
		require.NoError(t, db.SaveSyncTrace(t.Context(), trace))

		req := connect.NewRequest(octodeckv1.GetSyncTracesRequest_builder{
			Limit:          config.Ptr(int32(10)),
			IncludePayload: config.Ptr(true),
		}.Build())
		addHeaders(req)
		resp, err := client.GetSyncTraces(t.Context(), req)
		require.NoError(t, err)
		require.NotEmpty(t, resp.Msg.GetTraces())
		assert.Equal(t, "trace-rpc-test", resp.Msg.GetTraces()[0].GetId())
		assert.JSONEq(t, `{"test": "payload"}`, resp.Msg.GetTraces()[0].GetRawPayload())
		assert.Equal(t, []string{"test/repo"}, resp.Msg.GetTraces()[0].GetReposEvaluated())
	})

	t.Run("GetDatabaseStats", func(t *testing.T) {
		req := connect.NewRequest(&octodeckv1.GetDatabaseStatsRequest{})
		addHeaders(req)
		resp, err := client.GetDatabaseStats(t.Context(), req)
		require.NoError(t, err)
		assert.NotNil(t, resp.Msg.GetStats())
		assert.GreaterOrEqual(t, resp.Msg.GetStats().GetTotalItems(), int64(0))
	})
}
