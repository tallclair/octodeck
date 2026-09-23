package server

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/cli/go-gh/v2/pkg/api"
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
	return setupTestHandlerWithGH(t, &mockGitHubClient{authenticated: true})
}

func setupTestHandlerWithGH(
	t *testing.T,
	mockGH *mockGitHubClient,
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
	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())

	var gh GitHubClient
	if mockGH != nil {
		gh = mockGH
	}
	s := New(db, gh, mockSync, cfg, nil)
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
		assert.Equal(t, int32(0), respGet.Msg.GetConfig().GetDiscoveryIntervalMin())
		assert.Empty(t, respGet.Msg.GetConfig().GetTrackedQueries())
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

		// 6. Update Discovery Interval and Tracked Queries
		queries := []string{"repo:kubernetes/kubernetes is:open label:sig/node"}
		discoveryCfg := octodeckv1.Config_builder{
			DiscoveryIntervalMin: config.Ptr(int32(45)),
			TrackedQueries:       queries,
		}.Build()
		reqDiscovery := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config:     discoveryCfg,
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"discovery_interval_min", "tracked_queries"}},
		}.Build())
		addHeaders(reqDiscovery)
		respDiscovery, err := client.UpdateConfig(t.Context(), reqDiscovery)
		require.NoError(t, err)
		assert.Equal(t, int32(45), respDiscovery.Msg.GetConfig().GetDiscoveryIntervalMin())
		assert.Equal(t, queries, respDiscovery.Msg.GetConfig().GetTrackedQueries())

		// Verify via GetConfig
		respGet3, err := client.GetConfig(t.Context(), reqGet)
		require.NoError(t, err)
		assert.Equal(t, int32(45), respGet3.Msg.GetConfig().GetDiscoveryIntervalMin())
		assert.Equal(t, queries, respGet3.Msg.GetConfig().GetTrackedQueries())

		// 7. Validation: Negative discovery_interval_min should return InvalidArgument
		invalidDiscoveryCfg := octodeckv1.Config_builder{
			DiscoveryIntervalMin: config.Ptr(int32(-5)),
		}.Build()
		reqInvalidDiscovery := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: invalidDiscoveryCfg,
		}.Build())
		addHeaders(reqInvalidDiscovery)
		_, err = client.UpdateConfig(t.Context(), reqInvalidDiscovery)
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))

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

func TestOctoDeckHandler_DiscoveryAndTrackedQueriesConfig(t *testing.T) {
	_, client, addHeaders, _ := setupTestHandler(t)

	t.Run("UpdateAndGetTrackedQueriesAndDiscoveryInterval", func(t *testing.T) {
		queries := []string{
			"repo:kubernetes/kubernetes is:open label:sig/node",
			"org:octodeck is:pr is:open",
		}
		updateCfg := octodeckv1.Config_builder{
			DiscoveryIntervalMin: config.Ptr(int32(15)),
			TrackedQueries:       queries,
		}.Build()

		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: updateCfg,
		}.Build())
		addHeaders(req)

		updateResp, err := client.UpdateConfig(t.Context(), req)
		require.NoError(t, err)
		assert.Equal(t, int32(15), updateResp.Msg.GetConfig().GetDiscoveryIntervalMin())
		assert.Equal(t, queries, updateResp.Msg.GetConfig().GetTrackedQueries())

		// Verify GetConfig reflects the changes
		getReq := connect.NewRequest(&octodeckv1.GetConfigRequest{})
		addHeaders(getReq)
		getResp, err := client.GetConfig(t.Context(), getReq)
		require.NoError(t, err)
		assert.Equal(t, int32(15), getResp.Msg.GetConfig().GetDiscoveryIntervalMin())
		assert.Equal(t, queries, getResp.Msg.GetConfig().GetTrackedQueries())
	})

	t.Run("UpdateWithFieldMask_TrackedQueriesOnly", func(t *testing.T) {
		updateCfg := octodeckv1.Config_builder{
			TrackedQueries:       []string{"repo:golang/go is:issue"},
			DiscoveryIntervalMin: config.Ptr(int32(99)), // should NOT be updated
		}.Build()

		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config:     updateCfg,
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"tracked_queries"}},
		}.Build())
		addHeaders(req)

		updateResp, err := client.UpdateConfig(t.Context(), req)
		require.NoError(t, err)
		assert.Equal(t, []string{"repo:golang/go is:issue"}, updateResp.Msg.GetConfig().GetTrackedQueries())
	})

	t.Run("Validation_RejectNegativeDiscoveryInterval", func(t *testing.T) {
		updateCfg := octodeckv1.Config_builder{
			DiscoveryIntervalMin: config.Ptr(int32(-1)),
		}.Build()

		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: updateCfg,
		}.Build())
		addHeaders(req)

		_, err := client.UpdateConfig(t.Context(), req)
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		assert.Contains(t, err.Error(), "discovery_interval_min cannot be negative")
	})
}

