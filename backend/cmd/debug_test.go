package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/github"
	"github.com/tallclair/octodeck/backend/internal/logic"
)

type mockItemsFetcher struct {
	fetchItemsFunc func(ctx context.Context, items []*octodeckv1.Item) ([]*octodeckv1.Item, []string, error)
}

func (m *mockItemsFetcher) FetchItems(
	ctx context.Context,
	items []*octodeckv1.Item,
) ([]*octodeckv1.Item, []string, error) {
	return m.fetchItemsFunc(ctx, items)
}

func TestBackfillDescriptions(t *testing.T) {
	ctx := t.Context()
	db, err := database.Init(ctx, database.InMemoryDSN)
	require.NoError(t, err)
	defer db.Close()

	// Seed items
	item1 := octodeckv1.Item_builder{
		Id:     config.Ptr("item_1"),
		Repo:   config.Ptr("org/repo"),
		Number: config.Ptr(int32(1)),
		Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:  config.Ptr("PR 1"),
		Body:   config.Ptr(""),
		State:  config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		Local: octodeckv1.ItemLocalState_builder{
			AckedAt:      timestamppb.New(time.Now()),
			PrivateNotes: config.Ptr("My private note"),
		}.Build(),
	}.Build()

	item2 := octodeckv1.Item_builder{
		Id:     config.Ptr("item_2"),
		Repo:   config.Ptr("org/repo"),
		Number: config.Ptr(int32(2)),
		Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:  config.Ptr("Issue 2"),
		Body:   config.Ptr("Already has description"),
		State:  config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
	}.Build()

	err = db.SaveItems(ctx, []*octodeckv1.Item{item1, item2})
	require.NoError(t, err)

	fetchCalls := 0
	mockFetcher := &mockItemsFetcher{
		fetchItemsFunc: func(_ context.Context, items []*octodeckv1.Item) ([]*octodeckv1.Item, []string, error) {
			fetchCalls++
			require.Len(t, items, 1)
			assert.Equal(t, "item_1", items[0].GetId())

			fetched1 := octodeckv1.Item_builder{
				Id:   config.Ptr("item_1"),
				Body: config.Ptr("Fetched description for PR 1"),
			}.Build()

			return []*octodeckv1.Item{fetched1}, nil, nil
		},
	}

	// 1. Dry run
	count, err := backfillDescriptions(ctx, db, mockFetcher, false, true)
	require.NoError(t, err)
	assert.Equal(t, 1, count)
	assert.Equal(t, 1, fetchCalls)

	// Verify not saved during dry run
	savedItem1, err := db.GetItem(ctx, "item_1")
	require.NoError(t, err)
	assert.Empty(t, savedItem1.GetBody())

	// 2. Real backfill
	count, err = backfillDescriptions(ctx, db, mockFetcher, false, false)
	require.NoError(t, err)
	assert.Equal(t, 1, count)

	// Verify saved and local state preserved
	savedItem1, err = db.GetItem(ctx, "item_1")
	require.NoError(t, err)
	assert.Equal(t, "Fetched description for PR 1", savedItem1.GetBody())
	assert.NotNil(t, savedItem1.GetLocal().GetAckedAt())
	assert.Equal(t, "My private note", savedItem1.GetLocal().GetPrivateNotes())

	// 3. No backfill needed now
	count, err = backfillDescriptions(ctx, db, mockFetcher, false, false)
	require.NoError(t, err)
	assert.Equal(t, 0, count)
}

