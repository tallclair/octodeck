package logic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/github"
)

// TestChallenger_StatusCalculation_AssignmentInterleaving tests status transitions with assignment events.
func TestChallenger_StatusCalculation_AssignmentInterleaving(t *testing.T) {
	t0 := time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC)
	tAck := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	tEvent := time.Date(2026, 8, 1, 14, 0, 0, 0, time.UTC)
	currentUser := "alice"
	knownBots := []string{"k8s-ci-robot"}

	createItem := func(events []*octodeckv1.StateEvent) *octodeckv1.Item {
		return octodeckv1.Item_builder{
			Id:        config.Ptr("item_1"),
			Repo:      config.Ptr("kubernetes/kubernetes"),
			Number:    config.Ptr(int32(1)),
			Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
			Title:     config.Ptr("Test Assignment Transitions"),
			State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
			UpdatedAt: timestamppb.New(tEvent),
			Local: octodeckv1.ItemLocalState_builder{
				AckedAt:      timestamppb.New(tAck),
				LastViewedAt: timestamppb.New(t0),
			}.Build(),
			StateEvents: events,
		}.Build()
	}

	t.Run("Assigned by other dev after ack -> UN-ACKS to NEW_ACTIVITY", func(t *testing.T) {
		item := createItem([]*octodeckv1.StateEvent{
			octodeckv1.StateEvent_builder{
				Type:      config.Ptr(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED),
				CreatedAt: timestamppb.New(tEvent),
				Actor:     octodeckv1.User_builder{Login: config.Ptr("bob")}.Build(),
			}.Build(),
		})
		res := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, res)
	})

	t.Run("Assigned by self after ack -> stays ACKED", func(t *testing.T) {
		item := createItem([]*octodeckv1.StateEvent{
			octodeckv1.StateEvent_builder{
				Type:      config.Ptr(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED),
				CreatedAt: timestamppb.New(tEvent),
				Actor:     octodeckv1.User_builder{Login: config.Ptr(currentUser)}.Build(),
			}.Build(),
		})
		res := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, res)
	})

	t.Run("Assigned by other dev before ack -> stays ACKED", func(t *testing.T) {
		item := createItem([]*octodeckv1.StateEvent{
			octodeckv1.StateEvent_builder{
				Type:      config.Ptr(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED),
				CreatedAt: timestamppb.New(t0),
				Actor:     octodeckv1.User_builder{Login: config.Ptr("bob")}.Build(),
			}.Build(),
		})
		res := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_ACKED, res)
	})

	t.Run("Multiple assignments by different actors", func(t *testing.T) {
		item := createItem([]*octodeckv1.StateEvent{
			// Old assignment by charlie before ack
			octodeckv1.StateEvent_builder{
				Type:      config.Ptr(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED),
				CreatedAt: timestamppb.New(t0),
				Actor:     octodeckv1.User_builder{Login: config.Ptr("charlie")}.Build(),
			}.Build(),
			// Self-reassignment after ack
			octodeckv1.StateEvent_builder{
				Type:      config.Ptr(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED),
				CreatedAt: timestamppb.New(tEvent.Add(1 * time.Minute)),
				Actor:     octodeckv1.User_builder{Login: config.Ptr(currentUser)}.Build(),
			}.Build(),
			// Reassignment by lead after ack
			octodeckv1.StateEvent_builder{
				Type:      config.Ptr(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED),
				CreatedAt: timestamppb.New(tEvent.Add(2 * time.Minute)),
				Actor:     octodeckv1.User_builder{Login: config.Ptr("lead")}.Build(),
			}.Build(),
		})
		res := CalculateStatus(item, currentUser, knownBots)
		assert.Equal(t, octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY, res)
	})
}