func TestOctoDeckHandler_UpdateConfig_RepeatedFieldsClearing(t *testing.T) {
	_, client, addHeaders, _ := setupTestHandler(t)

	testCases := []struct {
		name      string
		fieldPath string
		seedCfg   *octodeckv1.Config
		clearCfg  *octodeckv1.Config
		getSlice  func(*octodeckv1.Config) []string
	}{
		{
			name:      "tracked_queries",
			fieldPath: "tracked_queries",
			seedCfg: octodeckv1.Config_builder{
				TrackedQueries: []string{"repo:kubernetes/kubernetes is:open", "org:octodeck is:pr"},
			}.Build(),
			clearCfg: octodeckv1.Config_builder{TrackedQueries: []string{}}.Build(),
			getSlice: func(c *octodeckv1.Config) []string { return c.GetTrackedQueries() },
		},
		{
			name:      "watched_repos",
			fieldPath: "watched_repos",
			seedCfg: octodeckv1.Config_builder{
				WatchedRepos: []string{"owner/repo1", "owner/repo2"},
			}.Build(),
			clearCfg: octodeckv1.Config_builder{WatchedRepos: []string{}}.Build(),
			getSlice: func(c *octodeckv1.Config) []string { return c.GetWatchedRepos() },
		},
		{
			name:      "excluded_labels",
			fieldPath: "excluded_labels",
			seedCfg: octodeckv1.Config_builder{
				ExcludedLabels: []string{"wip", "do-not-merge"},
			}.Build(),
			clearCfg: octodeckv1.Config_builder{ExcludedLabels: []string{}}.Build(),
			getSlice: func(c *octodeckv1.Config) []string { return c.GetExcludedLabels() },
		},
	}

	for _, tc := range testCases {
		t.Run("FieldMask successfully clears "+tc.name+" when empty slice provided", func(t *testing.T) {
			seedReq := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
				Config:     tc.seedCfg,
				UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{tc.fieldPath}},
			}.Build())
			addHeaders(seedReq)
			seedResp, err := client.UpdateConfig(t.Context(), seedReq)
			require.NoError(t, err)
			require.NotEmpty(t, tc.getSlice(seedResp.Msg.GetConfig()))

			clearReq := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
				Config:     tc.clearCfg,
				UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{tc.fieldPath}},
			}.Build())
			addHeaders(clearReq)
			clearResp, err := client.UpdateConfig(t.Context(), clearReq)
			require.NoError(t, err)
			assert.Empty(t, tc.getSlice(clearResp.Msg.GetConfig()))

			// Verify GetConfig reflects empty state
			getReq := connect.NewRequest(&octodeckv1.GetConfigRequest{})
			addHeaders(getReq)
			getResp, err := client.GetConfig(t.Context(), getReq)
			require.NoError(t, err)
			assert.Empty(t, tc.getSlice(getResp.Msg.GetConfig()))
		})
	}

	t.Run("Full config update without FieldMask clears repeated fields", func(t *testing.T) {
		// Seed
		seedReq := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{
				WatchedRepos:         []string{"owner/repo"},
				TrackedQueries:       []string{"repo:owner/repo is:open"},
				DiscoveryIntervalMin: config.Ptr(int32(30)),
			}.Build(),
		}.Build())
		addHeaders(seedReq)
		_, err := client.UpdateConfig(t.Context(), seedReq)
		require.NoError(t, err)

		// Full update with empty lists
		updateReq := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{
				DiscoveryIntervalMin: config.Ptr(int32(45)),
			}.Build(),
		}.Build())
		addHeaders(updateReq)
		resp, err := client.UpdateConfig(t.Context(), updateReq)
		require.NoError(t, err)
		assert.Empty(t, resp.Msg.GetConfig().GetWatchedRepos())
		assert.Empty(t, resp.Msg.GetConfig().GetTrackedQueries())
		assert.Equal(t, int32(45), resp.Msg.GetConfig().GetDiscoveryIntervalMin())
	})
}

func TestOctoDeckHandler_UpdateConfig_SliceImmutability(t *testing.T) {
	_, client, addHeaders, _ := setupTestHandler(t)

	t.Run("Mutating request slice after UpdateConfig does not mutate server config", func(t *testing.T) {
		queries := []string{"repo:a/b query_a", "repo:a/b query_b"}
		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{
				TrackedQueries: queries,
			}.Build(),
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"tracked_queries"}},
		}.Build())
		addHeaders(req)
		resp, err := client.UpdateConfig(t.Context(), req)
		require.NoError(t, err)
		assert.Equal(t, []string{"repo:a/b query_a", "repo:a/b query_b"}, resp.Msg.GetConfig().GetTrackedQueries())

		// Mutate caller slice
		queries[0] = "MALICIOUS_MUTATION"

		// Query server config
		getReq := connect.NewRequest(&octodeckv1.GetConfigRequest{})
		addHeaders(getReq)
		getResp, err := client.GetConfig(t.Context(), getReq)
		require.NoError(t, err)
		assert.Equal(t, "repo:a/b query_a", getResp.Msg.GetConfig().GetTrackedQueries()[0],
			"server config must be immune to client slice mutation")
	})
}