func TestBackfillItems(t *testing.T) {
	ctx := t.Context()
	db, err := database.Init(ctx, database.InMemoryDSN)
	require.NoError(t, err)
	defer db.Close()

	// Seed items
	item1 := octodeckv1.Item_builder{
		Id:     config.Ptr("item_1"),
		Repo:   config.Ptr("org/repo"),
		Number: config.Ptr(int32(1)),
		Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:  config.Ptr("PR 1"),
		State:  config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		Local: octodeckv1.ItemLocalState_builder{
			AckedAt:      timestamppb.New(time.Now()),
			PrivateNotes: config.Ptr("My private note"),
			Starred:      config.Ptr(true),
		}.Build(),
	}.Build()

	item2 := octodeckv1.Item_builder{
		Id:     config.Ptr("item_2"),
		Repo:   config.Ptr("org/repo"),
		Number: config.Ptr(int32(2)),
		Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:  config.Ptr("Issue 2"),
		State:  config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
	}.Build()

	err = db.SaveItems(ctx, []*octodeckv1.Item{item1, item2})
	require.NoError(t, err)

	fetchCalls := 0
	mockFetcher := &mockItemsFetcher{
		fetchItemsFunc: func(_ context.Context, items []*octodeckv1.Item) ([]*octodeckv1.Item, []string, error) {
			fetchCalls++
			require.Len(t, items, 2)

			fetched1 := octodeckv1.Item_builder{
				Id:        config.Ptr("item_1"),
				Repo:      config.Ptr("org/repo"),
				Number:    config.Ptr(int32(1)),
				Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
				Title:     config.Ptr("PR 1 with full details"),
				Milestone: octodeckv1.Milestone_builder{Title: config.Ptr("v1.0")}.Build(),
				Labels: []*octodeckv1.Label{
					octodeckv1.Label_builder{Name: config.Ptr("kind/bug"), Color: config.Ptr("d73a4a")}.Build(),
				},
			}.Build()

			fetched2 := octodeckv1.Item_builder{
				Id:     config.Ptr("item_2"),
				Repo:   config.Ptr("org/repo"),
				Number: config.Ptr(int32(2)),
				Type:   config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
				Title:  config.Ptr("Issue 2 with full details"),
				Labels: []*octodeckv1.Label{
					octodeckv1.Label_builder{Name: config.Ptr("size/small"), Color: config.Ptr("0075ca")}.Build(),
				},
			}.Build()

			return []*octodeckv1.Item{fetched1, fetched2}, nil, nil
		},
	}

	// 1. Dry run
	count, err := backfillItems(ctx, db, mockFetcher, true)
	require.NoError(t, err)
	assert.Equal(t, 2, count)
	assert.Equal(t, 1, fetchCalls)

	// Verify not saved during dry run
	savedItem1, err := db.GetItem(ctx, "item_1")
	require.NoError(t, err)
	assert.Equal(t, "PR 1", savedItem1.GetTitle())
	assert.Nil(t, savedItem1.GetMilestone())

	// 2. Real backfill
	count, err = backfillItems(ctx, db, mockFetcher, false)
	require.NoError(t, err)
	assert.Equal(t, 2, count)

	// Verify saved and local state preserved
	savedItem1, err = db.GetItem(ctx, "item_1")
	require.NoError(t, err)
	assert.Equal(t, "PR 1 with full details", savedItem1.GetTitle())
	require.NotNil(t, savedItem1.GetMilestone())
	assert.Equal(t, "v1.0", savedItem1.GetMilestone().GetTitle())
	require.Len(t, savedItem1.GetLabels(), 1)
	assert.Equal(t, "kind/bug", savedItem1.GetLabels()[0].GetName())
	assert.NotNil(t, savedItem1.GetLocal().GetAckedAt())
	assert.Equal(t, "My private note", savedItem1.GetLocal().GetPrivateNotes())
	assert.True(t, savedItem1.GetLocal().GetStarred())

	savedItem2, err := db.GetItem(ctx, "item_2")
	require.NoError(t, err)
	assert.Equal(t, "Issue 2 with full details", savedItem2.GetTitle())
	require.Len(t, savedItem2.GetLabels(), 1)
	assert.Equal(t, "size/small", savedItem2.GetLabels()[0].GetName())
}