// TestChallenger_ShouldAutoAck_StateEvents verifies ShouldAutoAck with mixed state events.
func TestChallenger_ShouldAutoAck_StateEvents(t *testing.T) {
	t1 := time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 8, 1, 11, 0, 0, 0, time.UTC)
	t3 := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	currentUser := "alice"
	knownBots := []string{"k8s-ci-robot"}

	t.Run("Latest event is self-assignment -> ShouldAutoAck = true", func(t *testing.T) {
		item := octodeckv1.Item_builder{
			Comments: []*octodeckv1.Comment{
				octodeckv1.Comment_builder{
					CreatedAt: timestamppb.New(t1),
					Author:    octodeckv1.User_builder{Login: config.Ptr("bob")}.Build(),
					BodyText:  config.Ptr("Please take a look"),
				}.Build(),
			},
			StateEvents: []*octodeckv1.StateEvent{
				octodeckv1.StateEvent_builder{
					Type:      config.Ptr(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED),
					CreatedAt: timestamppb.New(t2),
					Actor:     octodeckv1.User_builder{Login: config.Ptr(currentUser)}.Build(),
				}.Build(),
			},
		}.Build()

		shouldAck, ackTime := ShouldAutoAck(item, currentUser, knownBots)
		assert.True(t, shouldAck)
		assert.Equal(t, t2, ackTime)
	})

	t.Run("Latest event is assignment by bob -> ShouldAutoAck = false", func(t *testing.T) {
		item := octodeckv1.Item_builder{
			Comments: []*octodeckv1.Comment{
				octodeckv1.Comment_builder{
					CreatedAt: timestamppb.New(t1),
					Author:    octodeckv1.User_builder{Login: config.Ptr(currentUser)}.Build(),
					BodyText:  config.Ptr("I will work on this"),
				}.Build(),
			},
			StateEvents: []*octodeckv1.StateEvent{
				octodeckv1.StateEvent_builder{
					Type:      config.Ptr(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED),
					CreatedAt: timestamppb.New(t2),
					Actor:     octodeckv1.User_builder{Login: config.Ptr("bob")}.Build(),
				}.Build(),
			},
		}.Build()

		shouldAck, _ := ShouldAutoAck(item, currentUser, knownBots)
		assert.False(t, shouldAck)
	})

	t.Run("Latest event is comment by bob after self-assignment -> ShouldAutoAck = false", func(t *testing.T) {
		item := octodeckv1.Item_builder{
			StateEvents: []*octodeckv1.StateEvent{
				octodeckv1.StateEvent_builder{
					Type:      config.Ptr(octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED),
					CreatedAt: timestamppb.New(t2),
					Actor:     octodeckv1.User_builder{Login: config.Ptr(currentUser)}.Build(),
				}.Build(),
			},
			Comments: []*octodeckv1.Comment{
				octodeckv1.Comment_builder{
					CreatedAt: timestamppb.New(t3),
					Author:    octodeckv1.User_builder{Login: config.Ptr("bob")}.Build(),
					BodyText:  config.Ptr("Any updates?"),
				}.Build(),
			},
		}.Build()

		shouldAck, _ := ShouldAutoAck(item, currentUser, knownBots)
		assert.False(t, shouldAck)
	})
}

// TestChallenger_GapDetection_EdgeCases tests exact boundary conditions for detectGap.
func TestChallenger_GapDetection_EdgeCases(t *testing.T) {
	makeComments := func(ids ...int64) []*octodeckv1.Comment {
		var res []*octodeckv1.Comment
		for _, id := range ids {
			res = append(res, octodeckv1.Comment_builder{
				CommentId: config.Ptr(id),
				CreatedAt: timestamppb.New(time.Now()),
				BodyText:  config.Ptr("test"),
			}.Build())
		}
		return res
	}

	// 1. Fetched < 20 (e.g. 19 comments) -> false even if gap in IDs
	var fetched19 []*octodeckv1.Comment
	for i := int64(100); i < 119; i++ {
		fetched19 = append(fetched19, makeComments(i)...)
	}
	existing := makeComments(1, 2, 3)
	assert.False(t, detectGap(existing, fetched19), "Fewer than 20 fetched comments must not trigger gap")

	// 2. Existing empty -> false
	var fetched20 []*octodeckv1.Comment
	for i := int64(100); i < 120; i++ {
		fetched20 = append(fetched20, makeComments(i)...)
	}
	assert.False(t, detectGap(nil, fetched20), "Empty existing must not trigger gap")
	assert.False(t, detectGap([]*octodeckv1.Comment{}, fetched20), "Empty existing must not trigger gap")

	// 3. Exactly 20 fetched, oldest fetched ID = 100, newest existing ID = 50 -> true (gap!)
	assert.True(t, detectGap(existing, fetched20), "Oldest fetched ID (100) > newest existing (3) must trigger gap")

	// 4. Overlap: newest existing = 100, oldest fetched = 100 -> false (connected)
	existingOverlapping := makeComments(1, 50, 100)
	assert.False(t, detectGap(existingOverlapping, fetched20), "Overlap at ID 100 must not trigger gap")

	// 5. Overlap: newest existing = 105, oldest fetched = 100 -> false (connected)
	existingGreater := makeComments(1, 50, 105)
	assert.False(t, detectGap(existingGreater, fetched20), "Oldest fetched < newest existing must not trigger gap")
}

// TestChallenger_MergeComments_DeduplicationAndSorting tests sorting and deduplication of comments.
func TestChallenger_MergeComments_DeduplicationAndSorting(t *testing.T) {
	makeComment := func(id int64, text string) *octodeckv1.Comment {
		return octodeckv1.Comment_builder{
			CommentId: config.Ptr(id),
			BodyText:  config.Ptr(text),
		}.Build()
	}

	// Existing: 1, 3, 5
	existing := []*octodeckv1.Comment{
		makeComment(1, "c1"),
		makeComment(5, "c5"),
		makeComment(3, "c3"), // unsorted input to test internal sort
	}

	// Fetched: 3, 5, 7, 9
	fetched := []*octodeckv1.Comment{
		makeComment(9, "c9"),
		makeComment(3, "c3_new"),
		makeComment(7, "c7"),
		makeComment(5, "c5_new"),
	}

	merged := mergeComments(existing, fetched)
	require.Len(t, merged, 5) // 1, 3, 5, 7, 9
	assert.Equal(t, int64(1), merged[0].GetCommentId())
	assert.Equal(t, int64(3), merged[1].GetCommentId())
	assert.Equal(t, int64(5), merged[2].GetCommentId())
	assert.Equal(t, int64(7), merged[3].GetCommentId())
	assert.Equal(t, int64(9), merged[4].GetCommentId())
}