func TestOctoDeckHandler_UpdateConfig_ValidationAndErrorPaths(t *testing.T) {
	db, client, addHeaders, _ := setupTestHandler(t)

	t.Run("Nil request message config returns InvalidArgument", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{}.Build())
		addHeaders(req)
		_, err := client.UpdateConfig(t.Context(), req)
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		assert.Contains(t, err.Error(), "config is required")
	})

	t.Run("Negative discovery intervals rejected with InvalidArgument", func(t *testing.T) {
		for _, val := range []int32{-1, -5, -60, -9999, math.MinInt32} {
			req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
				Config: octodeckv1.Config_builder{DiscoveryIntervalMin: config.Ptr(val)}.Build(),
			}.Build())
			addHeaders(req)
			_, err := client.UpdateConfig(t.Context(), req)
			require.Error(t, err)
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
			assert.Contains(t, err.Error(), "discovery_interval_min cannot be negative")
		}
	})

	t.Run("Negative discovery interval rejected even with partial mask", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{
				DiscoveryIntervalMin: config.Ptr(int32(-10)),
				TrackedQueries:       []string{"repo:golang/go is:open"},
			}.Build(),
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"tracked_queries"}},
		}.Build())
		addHeaders(req)
		_, err := client.UpdateConfig(t.Context(), req)
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})

	t.Run("Zero discovery interval accepted", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{DiscoveryIntervalMin: config.Ptr(int32(0))}.Build(),
		}.Build())
		addHeaders(req)
		resp, err := client.UpdateConfig(t.Context(), req)
		require.NoError(t, err)
		assert.Equal(t, int32(0), resp.Msg.GetConfig().GetDiscoveryIntervalMin())
	})

	t.Run("Invalid watched_repos returns InvalidArgument", func(t *testing.T) {
		invalidCases := [][]string{
			{"invalid-repo-without-slash"},
			{"owner/repo/subpath"},
			{"owner/repo?bad=char"},
		}
		for _, repos := range invalidCases {
			req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
				Config: octodeckv1.Config_builder{WatchedRepos: repos}.Build(),
			}.Build())
			addHeaders(req)
			_, err := client.UpdateConfig(t.Context(), req)
			require.Error(t, err)
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
			assert.Contains(t, err.Error(), "invalid watched_repos")
		}
	})

	t.Run("Invalid excluded_repos returns InvalidArgument", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{ExcludedRepos: []string{"bad-repo-format"}}.Build(),
		}.Build())
		addHeaders(req)
		_, err := client.UpdateConfig(t.Context(), req)
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		assert.Contains(t, err.Error(), "invalid excluded_repos")
	})

	t.Run("Invalid included_labels returns InvalidArgument", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{IncludedLabels: []string{"label\x00with-null"}}.Build(),
		}.Build())
		addHeaders(req)
		_, err := client.UpdateConfig(t.Context(), req)
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		assert.Contains(t, err.Error(), "invalid included_labels")
	})

	t.Run("Invalid excluded_labels returns InvalidArgument", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{ExcludedLabels: []string{"label\x1bwith-escape"}}.Build(),
		}.Build())
		addHeaders(req)
		_, err := client.UpdateConfig(t.Context(), req)
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		assert.Contains(t, err.Error(), "invalid excluded_labels")
	})

	t.Run("Invalid tracked_queries with null byte returns InvalidArgument", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{TrackedQueries: []string{"repo:golang/go\x00is:open"}}.Build(),
		}.Build())
		addHeaders(req)
		_, err := client.UpdateConfig(t.Context(), req)
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		assert.Contains(t, err.Error(), "invalid tracked_queries")
	})

	t.Run("Invalid tracked_queries with updated filter returns InvalidArgument", func(t *testing.T) {
		invalidQueries := []string{"repo:golang/go is:open updated:>2026-01-01"}
		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{TrackedQueries: invalidQueries}.Build(),
		}.Build())
		addHeaders(req)
		_, err := client.UpdateConfig(t.Context(), req)
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		assert.Contains(t, err.Error(), "cannot contain an 'updated' filter")
	})

	t.Run("Tracked queries seeds discovery cursor on addition", func(t *testing.T) {
		const newQuery = "repo:octodeck/seeds-cursor is:open"
		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{
				TrackedQueries: []string{newQuery},
			}.Build(),
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"tracked_queries"}},
		}.Build())
		addHeaders(req)
		_, err := client.UpdateConfig(t.Context(), req)
		require.NoError(t, err)

		cursor, exists, err := db.GetDiscoveryCursor(t.Context(), newQuery)
		require.NoError(t, err)
		assert.True(t, exists, "discovery cursor should be seeded when new query is added")
		assert.False(t, cursor.IsZero())
	})

	t.Run("Tracked queries sanitization and order preservation over RPC", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{
				TrackedQueries: []string{
					"  repo:b/b is:open  ",
					"repo:a/a is:issue",
					"repo:b/b is:open",
					"",
					"   ",
					"repo:c/c is:pr",
				},
			}.Build(),
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"tracked_queries"}},
		}.Build())
		addHeaders(req)
		resp, err := client.UpdateConfig(t.Context(), req)
		require.NoError(t, err)
		assert.Equal(t, []string{
			"repo:b/b is:open",
			"repo:a/a is:issue",
			"repo:c/c is:pr",
		}, resp.Msg.GetConfig().GetTrackedQueries())
	})

	t.Run("FieldMask with unknown paths safely ignored without panic", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{
				DiscoveryIntervalMin: config.Ptr(int32(25)),
				TrackedQueries:       []string{"repo:golang/go is:issue"},
			}.Build(),
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"nonexistent_field", "!@#$%^&*", ""}},
		}.Build())
		addHeaders(req)
		resp, err := client.UpdateConfig(t.Context(), req)
		require.NoError(t, err)
		// Unknown mask paths mean neither discoveryIntervalMin nor tracked_queries were updated
		assert.NotEqual(t, int32(25), resp.Msg.GetConfig().GetDiscoveryIntervalMin())
	})

	t.Run("FieldMask supports both snake_case and camelCase paths", func(t *testing.T) {
		// snake_case
		req1 := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config:     octodeckv1.Config_builder{TrackedQueries: []string{"repo:a/b query_snake"}}.Build(),
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"tracked_queries"}},
		}.Build())
		addHeaders(req1)
		resp1, err := client.UpdateConfig(t.Context(), req1)
		require.NoError(t, err)
		assert.Equal(t, []string{"repo:a/b query_snake"}, resp1.Msg.GetConfig().GetTrackedQueries())

		// camelCase
		req2 := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config:     octodeckv1.Config_builder{TrackedQueries: []string{"repo:a/b query_camel"}}.Build(),
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"trackedQueries"}},
		}.Build())
		addHeaders(req2)
		resp2, err := client.UpdateConfig(t.Context(), req2)
		require.NoError(t, err)
		assert.Equal(t, []string{"repo:a/b query_camel"}, resp2.Msg.GetConfig().GetTrackedQueries())
	})

	t.Run("TrackedQueries missing scope qualifier returns InvalidArgument", func(t *testing.T) {
		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{
				TrackedQueries: []string{"is:open label:bug"},
			}.Build(),
		}.Build())
		addHeaders(req)
		_, err := client.UpdateConfig(t.Context(), req)
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		assert.Contains(t, err.Error(), "must include a positive scope qualifier")
	})

	t.Run("Pre-flight check warns when query exceeds 50/day avg and saves on force_save", func(t *testing.T) {
		var queriedStrings []string
		mockGH := &mockGitHubClient{
			authenticated: true,
			countSearchIssuesFn: func(_ context.Context, searchQuery string) (int32, error) {
				queriedStrings = append(queriedStrings, searchQuery)
				if assert.Contains(t, searchQuery, "created:>") {
					// If it's the broad query, return 140 items in 48h (70/day > 50/day)
					if len(queriedStrings) == 1 {
						return 140, nil
					}
					// Second query is low volume: 20 items in 48h (10/day <= 50/day)
					return 20, nil
				}
				return 0, nil
			},
		}
		_, ghClient, ghAddHeaders, _ := setupTestHandlerWithGH(t, mockGH)

		broadQuery := "org:kubernetes is:open"
		narrowQuery := "repo:kubernetes/kubernetes is:open label:sig/node"

		// 1. UpdateConfig without force_save should not persist and should return warning for broadQuery only
		req := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{
				TrackedQueries: []string{broadQuery, narrowQuery},
			}.Build(),
		}.Build())
		ghAddHeaders(req)
		resp, err := ghClient.UpdateConfig(t.Context(), req)
		require.NoError(t, err)
		assert.False(t, resp.Msg.GetSaved())
		require.Len(t, resp.Msg.GetQueryWarnings(), 1)
		w := resp.Msg.GetQueryWarnings()[0]
		assert.Equal(t, broadQuery, w.GetQuery())
		assert.Equal(t, int32(140), w.GetMatchCount_48H())
		assert.InDelta(t, 70.0, w.GetDailyAverage(), 0.01)
		assert.Contains(t, w.GetMessage(), "140 items created in the last 48h")
		assert.Empty(t, resp.Msg.GetConfig().GetTrackedQueries(), "config must not be saved when warning blocks")

		// 2. Retry with ForceSave: true should persist both queries
		reqForce := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
			Config: octodeckv1.Config_builder{
				TrackedQueries: []string{broadQuery, narrowQuery},
			}.Build(),
			ForceSave: config.Ptr(true),
		}.Build())
		ghAddHeaders(reqForce)
		respForce, err := ghClient.UpdateConfig(t.Context(), reqForce)
		require.NoError(t, err)
		assert.True(t, respForce.Msg.GetSaved())
		assert.Empty(t, respForce.Msg.GetQueryWarnings())
		assert.Equal(t, []string{broadQuery, narrowQuery}, respForce.Msg.GetConfig().GetTrackedQueries())
		require.Len(t, respForce.Msg.GetQueryStats(), 2)
		assert.Equal(t, broadQuery, respForce.Msg.GetQueryStats()[0].GetQuery())
		assert.Equal(t, narrowQuery, respForce.Msg.GetQueryStats()[1].GetQuery())

		// Verify GetConfig also returns QueryStats for each tracked query
		getReq := connect.NewRequest(&octodeckv1.GetConfigRequest{})
		ghAddHeaders(getReq)
		getResp, err := ghClient.GetConfig(t.Context(), getReq)
		require.NoError(t, err)
		require.Len(t, getResp.Msg.GetQueryStats(), 2)
	})
}