func TestDebugTracesCmd(t *testing.T) {
	tmpDir := t.TempDir()
	testDBPath := filepath.Join(tmpDir, "debug_test.db")
	ctx := t.Context()

	db, err := database.Init(ctx, testDBPath)
	require.NoError(t, err)
	defer db.Close()

	payload := []byte(`{"response": "ok"}`)
	compressed, err := database.CompressPayload(payload)
	require.NoError(t, err)

	trace := &database.SyncTrace{
		ID:                   "test-trace-123",
		TraceType:            "heartbeat",
		TriggerSource:        "ticker",
		QueryString:          "repo:k8s/k8s updated:>2026-08-13T00:00:00Z",
		DurationMs:           250,
		PagesCount:           1,
		ItemsFetched:         3,
		ItemsPersisted:       3,
		RawPayloadCompressed: compressed,
		CreatedAt:            time.Now().UTC().Format(time.RFC3339),
	}
	require.NoError(t, db.SaveSyncTrace(ctx, trace))

	// Test traces command
	cmd := rootCmd
	cmd.SetArgs([]string{"debug", "traces", "--db-path", testDBPath})
	err = cmd.ExecuteContext(ctx)
	require.NoError(t, err)

	// Test traces command with JSON
	cmd.SetArgs([]string{"debug", "traces", "--db-path", testDBPath, "--json"})
	err = cmd.ExecuteContext(ctx)
	require.NoError(t, err)

	// Test trace command
	cmd.SetArgs([]string{"debug", "trace", "test-trace-123", "--db-path", testDBPath, "--payload"})
	err = cmd.ExecuteContext(ctx)
	require.NoError(t, err)

	// Test trace command with JSON
	cmd.SetArgs([]string{"debug", "trace", "test-trace-123", "--db-path", testDBPath, "--json"})
	err = cmd.ExecuteContext(ctx)
	require.NoError(t, err)
}

func TestDebugTraces_NotificationSyncFormatting(t *testing.T) {
	ctx := t.Context()
	db, err := database.Init(ctx, database.InMemoryDSN)
	require.NoError(t, err)
	defer db.Close()

	// 1. 304 trace
	payload304 := logic.NotificationSyncPayload{
		HTTPStatus:          304,
		LastModified:        "Thu, 14 Aug 2026 01:54:16 GMT",
		NotificationsCount:  0,
		FilteredByRepoCount: 0,
	}
	payload304Bytes, err := json.Marshal(payload304)
	require.NoError(t, err)
	compressed304, err := database.CompressPayload(payload304Bytes)
	require.NoError(t, err)

	trace304 := &database.SyncTrace{
		ID:                   "trace-304-notif",
		TraceType:            "notification_sync",
		TriggerSource:        "ticker",
		DurationMs:           45,
		ItemsFetched:         0,
		ItemsPersisted:       0,
		RawPayloadCompressed: compressed304,
		CreatedAt:            time.Now().UTC().Format(time.RFC3339),
	}
	require.NoError(t, db.SaveSyncTrace(ctx, trace304))

	// 2. 200 trace
	payload200 := logic.NotificationSyncPayload{
		HTTPStatus:          200,
		LastModified:        "Thu, 14 Aug 2026 02:00:00 GMT",
		NotificationsCount:  3,
		ReasonsBreakdown:    map[string]int{"assign": 2, "mention": 1},
		UnsupportedTypes:    map[string]int{"Release": 1},
		FilteredByRepoCount: 1,
		HydratedItems:       []string{"PR_kwDOAToIks7zPyIm", "PR_kwDOAToIks7M9qL1"},
	}
	payload200Bytes, err := json.Marshal(payload200)
	require.NoError(t, err)
	compressed200, err := database.CompressPayload(payload200Bytes)
	require.NoError(t, err)

	trace200 := &database.SyncTrace{
		ID:                   "trace-200-notif",
		TraceType:            "notification_sync",
		TriggerSource:        "manual",
		DurationMs:           180,
		ItemsFetched:         2,
		ItemsPersisted:       2,
		RawPayloadCompressed: compressed200,
		CreatedAt:            time.Now().UTC().Format(time.RFC3339),
	}
	require.NoError(t, db.SaveSyncTrace(ctx, trace200))

	// Test text table formatting
	var buf bytes.Buffer
	err = runDebugTraces(ctx, db, 10, "", false, &buf)
	require.NoError(t, err)
	textOut := buf.String()
	assert.Contains(t, textOut, "TRACE ID")
	assert.Contains(t, textOut, "trace-304-notif")
	assert.Contains(t, textOut, "304 Not Modified")
	assert.Contains(t, textOut, "trace-200-notif")
	assert.Contains(t, textOut, "200 OK (3 notifs)")

	// Test JSON output
	buf.Reset()
	err = runDebugTraces(ctx, db, 10, "notification_sync", true, &buf)
	require.NoError(t, err)
	assert.Contains(t, buf.String(), `"trace-304-notif"`)
	assert.Contains(t, buf.String(), `"trace-200-notif"`)
}