// TestChallenger_GapResolution_FetchErrorFallback tests fallback when FetchItemComments errors.
func TestChallenger_GapResolution_FetchErrorFallback(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	existingItem := octodeckv1.Item_builder{
		Id:     config.Ptr("item_gap_err"),
		Repo:   config.Ptr("owner/repo"),
		Number: config.Ptr(int32(1)),
		Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:  config.Ptr("Gap Fallback Issue"),
		State:  config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		Comments: []*octodeckv1.Comment{
			octodeckv1.Comment_builder{
				CommentId: config.Ptr(int64(1)),
				BodyText:  config.Ptr("c1"),
			}.Build(),
		},
	}.Build()
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{existingItem}))

	// 20 fetched comments starting at 50 (gap)
	var fetchedComments []*octodeckv1.Comment
	for i := int64(50); i < 70; i++ {
		fetchedComments = append(fetchedComments, octodeckv1.Comment_builder{
			CommentId: config.Ptr(i),
			BodyText:  config.Ptr(fmt.Sprintf("c%d", i)),
		}.Build())
	}

	fetchedItem := octodeckv1.Item_builder{
		Id:       config.Ptr("item_gap_err"),
		Repo:     config.Ptr("owner/repo"),
		Number:   config.Ptr(int32(1)),
		Type:     config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:    config.Ptr("Gap Fallback Issue Updated"),
		State:    config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		Comments: fetchedComments,
	}.Build()

	// Mock GraphQL client returning an error on FetchItemComments
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, _ any, _ map[string]any) error {
			if name == "FetchItemComments" {
				return errors.New("github rate limit exceeded")
			}
			return nil
		},
	}

	ghClient := &github.Client{GraphQLClient: mockGQL}
	engine := NewSyncEngine(db, ghClient, config.NewForTest(octodeckv1.Config_builder{}.Build()))

	// Should not fail; should fall back to best-effort merge
	err := engine.processItems(t.Context(), []*octodeckv1.Item{fetchedItem})
	require.NoError(t, err)

	saved, err := db.GetItem(t.Context(), "item_gap_err")
	require.NoError(t, err)
	// 1 existing + 20 fetched = 21 comments preserved
	assert.Len(t, saved.GetComments(), 21)
	assert.Equal(t, int64(1), saved.GetComments()[0].GetCommentId())
	assert.Equal(t, int64(69), saved.GetComments()[20].GetCommentId())
}

// TestChallenger_Backfill_PreservesLocalStateAndTracksPoisonPills tests preservation of user notes/stars.
func TestChallenger_Backfill_PreservesLocalStateAndTracksPoisonPills(t *testing.T) {
	db := setupTestDB(t)
	defer func() { require.NoError(t, db.Close()) }()

	tAck := time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC)
	// Item with local notes and starred
	poisonItem := octodeckv1.Item_builder{
		Id:     config.Ptr("poison_item_1"),
		Repo:   config.Ptr("org/repo"),
		Number: config.Ptr(int32(10)),
		Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:  config.Ptr("Deleted PR"),
		State:  config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		Local: octodeckv1.ItemLocalState_builder{
			AckedAt:      timestamppb.New(tAck),
			PrivateNotes: config.Ptr("Important PR note"),
			Starred:      config.Ptr(true),
		}.Build(),
	}.Build()

	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{poisonItem}))

	// GraphQL returns missing (nil node)
	mockGQL := &mockGraphQLClient{
		queryFunc: func(_ context.Context, name string, q any, _ map[string]any) error {
			if name == "ItemsFetch" {
				data := map[string]any{"nodes": []any{nil}}
				b, _ := json.Marshal(data)
				return json.Unmarshal(b, q)
			}
			return nil
		},
	}

	mockREST := &mockRESTClient{
		doFunc: func(_ context.Context, _, path string, _ io.Reader, response any) error {
			if path == "user" {
				return json.Unmarshal([]byte(`{"login":"testuser"}`), response)
			}
			return nil
		},
	}

	ghClient := &github.Client{RestClient: mockREST, GraphQLClient: mockGQL}
	engine := NewSyncEngine(db, ghClient, config.NewForTest(octodeckv1.Config_builder{}.Build()))

	count, err := engine.BackfillItems(t.Context())
	require.NoError(t, err)
	assert.Equal(t, 0, count)

	// Verify local state was preserved AND sync_error was attached
	itemAfterBackfill, err := db.GetItem(t.Context(), "poison_item_1")
	require.NoError(t, err)
	assert.Equal(t, "Important PR note", itemAfterBackfill.GetLocal().GetPrivateNotes())
	assert.True(t, itemAfterBackfill.GetLocal().GetStarred())
	assert.Contains(t, itemAfterBackfill.GetLocal().GetSyncError(), "404")
}