func TestOctoDeckHandler_UpdateSubscription(t *testing.T) {
	t.Run("Successful subscription updates across states and identifiers", func(t *testing.T) {
		var (
			calledID    string
			calledState octodeckv1.SubscriptionState
			callCount   int
		)

		mockGH := &mockGitHubClient{
			authenticated: true,
			updateSubscriptionFn: func(_ context.Context, id string, state octodeckv1.SubscriptionState) error {
				calledID = id
				calledState = state
				callCount++
				return nil
			},
		}

		db, client, addHeaders, _ := setupTestHandlerWithGH(t, mockGH)

		// Seed initial item with UNSUBSCRIBED state
		initialItem := octodeckv1.Item_builder{
			Id:                 config.Ptr("PR_node_123"),
			Repo:               config.Ptr("owner/repo"),
			Number:             config.Ptr(int32(101)),
			Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
			Title:              config.Ptr("Test Pull Request"),
			State:              config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			ViewerSubscription: config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED),
			UpdatedAt:          timestamppb.Now(),
		}.Build()
		require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{initialItem}))

		testCases := []struct {
			name          string
			targetID      string
			inputState    octodeckv1.SubscriptionState
			expectedState octodeckv1.SubscriptionState
		}{
			{
				name:          "Subscribe via node ID",
				targetID:      "PR_node_123",
				inputState:    octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED,
				expectedState: octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED,
			},
			{
				name:          "Ignore via repo#number reference",
				targetID:      "owner/repo#101",
				inputState:    octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_IGNORED,
				expectedState: octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_IGNORED,
			},
			{
				name:          "Unsubscribe via node ID",
				targetID:      "PR_node_123",
				inputState:    octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED,
				expectedState: octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED,
			},
			{
				name:          "Unspecified state defaults to Subscribed",
				targetID:      "PR_node_123",
				inputState:    octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSPECIFIED,
				expectedState: octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED,
			},
		}

		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				prevCount := callCount
				req := connect.NewRequest(octodeckv1.UpdateSubscriptionRequest_builder{
					ItemId: config.Ptr(tc.targetID),
					State:  config.Ptr(tc.inputState),
				}.Build())
				addHeaders(req)

				resp, err := client.UpdateSubscription(t.Context(), req)
				require.NoError(t, err)
				require.NotNil(t, resp)

				// Verify GitHub client invocation
				assert.Equal(t, prevCount+1, callCount)
				assert.Equal(t, "PR_node_123", calledID)
				assert.Equal(t, tc.expectedState, calledState)

				// Verify response item
				assert.Equal(t, "PR_node_123", resp.Msg.GetItem().GetId())
				assert.Equal(t, tc.expectedState, resp.Msg.GetItem().GetViewerSubscription())

				// Verify persistence in SQLite
				persisted, err := db.GetItem(t.Context(), "PR_node_123")
				require.NoError(t, err)
				assert.Equal(t, tc.expectedState, persisted.GetViewerSubscription())
			})
		}
	})

	t.Run("Empty item ID returns InvalidArgument", func(t *testing.T) {
		_, client, addHeaders, _ := setupTestHandler(t)

		req := connect.NewRequest(octodeckv1.UpdateSubscriptionRequest_builder{
			ItemId: config.Ptr(""),
			State:  config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED),
		}.Build())
		addHeaders(req)

		_, err := client.UpdateSubscription(t.Context(), req)
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		assert.Contains(t, err.Error(), "item_id is required")
	})

	t.Run("Whitespace-only item ID returns InvalidArgument", func(t *testing.T) {
		_, client, addHeaders, _ := setupTestHandler(t)

		testCases := []struct {
			name   string
			itemID string
		}{
			{name: "spaces only", itemID: "   "},
			{name: "tabs and newlines", itemID: "\t\n"},
			{name: "mixed whitespace", itemID: " \t \r\n "},
			{name: "single space", itemID: " "},
			{name: "newline only", itemID: "\n"},
		}

		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				req := connect.NewRequest(octodeckv1.UpdateSubscriptionRequest_builder{
					ItemId: config.Ptr(tc.itemID),
					State:  config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED),
				}.Build())
				addHeaders(req)

				_, err := client.UpdateSubscription(t.Context(), req)
				require.Error(t, err)
				assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
				assert.Contains(t, err.Error(), "item_id is required")
			})
		}
	})

	t.Run("Invalid subscription state returns InvalidArgument", func(t *testing.T) {
		var ghCalled bool
		mockGH := &mockGitHubClient{
			authenticated: true,
			updateSubscriptionFn: func(_ context.Context, _ string, _ octodeckv1.SubscriptionState) error {
				ghCalled = true
				return nil
			},
		}

		db, client, addHeaders, _ := setupTestHandlerWithGH(t, mockGH)

		// Seed item in database
		item := octodeckv1.Item_builder{
			Id:                 config.Ptr("PR_valid_item"),
			Repo:               config.Ptr("owner/repo"),
			Number:             config.Ptr(int32(101)),
			Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
			ViewerSubscription: config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED),
			UpdatedAt:          timestamppb.Now(),
		}.Build()
		require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{item}))

		invalidStates := []struct {
			name  string
			state octodeckv1.SubscriptionState
		}{
			{name: "unknown positive enum 999", state: octodeckv1.SubscriptionState(999)},
			{name: "negative enum -1", state: octodeckv1.SubscriptionState(-1)},
			{name: "out of range enum 42", state: octodeckv1.SubscriptionState(42)},
		}

		for _, tc := range invalidStates {
			t.Run(tc.name, func(t *testing.T) {
				ghCalled = false
				req := connect.NewRequest(octodeckv1.UpdateSubscriptionRequest_builder{
					ItemId: config.Ptr("PR_valid_item"),
					State:  config.Ptr(tc.state),
				}.Build())
				addHeaders(req)

				_, err := client.UpdateSubscription(t.Context(), req)
				require.Error(t, err)
				assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
				assert.Contains(t, err.Error(), "unsupported subscription state")
				assert.False(t, ghCalled, "GitHub client must not be called when subscription state is invalid")

				// Ensure DB state is unchanged
				persisted, err := db.GetItem(t.Context(), "PR_valid_item")
				require.NoError(t, err)
				expectedSub := octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED
				assert.Equal(t, expectedSub, persisted.GetViewerSubscription())
			})
		}
	})

	t.Run("Nil ghClient rejects invalid enums and prevents SQLite corruption", func(t *testing.T) {
		db, client, addHeaders, _ := setupTestHandlerWithGH(t, nil)

		item := octodeckv1.Item_builder{
			Id:                 config.Ptr("PR_nil_client_test"),
			Repo:               config.Ptr("owner/repo"),
			Number:             config.Ptr(int32(105)),
			Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
			Title:              config.Ptr("Nil Client PR"),
			ViewerSubscription: config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED),
			UpdatedAt:          timestamppb.Now(),
		}.Build()
		require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{item}))

		invalidStates := []struct {
			name  string
			state octodeckv1.SubscriptionState
		}{
			{name: "invalid positive enum 999", state: octodeckv1.SubscriptionState(999)},
			{name: "invalid negative enum -1", state: octodeckv1.SubscriptionState(-1)},
			{name: "invalid out of range enum 42", state: octodeckv1.SubscriptionState(42)},
		}

		for _, tc := range invalidStates {
			t.Run(tc.name, func(t *testing.T) {
				req := connect.NewRequest(octodeckv1.UpdateSubscriptionRequest_builder{
					ItemId: config.Ptr("PR_nil_client_test"),
					State:  config.Ptr(tc.state),
				}.Build())
				addHeaders(req)

				_, err := client.UpdateSubscription(t.Context(), req)
				require.Error(t, err, "UpdateSubscription should fail for invalid state even with nil ghClient")
				assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
				assert.Contains(t, err.Error(), "unsupported subscription state")

				persisted, err := db.GetItem(t.Context(), "PR_nil_client_test")
				require.NoError(t, err)
				expectedSub := octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED
				assert.Equal(
					t,
					expectedSub,
					persisted.GetViewerSubscription(),
					"SQLite viewer_subscription must remain UNSUBSCRIBED and not be overwritten",
				)
			})
		}
	})

	t.Run("Item not found in DB returns NotFound", func(t *testing.T) {
		var ghCalled bool
		mockGH := &mockGitHubClient{
			authenticated: true,
			updateSubscriptionFn: func(_ context.Context, _ string, _ octodeckv1.SubscriptionState) error {
				ghCalled = true
				return nil
			},
		}

		_, client, addHeaders, _ := setupTestHandlerWithGH(t, mockGH)

		req := connect.NewRequest(octodeckv1.UpdateSubscriptionRequest_builder{
			ItemId: config.Ptr("non_existent_item"),
			State:  config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED),
		}.Build())
		addHeaders(req)

		_, err := client.UpdateSubscription(t.Context(), req)
		require.Error(t, err)
		assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
		assert.Contains(t, err.Error(), "not found")
		assert.False(t, ghCalled, "GitHub client should not be called if item does not exist")
	})

	t.Run("GitHub client failure returns Internal and preserves DB state", func(t *testing.T) {
		mockGH := &mockGitHubClient{
			authenticated: true,
			updateSubscriptionFn: func(_ context.Context, _ string, _ octodeckv1.SubscriptionState) error {
				return errors.New("rate limit exceeded")
			},
		}

		db, client, addHeaders, _ := setupTestHandlerWithGH(t, mockGH)

		initialItem := octodeckv1.Item_builder{
			Id:                 config.Ptr("PR_node_fail"),
			Repo:               config.Ptr("owner/repo"),
			Number:             config.Ptr(int32(102)),
			Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
			ViewerSubscription: config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED),
			UpdatedAt:          timestamppb.Now(),
		}.Build()
		require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{initialItem}))

		req := connect.NewRequest(octodeckv1.UpdateSubscriptionRequest_builder{
			ItemId: config.Ptr("PR_node_fail"),
			State:  config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED),
		}.Build())
		addHeaders(req)

		_, err := client.UpdateSubscription(t.Context(), req)
		require.Error(t, err)
		assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
		assert.Contains(t, err.Error(), "failed to update subscription on GitHub")

		// Confirm local DB state was NOT modified
		item, err := db.GetItem(t.Context(), "PR_node_fail")
		require.NoError(t, err)
		assert.Equal(t, octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED, item.GetViewerSubscription())
	})

	t.Run("GitHub scope errors return PermissionDenied and preserve DB state", func(t *testing.T) {
		headersWithMissingScope := make(http.Header)
		headersWithMissingScope.Set("X-Accepted-Oauth-Scopes", "notifications")
		headersWithMissingScope.Set("X-Oauth-Scopes", "repo, read:org")

		testCases := []struct {
			name     string
			ghErr    error
			checkMsg string
		}{
			{
				name: "GraphQL FORBIDDEN error with notifications message",
				ghErr: &api.GraphQLError{
					Errors: []api.GraphQLErrorItem{
						{
							Type: "FORBIDDEN",
							Message: "Your token has not been granted the required scopes to execute this query. " +
								"The 'notifications' scope is required to access the 'updateSubscription' field.",
						},
					},
				},
				checkMsg: "The 'notifications' scope is required",
			},
			{
				name: "GraphQL error without FORBIDDEN type but containing scope requirement",
				ghErr: &api.GraphQLError{
					Errors: []api.GraphQLErrorItem{
						{
							Type:    "ERROR",
							Message: "Resource requires the 'notifications' scope to access",
						},
					},
				},
				checkMsg: "requires the 'notifications' scope",
			},
			{
				name: "HTTP 403 Forbidden with OAuth scope headers",
				ghErr: &api.HTTPError{
					StatusCode: http.StatusForbidden,
					Headers:    headersWithMissingScope,
					Message:    "Forbidden",
				},
				checkMsg: "Forbidden",
			},
			{
				name: "HTTP 403 Forbidden with resource not accessible message",
				ghErr: &api.HTTPError{
					StatusCode: http.StatusForbidden,
					Message:    "Resource not accessible by integration",
				},
				checkMsg: "Resource not accessible by integration",
			},
			{
				name: "Organization SAML enforcement error",
				ghErr: errors.New("Resource protected by organization SAML enforcement. " +
					"You must grant your OAuth token access to this organization."),
				checkMsg: "SAML enforcement",
			},
			{
				name: "Wrapped scope error simulating client error wrapping",
				ghErr: fmt.Errorf("failed to update subscription: %w", &api.GraphQLError{
					Errors: []api.GraphQLErrorItem{
						{
							Type:    "FORBIDDEN",
							Message: "Missing required scope: notifications",
						},
					},
				}),
				checkMsg: "Missing required scope: notifications",
			},
		}

		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				mockGH := &mockGitHubClient{
					authenticated: true,
					updateSubscriptionFn: func(_ context.Context, _ string, _ octodeckv1.SubscriptionState) error {
						return tc.ghErr
					},
				}

				db, client, addHeaders, _ := setupTestHandlerWithGH(t, mockGH)

				initialItem := octodeckv1.Item_builder{
					Id:                 config.Ptr("PR_scope_test"),
					Repo:               config.Ptr("owner/repo"),
					Number:             config.Ptr(int32(103)),
					Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
					ViewerSubscription: config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED),
					UpdatedAt:          timestamppb.Now(),
				}.Build()
				require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{initialItem}))

				req := connect.NewRequest(octodeckv1.UpdateSubscriptionRequest_builder{
					ItemId: config.Ptr("PR_scope_test"),
					State:  config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED),
				}.Build())
				addHeaders(req)

				_, err := client.UpdateSubscription(t.Context(), req)
				require.Error(t, err)

				// 1. Assert returned connect error code is CodePermissionDenied
				assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))

				// 2. Assert error message contains actionable remediation instructions
				assert.Contains(t, err.Error(), "GitHub token lacks 'notifications' scope")
				assert.Contains(t, err.Error(), "gh auth refresh -s notifications")
				assert.Contains(t, err.Error(), tc.checkMsg)

				// 3. Confirm local DB state was NOT modified
				persisted, err := db.GetItem(t.Context(), "PR_scope_test")
				require.NoError(t, err)
				assert.Equal(t,
					octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED,
					persisted.GetViewerSubscription(),
				)
			})
		}
	})
}