func TestDebugTrace_NotificationSyncFormatting(t *testing.T) {
	ctx := t.Context()
	db, err := database.Init(ctx, database.InMemoryDSN)
	require.NoError(t, err)
	defer db.Close()

	payload := logic.NotificationSyncPayload{
		HTTPStatus:          200,
		LastModified:        "Thu, 14 Aug 2026 01:54:16 GMT",
		NotificationsCount:  4,
		ReasonsBreakdown:    map[string]int{"assign": 2, "mention": 1, "author": 1},
		UnsupportedTypes:    map[string]int{"Release": 1},
		FilteredByRepoCount: 1,
		HydratedItems:       []string{"PR_kwDOAToIks7zPyIm", "PR_kwDOAToIks7M9qL1"},
		HydrationErrors:     map[string]string{"PR_err_1": "item deleted or 404"},
	}
	payloadBytes, err := json.Marshal(payload)
	require.NoError(t, err)
	compressed, err := database.CompressPayload(payloadBytes)
	require.NoError(t, err)

	trace := &database.SyncTrace{
		ID:                   "trace-notif-detail",
		TraceType:            "notification_sync",
		TriggerSource:        "ticker",
		DurationMs:           210,
		ItemsFetched:         2,
		ItemsPersisted:       2,
		RawPayloadCompressed: compressed,
		CreatedAt:            time.Now().UTC().Format(time.RFC3339),
	}
	require.NoError(t, db.SaveSyncTrace(ctx, trace))

	// 1. Text format without payload
	var buf bytes.Buffer
	err = runDebugTrace(ctx, db, "trace-notif-detail", false, false, &buf)
	require.NoError(t, err)
	textOut := buf.String()
	assert.Contains(t, textOut, "ID:             trace-notif-detail")
	assert.Contains(t, textOut, "Type:           notification_sync")
	assert.Contains(t, textOut, "HTTP Status:    200")
	assert.Contains(t, textOut, "Last-Modified:  Thu, 14 Aug 2026 01:54:16 GMT")
	assert.Contains(t, textOut, "Notifications:  4")
	assert.Contains(t, textOut, "Filtered Repos: 1")
	assert.Contains(t, textOut, "assign: 2")
	assert.Contains(t, textOut, "mention: 1")
	assert.Contains(t, textOut, "Release: 1")
	assert.Contains(t, textOut, "Hydrated Items: 2")
	assert.Contains(t, textOut, "PR_kwDOAToIks7zPyIm")
	assert.Contains(t, textOut, "PR_kwDOAToIks7M9qL1")
	assert.Contains(t, textOut, "PR_err_1: item deleted or 404")
	assert.NotContains(t, textOut, "--- Raw Payload ---")

	// 2. Text format with --payload
	buf.Reset()
	err = runDebugTrace(ctx, db, "trace-notif-detail", false, true, &buf)
	require.NoError(t, err)
	payloadOut := buf.String()
	assert.Contains(t, payloadOut, "--- Raw Payload ---")
	assert.Contains(t, payloadOut, `"http_status": 200`)
	assert.Contains(t, payloadOut, `"notifications_count": 4`)

	// 3. JSON format
	buf.Reset()
	err = runDebugTrace(ctx, db, "trace-notif-detail", true, false, &buf)
	require.NoError(t, err)
	assert.Contains(t, buf.String(), `"id": "trace-notif-detail"`)

	// 4. JSON format with payload
	buf.Reset()
	err = runDebugTrace(ctx, db, "trace-notif-detail", true, true, &buf)
	require.NoError(t, err)
	assert.Contains(t, buf.String(), `"http_status": 200`)
}

type mockNotificationsFetcher struct {
	fetchFunc func(
		ctx context.Context,
		since time.Time,
		lastModified string,
	) ([]github.NotificationThread, string, int, error)
}

func (m *mockNotificationsFetcher) FetchNotifications(
	ctx context.Context,
	since time.Time,
	lastModified string,
) ([]github.NotificationThread, string, int, error) {
	return m.fetchFunc(ctx, since, lastModified)
}

func TestParseSince(t *testing.T) {
	// Empty
	tEmpty, err := parseSince("")
	require.NoError(t, err)
	assert.True(t, tEmpty.IsZero())

	// Duration
	tDur, err := parseSince("24h")
	require.NoError(t, err)
	assert.WithinDuration(t, time.Now().Add(-24*time.Hour), tDur, 5*time.Second)

	// RFC3339
	tRFC, err := parseSince("2026-08-14T01:54:16Z")
	require.NoError(t, err)
	assert.Equal(t, 2026, tRFC.Year())
	assert.Equal(t, time.August, tRFC.Month())
	assert.Equal(t, 14, tRFC.Day())

	// Date only
	tDate, err := parseSince("2026-08-14")
	require.NoError(t, err)
	assert.Equal(t, 2026, tDate.Year())
	assert.Equal(t, 14, tDate.Day())

	// Invalid
	_, err = parseSince("invalid-time-format")
	require.Error(t, err)
}

func TestDebugNotifications_Formatting(t *testing.T) {
	ctx := t.Context()
	threads := []github.NotificationThread{
		{
			ID:     "12345",
			Unread: true,
			Reason: "mention",
			Subject: github.NotificationSubject{
				Title: "Test PR title",
				Type:  "PullRequest",
				URL:   "https://api.github.com/repos/kubernetes/kubernetes/pulls/100",
			},
			Repository: github.NotificationRepo{
				FullName: "kubernetes/kubernetes",
			},
		},
		{
			ID:     "67890",
			Unread: false,
			Reason: "assign",
			Subject: github.NotificationSubject{
				Title: "Very long issue title that should be truncated when printed " +
					"in table format to keep columns neat",
				Type: "Issue",
				URL:  "https://api.github.com/repos/kubernetes/kubernetes/issues/200",
			},
			Repository: github.NotificationRepo{
				FullName: "kubernetes/kubernetes",
			},
		},
	}

	fetcher := &mockNotificationsFetcher{
		fetchFunc: func(_ context.Context, _ time.Time, _ string) ([]github.NotificationThread, string, int, error) {
			return threads, "Thu, 14 Aug 2026 01:54:16 GMT", 200, nil
		},
	}

	// 1. Text format
	var buf bytes.Buffer
	err := runDebugNotifications(ctx, fetcher, "24h", "", false, &buf)
	require.NoError(t, err)
	textOutput := buf.String()
	assert.Contains(t, textOutput, "HTTP Status:   200")
	assert.Contains(t, textOutput, "Last-Modified: Thu, 14 Aug 2026 01:54:16 GMT")
	assert.Contains(t, textOutput, "Count:         2")
	assert.Contains(t, textOutput, "12345")
	assert.Contains(t, textOutput, "kubernetes/kubernetes")
	assert.Contains(t, textOutput, "Test PR title")
	assert.Contains(t, textOutput, "67890")

	// 2. JSON format
	buf.Reset()
	err = runDebugNotifications(ctx, fetcher, "", "Thu, 14 Aug 2026 01:54:16 GMT", true, &buf)
	require.NoError(t, err)
	jsonOutput := buf.String()
	assert.Contains(t, jsonOutput, `"http_status": 200`)
	assert.Contains(t, jsonOutput, `"count": 2`)
	assert.Contains(t, jsonOutput, `"12345"`)

	// 3. 304 Not Modified
	fetcher304 := &mockNotificationsFetcher{
		fetchFunc: func(_ context.Context, _ time.Time, _ string) ([]github.NotificationThread, string, int, error) {
			return nil, "Thu, 14 Aug 2026 01:54:16 GMT", 304, nil
		},
	}
	buf.Reset()
	err = runDebugNotifications(ctx, fetcher304, "", "Thu, 14 Aug 2026 01:54:16 GMT", false, &buf)
	require.NoError(t, err)
	assert.Contains(t, buf.String(), "304 Not Modified")

	// 4. Error response
	fetcherErr := &mockNotificationsFetcher{
		fetchFunc: func(_ context.Context, _ time.Time, _ string) ([]github.NotificationThread, string, int, error) {
			return nil, "", 500, errors.New("github internal server error")
		},
	}
	buf.Reset()
	err = runDebugNotifications(ctx, fetcherErr, "", "", false, &buf)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "github internal server error")
}

type mockNodeIDResolver struct {
	resolveFunc func(ctx context.Context, targets []github.ItemTarget) (map[github.ItemTarget]string, error)
}

func (m *mockNodeIDResolver) ResolveNodeIDs(
	ctx context.Context,
	targets []github.ItemTarget,
) (map[github.ItemTarget]string, error) {
	return m.resolveFunc(ctx, targets)
}