func TestIsGitHubScopeError(t *testing.T) {
	headersWithMissingScope := make(http.Header)
	headersWithMissingScope.Set("X-Accepted-Oauth-Scopes", "notifications")
	headersWithMissingScope.Set("X-Oauth-Scopes", "repo, read:org")

	headersWithSufficientScope := make(http.Header)
	headersWithSufficientScope.Set("X-Accepted-Oauth-Scopes", "notifications")
	headersWithSufficientScope.Set("X-Oauth-Scopes", "repo, notifications")

	tests := []struct {
		name     string
		err      error
		expected bool
	}{
		{
			name:     "nil error",
			err:      nil,
			expected: false,
		},
		{
			name:     "context canceled",
			err:      context.Canceled,
			expected: false,
		},
		{
			name:     "context deadline exceeded",
			err:      context.DeadlineExceeded,
			expected: false,
		},
		{
			name:     "rate limit string error",
			err:      errors.New("API rate limit exceeded for user"),
			expected: false,
		},
		{
			name: "rate limit HTTP 403 error",
			err: &api.HTTPError{
				StatusCode: http.StatusForbidden,
				Message:    "API rate limit exceeded for user ID 12345",
			},
			expected: false,
		},
		{
			name:     "item not found string error",
			err:      errors.New("Could not resolve to a node with the global id of 'PR_123'"),
			expected: false,
		},
		{
			name: "GraphQL NOT_FOUND error",
			err: &api.GraphQLError{
				Errors: []api.GraphQLErrorItem{
					{
						Type:    "NOT_FOUND",
						Message: "Could not resolve to a node with the global id of 'PR_123'",
					},
				},
			},
			expected: false,
		},
		{
			name: "HTTP 404 Not Found",
			err: &api.HTTPError{
				StatusCode: http.StatusNotFound,
				Message:    "Not Found",
			},
			expected: false,
		},
		{
			name: "HTTP 500 Internal Server Error",
			err: &api.HTTPError{
				StatusCode: http.StatusInternalServerError,
				Message:    "Internal Server Error",
			},
			expected: false,
		},
		{
			name:     "generic network error",
			err:      errors.New("connection reset by peer"),
			expected: false,
		},
		{
			name: "HTTP 403 with sufficient scopes in headers",
			err: &api.HTTPError{
				StatusCode: http.StatusForbidden,
				Headers:    headersWithSufficientScope,
				Message:    "Forbidden",
			},
			expected: false,
		},
		{
			name: "GraphQL FORBIDDEN type error",
			err: &api.GraphQLError{
				Errors: []api.GraphQLErrorItem{
					{
						Type: "FORBIDDEN",
						Message: "Your token has not been granted the required scopes to execute this query. " +
							"The 'notifications' scope is required to access the 'updateSubscription' field.",
					},
				},
			},
			expected: true,
		},
		{
			name: "GraphQL error with notifications scope in message",
			err: &api.GraphQLError{
				Errors: []api.GraphQLErrorItem{
					{
						Type:    "ERROR",
						Message: "The 'notifications' scope is required to access this resource",
					},
				},
			},
			expected: true,
		},
		{
			name: "HTTP 403 with missing notifications in OAuth headers",
			err: &api.HTTPError{
				StatusCode: http.StatusForbidden,
				Headers:    headersWithMissingScope,
				Message:    "Forbidden",
			},
			expected: true,
		},
		{
			name: "HTTP 403 with Resource not accessible by integration",
			err: &api.HTTPError{
				StatusCode: http.StatusForbidden,
				Message:    "Resource not accessible by integration",
			},
			expected: true,
		},
		{
			name: "organization SAML enforcement text error",
			err: errors.New("Resource protected by organization SAML enforcement. " +
				"You must grant your OAuth token access to this organization."),
			expected: true,
		},
		{
			name:     "plain string scope error",
			err:      errors.New("The 'notifications' scope is required to access the 'updateSubscription' field."),
			expected: true,
		},
		{
			name:     "plain string missing required oauth scope",
			err:      errors.New("missing required oauth scope: notifications"),
			expected: true,
		},
		{
			name: "wrapped scope error",
			err: fmt.Errorf("failed to update subscription: %w", &api.GraphQLError{
				Errors: []api.GraphQLErrorItem{
					{
						Type:    "FORBIDDEN",
						Message: "Forbidden access to updateSubscription",
					},
				},
			}),
			expected: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			actual := isGitHubScopeError(tc.err)
			assert.Equal(t, tc.expected, actual, "isGitHubScopeError(%v)", tc.err)
		})
	}
}