func TestDebugResolveIDs_Formatting(t *testing.T) {
	ctx := t.Context()
	mockResolver := &mockNodeIDResolver{
		resolveFunc: func(_ context.Context, targets []github.ItemTarget) (map[github.ItemTarget]string, error) {
			result := make(map[github.ItemTarget]string)
			for _, target := range targets {
				if target.Number == 123 {
					result[target] = "PR_node_123"
				}
				// 456 is missing / not in map
			}
			return result, nil
		},
	}

	// 1. Text format
	var buf bytes.Buffer
	targets := []string{"kubernetes/kubernetes#123", "kubernetes/kubernetes#456"}
	err := runDebugResolveIDs(ctx, mockResolver, targets, false, &buf)
	require.NoError(t, err)
	textOut := buf.String()
	assert.Contains(t, textOut, "TARGET")
	assert.Contains(t, textOut, "NODE ID")
	assert.Contains(t, textOut, "kubernetes/kubernetes#123")
	assert.Contains(t, textOut, "PR_node_123")
	assert.Contains(t, textOut, "kubernetes/kubernetes#456")
	assert.Contains(t, textOut, "<not found>")

	// 2. JSON format
	buf.Reset()
	err = runDebugResolveIDs(ctx, mockResolver, targets, true, &buf)
	require.NoError(t, err)
	jsonOut := buf.String()
	assert.Contains(t, jsonOut, `"kubernetes/kubernetes#123": "PR_node_123"`)
	assert.Contains(t, jsonOut, `"kubernetes/kubernetes#456": null`)

	// 3. Invalid target
	buf.Reset()
	err = runDebugResolveIDs(ctx, mockResolver, []string{"invalid-target"}, false, &buf)
	require.Error(t, err)

	// 4. Empty targets
	buf.Reset()
	err = runDebugResolveIDs(ctx, mockResolver, nil, false, &buf)
	require.Error(t, err)
}

type mockHydrator struct {
	hydrateFunc func(ctx context.Context, ids []string) ([]*octodeckv1.Item, []string, error)
}

func (m *mockHydrator) FetchItemsByIDs(
	ctx context.Context,
	ids []string,
) ([]*octodeckv1.Item, []string, error) {
	return m.hydrateFunc(ctx, ids)
}

func TestDebugHydrateItems_Formatting(t *testing.T) {
	ctx := t.Context()
	item1 := octodeckv1.Item_builder{
		Id:                 config.Ptr("PR_node_123"),
		Repo:               config.Ptr("kubernetes/kubernetes"),
		Number:             config.Ptr(int32(123)),
		Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:              config.Ptr("Fix memory leak"),
		ViewerSubscription: config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED),
	}.Build()

	mockHydrator := &mockHydrator{
		hydrateFunc: func(_ context.Context, ids []string) ([]*octodeckv1.Item, []string, error) {
			var found []*octodeckv1.Item
			var missing []string
			for _, id := range ids {
				if id == "PR_node_123" {
					found = append(found, item1)
				} else {
					missing = append(missing, id)
				}
			}
			return found, missing, nil
		},
	}

	// 1. Text format
	var buf bytes.Buffer
	err := runDebugHydrateItems(ctx, mockHydrator, []string{"PR_node_123", "PR_missing_456"}, false, &buf)
	require.NoError(t, err)
	textOut := buf.String()
	assert.Contains(t, textOut, "PR_node_123")
	assert.Contains(t, textOut, "PR")
	assert.Contains(t, textOut, "kubernetes/kubernetes")
	assert.Contains(t, textOut, "123")
	assert.Contains(t, textOut, "SUBSCRIPTION_STATE_SUBSCRIBED")
	assert.Contains(t, textOut, "Fix memory leak")
	assert.Contains(t, textOut, "Missing / Not Found IDs (1):")
	assert.Contains(t, textOut, "PR_missing_456")

	// 2. JSON format
	buf.Reset()
	err = runDebugHydrateItems(ctx, mockHydrator, []string{"PR_node_123", "PR_missing_456"}, true, &buf)
	require.NoError(t, err)
	jsonOut := buf.String()
	assert.Contains(t, jsonOut, `"PR_node_123"`)
	assert.Contains(t, jsonOut, `"Fix memory leak"`)
	assert.Contains(t, jsonOut, `"PR_missing_456"`)
	assert.Contains(t, jsonOut, `"items": [`)
	assert.Contains(t, jsonOut, `"missing": [`)

	// 3. Empty IDs
	buf.Reset()
	err = runDebugHydrateItems(ctx, mockHydrator, nil, false, &buf)
	require.Error(t, err)
}

type mockSyncEngineRunner struct {
	runIncFunc func(ctx context.Context) error
	forceFunc  func(ctx context.Context) error
}

func (m *mockSyncEngineRunner) RunIncrementalSync(ctx context.Context) error {
	if m.runIncFunc != nil {
		return m.runIncFunc(ctx)
	}
	return nil
}

func (m *mockSyncEngineRunner) ForceSync(ctx context.Context) error {
	if m.forceFunc != nil {
		return m.forceFunc(ctx)
	}
	return nil
}

func TestDebugSyncNotifications_Formatting(t *testing.T) {
	ctx := t.Context()
	db, err := database.Init(ctx, database.InMemoryDSN)
	require.NoError(t, err)
	defer db.Close()

	payload := logic.NotificationSyncPayload{
		HTTPStatus:          200,
		LastModified:        "Thu, 14 Aug 2026 01:54:16 GMT",
		NotificationsCount:  3,
		ReasonsBreakdown:    map[string]int{"assign": 2, "mention": 1},
		UnsupportedTypes:    map[string]int{"Release": 1},
		FilteredByRepoCount: 1,
		HydratedItems:       []string{"PR_123"},
		HydrationErrors:     map[string]string{"PR_404": "Item not found"},
	}
	payloadJSON, err := json.Marshal(payload)
	require.NoError(t, err)
	compressed, err := database.CompressPayload(payloadJSON)
	require.NoError(t, err)

	trace := &database.SyncTrace{
		ID:                   "notif-trace-1",
		TraceType:            "notification_sync",
		TriggerSource:        "ticker",
		DurationMs:           150,
		ItemsFetched:         1,
		ItemsPersisted:       1,
		RawPayloadCompressed: compressed,
		CreatedAt:            time.Now().UTC().Format(time.RFC3339),
	}
	require.NoError(t, db.SaveSyncTrace(ctx, trace))

	incCalls := 0
	forceCalls := 0
	mockEngine := &mockSyncEngineRunner{
		runIncFunc: func(_ context.Context) error {
			incCalls++
			return nil
		},
		forceFunc: func(_ context.Context) error {
			forceCalls++
			return nil
		},
	}

	// 1. Text format
	var buf bytes.Buffer
	err = runDebugSyncNotifications(ctx, db, mockEngine, false, false, &buf)
	require.NoError(t, err)
	assert.Equal(t, 1, incCalls)
	assert.Equal(t, 0, forceCalls)
	textOut := buf.String()
	assert.Contains(t, textOut, "notif-trace-1")
	assert.Contains(t, textOut, "HTTP Status:    200")
	assert.Contains(t, textOut, "Last-Modified:  Thu, 14 Aug 2026 01:54:16 GMT")
	assert.Contains(t, textOut, "Notifications:  3")
	assert.Contains(t, textOut, "Filtered Repos: 1")
	assert.Contains(t, textOut, "assign: 2")
	assert.Contains(t, textOut, "Release: 1")
	assert.Contains(t, textOut, "Hydrated Items: 1")
	assert.Contains(t, textOut, "PR_404: Item not found")

	// 2. JSON format
	buf.Reset()
	err = runDebugSyncNotifications(ctx, db, mockEngine, false, true, &buf)
	require.NoError(t, err)
	jsonOut := buf.String()
	assert.Contains(t, jsonOut, `"http_status": 200`)
	assert.Contains(t, jsonOut, `"notifications_count": 3`)
	assert.Contains(t, jsonOut, `"PR_123"`)

	// 3. Force mode
	buf.Reset()
	err = runDebugSyncNotifications(ctx, db, mockEngine, true, false, &buf)
	require.NoError(t, err)
	assert.Equal(t, 1, forceCalls)

	// 4. Sync error propagation
	errEngine := &mockSyncEngineRunner{
		runIncFunc: func(_ context.Context) error {
			return errors.New("github connection timed out")
		},
	}
	buf.Reset()
	err = runDebugSyncNotifications(ctx, db, errEngine, false, false, &buf)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "github connection timed out")
}