func TestOctoDeckHandler_GetSyncStatus_HasNotificationsScope(t *testing.T) {
	t.Run("Reports false when notifications scope is missing", func(t *testing.T) {
		mockGH := &mockGitHubClient{
			authenticated:         true,
			hasNotificationsScope: config.Ptr(false),
		}
		_, client, addHeaders, _ := setupTestHandlerWithGH(t, mockGH)

		req := connect.NewRequest(&octodeckv1.GetSyncStatusRequest{})
		addHeaders(req)
		resp, err := client.GetSyncStatus(t.Context(), req)
		require.NoError(t, err)
		assert.False(t, resp.Msg.GetStatus().GetHasNotificationsScope())
	})

	t.Run("Reports true when notifications scope is present", func(t *testing.T) {
		mockGH := &mockGitHubClient{
			authenticated:         true,
			hasNotificationsScope: config.Ptr(true),
		}
		_, client, addHeaders, _ := setupTestHandlerWithGH(t, mockGH)

		req := connect.NewRequest(&octodeckv1.GetSyncStatusRequest{})
		addHeaders(req)
		resp, err := client.GetSyncStatus(t.Context(), req)
		require.NoError(t, err)
		assert.True(t, resp.Msg.GetStatus().GetHasNotificationsScope())
	})
}

func TestOctoDeckHandler_UpdateConfig_PartialMaskAutoSubscribeQueries(t *testing.T) {
	_, client, addHeaders, _ := setupTestHandler(t)
	query := "repo:kubernetes/kubernetes is:open label:sig/node"

	// First set tracked_queries
	req1 := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
		Config: octodeckv1.Config_builder{
			TrackedQueries: []string{query},
		}.Build(),
		ForceSave: config.Ptr(true),
	}.Build())
	addHeaders(req1)
	resp1, err := client.UpdateConfig(t.Context(), req1)
	require.NoError(t, err)
	assert.Equal(t, []string{query}, resp1.Msg.GetConfig().GetTrackedQueries())

	// Now update ONLY auto_subscribe_queries via FieldMask without resending tracked_queries
	req2 := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
		Config: octodeckv1.Config_builder{
			AutoSubscribeQueries: []string{query},
		}.Build(),
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"auto_subscribe_queries"}},
		ForceSave:  config.Ptr(true),
	}.Build())
	addHeaders(req2)
	resp2, err := client.UpdateConfig(t.Context(), req2)
	require.NoError(t, err)
	assert.Equal(t, []string{query}, resp2.Msg.GetConfig().GetTrackedQueries())
	assert.Equal(t, []string{query}, resp2.Msg.GetConfig().GetAutoSubscribeQueries())
}
