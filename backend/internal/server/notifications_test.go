package server

import (
	"fmt"
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
	"github.com/tallclair/octodeck/backend/internal/notify"
)

type notificationTestEnv struct {
	db          *database.DB
	client      octodeckv1connect.OctoDeckServiceClient
	addHeaders  func(connect.AnyRequest)
	broadcaster *notify.Broadcaster
}

func setupNotificationTest(t *testing.T, opts ...Option) *notificationTestEnv {
	t.Helper()
	db, err := database.Init(t.Context(), database.InMemoryDSN)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	b := notify.New(notify.Options{BadgeDebounce: 10 * time.Millisecond})
	t.Cleanup(b.Close)
	cfg := config.NewForTest(octodeckv1.Config_builder{}.Build())
	s := New(db, &mockGitHubClient{authenticated: true}, &mockSyncEngine{}, cfg, nil,
		append([]Option{WithBroadcaster(b)}, opts...)...)
	code, err := s.auth.GenerateCode()
	require.NoError(t, err)
	token, err := s.auth.ExchangeCode(t.Context(), code)
	require.NoError(t, err)

	ts := httptest.NewServer(s.router)
	t.Cleanup(ts.Close)

	return &notificationTestEnv{
		db:     db,
		client: octodeckv1connect.NewOctoDeckServiceClient(http.DefaultClient, ts.URL+"/api/v1"),
		addHeaders: func(req connect.AnyRequest) {
			req.Header().Set("Origin", "chrome-extension://"+config.DevExtensionID)
			req.Header().Set("Authorization", "Bearer "+token)
		},
		broadcaster: b,
	}
}

func (e *notificationTestEnv) watch(
	t *testing.T, since time.Time,
) *connect.ServerStreamForClient[octodeckv1.WatchNotificationsResponse] {
	t.Helper()
	msg := octodeckv1.WatchNotificationsRequest_builder{}.Build()
	if !since.IsZero() {
		msg.SetLastReceivedAt(timestamppb.New(since))
	}
	req := connect.NewRequest(msg)
	e.addHeaders(req)
	stream, err := e.client.WatchNotifications(t.Context(), req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = stream.Close() })
	return stream
}

func receiveMsg(
	t *testing.T, stream *connect.ServerStreamForClient[octodeckv1.WatchNotificationsResponse],
) *octodeckv1.WatchNotificationsResponse {
	t.Helper()
	got := make(chan bool, 1)
	go func() { got <- stream.Receive() }()
	select {
	case ok := <-got:
		require.True(t, ok, "stream ended: %v", stream.Err())
		msg := stream.Msg()
		require.True(t, msg.HasSentAt(), "every message carries a cursor")
		return msg
	case <-time.After(5 * time.Second):
		require.FailNow(t, "timed out waiting for stream message")
		return nil
	}
}

func testNotification(id, itemID string) *octodeckv1.Notification {
	return octodeckv1.Notification_builder{
		Id:     config.Ptr(id),
		ItemId: config.Ptr(itemID),
		Title:  config.Ptr(itemID),
	}.Build()
}

func seedInboxItem(t *testing.T, db *database.DB, id string) {
	t.Helper()
	item := octodeckv1.Item_builder{
		Id:        config.Ptr(id),
		Repo:      config.Ptr("owner/repo"),
		Number:    config.Ptr(int32(1)),
		Type:      config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:     config.Ptr("Needs attention"),
		State:     config.Ptr(octodeckv1.ItemState_ITEM_STATE_OPEN),
		CreatedAt: timestamppb.New(time.Now().Add(-time.Hour)),
		UpdatedAt: timestamppb.New(time.Now()),
		Author:    octodeckv1.User_builder{Login: config.Ptr("someone")}.Build(),
	}.Build()
	require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{item}))
}

func TestWatchNotifications_RequiresAuth(t *testing.T) {
	env := setupNotificationTest(t)
	req := connect.NewRequest(octodeckv1.WatchNotificationsRequest_builder{}.Build())
	req.Header().Set("Origin", "chrome-extension://"+config.DevExtensionID)
	stream, err := env.client.WatchNotifications(t.Context(), req)
	require.NoError(t, err)
	defer stream.Close()
	assert.False(t, stream.Receive())
	assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(stream.Err()))
}

func TestTimeoutExceptExemptsStream(t *testing.T) {
	var hasDeadline bool
	inner := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, hasDeadline = r.Context().Deadline()
	})
	h := timeoutExcept(time.Minute, watchNotificationsPath)(inner)

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, watchNotificationsPath, nil))
	assert.False(t, hasDeadline, "the notification stream must not time out")

	otherPath := "/api/v1" + octodeckv1connect.OctoDeckServiceGetItemsProcedure
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, otherPath, nil))
	assert.True(t, hasDeadline, "other requests keep the timeout")
}

func TestWatchNotifications_UnavailableWithoutBroadcaster(t *testing.T) {
	_, client, addHeaders, _ := setupTestHandler(t)
	req := connect.NewRequest(octodeckv1.WatchNotificationsRequest_builder{}.Build())
	addHeaders(req)
	stream, err := client.WatchNotifications(t.Context(), req)
	require.NoError(t, err)
	defer stream.Close()
	assert.False(t, stream.Receive())
	assert.Equal(t, connect.CodeUnavailable, connect.CodeOf(stream.Err()))
}

func TestWatchNotifications_BadgeOnConnectAndAfterAck(t *testing.T) {
	env := setupNotificationTest(t)
	seedInboxItem(t, env.db, "I_1")

	stream := env.watch(t, time.Time{})
	first := receiveMsg(t, stream)
	require.True(t, first.HasBadge(), "first message is the badge, got %v", first)
	assert.Equal(t, int32(1), first.GetBadge().GetCount())
	assert.Equal(t, "1", first.GetBadge().GetText())
	assert.Equal(t, octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_INBOX, first.GetBadge().GetMode())

	ack := connect.NewRequest(octodeckv1.AckItemRequest_builder{
		ItemId: config.Ptr("I_1"),
		Acked:  config.Ptr(true),
	}.Build())
	env.addHeaders(ack)
	_, err := env.client.AckItem(t.Context(), ack)
	require.NoError(t, err)

	second := receiveMsg(t, stream)
	require.True(t, second.HasBadge())
	assert.Equal(t, int32(0), second.GetBadge().GetCount())
	assert.Empty(t, second.GetBadge().GetText())
	assert.True(t, second.GetSentAt().AsTime().After(first.GetSentAt().AsTime()))
}

func TestWatchNotifications_BadgeModeChange(t *testing.T) {
	env := setupNotificationTest(t)
	seedInboxItem(t, env.db, "I_1")
	stream := env.watch(t, time.Time{})
	require.True(t, receiveMsg(t, stream).HasBadge())

	update := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
		Config: octodeckv1.Config_builder{
			NotificationSettings: octodeckv1.NotificationSettings_builder{
				BadgeCountMode: config.Ptr(octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_DISABLED),
			}.Build(),
		}.Build(),
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"notification_settings"}},
	}.Build())
	env.addHeaders(update)
	_, err := env.client.UpdateConfig(t.Context(), update)
	require.NoError(t, err)

	msg := receiveMsg(t, stream)
	require.True(t, msg.HasBadge())
	assert.Equal(t, octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_DISABLED, msg.GetBadge().GetMode())
	assert.Empty(t, msg.GetBadge().GetText())
}

func TestWatchNotifications_LiveNotifications(t *testing.T) {
	env := setupNotificationTest(t)
	stream := env.watch(t, time.Time{})
	badge := receiveMsg(t, stream)
	require.True(t, badge.HasBadge())

	env.broadcaster.Publish(testNotification("n1", "I_1"))
	msg := receiveMsg(t, stream)
	require.True(t, msg.HasNotification())
	assert.Equal(t, "n1", msg.GetNotification().GetId())
	assert.True(t, msg.GetSentAt().AsTime().After(badge.GetSentAt().AsTime()))
}

func TestWatchNotifications_LiveBurstIsSummarised(t *testing.T) {
	env := setupNotificationTest(t)
	stream := env.watch(t, time.Time{})
	require.True(t, receiveMsg(t, stream).HasBadge())

	// More notifications in one batch than a subscriber can queue individually.
	burst := make([]*octodeckv1.Notification, notify.DefaultSubscriberBuffer+36)
	for i := range burst {
		id := fmt.Sprintf("I_%d", i)
		burst[i] = testNotification("n-"+id, id)
	}
	env.broadcaster.Publish(burst...)

	msg := receiveMsg(t, stream)
	require.True(t, msg.HasSummary(), "got %v", msg)
	assert.Equal(t, int32(len(burst)), msg.GetSummary().GetCount())

	// The stream is still healthy afterwards.
	env.broadcaster.Publish(testNotification("after", "I_after"))
	next := receiveMsg(t, stream)
	require.True(t, next.HasNotification(), "got %v", next)
	assert.Equal(t, "after", next.GetNotification().GetId())
}

func TestWatchNotifications_SmallLiveBurstIsIndividual(t *testing.T) {
	env := setupNotificationTest(t)
	stream := env.watch(t, time.Time{})
	require.True(t, receiveMsg(t, stream).HasBadge())

	env.broadcaster.Publish(testNotification("a1", "A"), testNotification("b1", "B"), testNotification("a2", "A"))
	var got []string
	for range 2 {
		msg := receiveMsg(t, stream)
		require.True(t, msg.HasNotification(), "got %v", msg)
		got = append(got, msg.GetNotification().GetId())
	}
	assert.Equal(t, []string{"b1", "a2"}, got, "latest per item")
}

func TestWatchNotifications_Heartbeat(t *testing.T) {
	env := setupNotificationTest(t, withHeartbeatInterval(20*time.Millisecond))
	stream := env.watch(t, time.Time{})
	require.True(t, receiveMsg(t, stream).HasBadge())
	hb := receiveMsg(t, stream)
	assert.True(t, hb.HasHeartbeat(), "got %v", hb)
}

func TestWatchNotifications_CatchUp(t *testing.T) {
	tests := []struct {
		name        string
		publish     []*octodeckv1.Notification
		wantIDs     []string
		wantSummary int32
	}{
		{name: "nothing missed"},
		{
			name:    "one missed",
			publish: []*octodeckv1.Notification{testNotification("a1", "A")},
			wantIDs: []string{"a1"},
		},
		{
			name: "latest per item, three items replayed individually",
			publish: []*octodeckv1.Notification{
				testNotification("a1", "A"), testNotification("b1", "B"),
				testNotification("a2", "A"), testNotification("c1", "C"),
			},
			wantIDs: []string{"b1", "a2", "c1"},
		},
		{
			name: "more than three items are summarised",
			publish: []*octodeckv1.Notification{
				testNotification("a1", "A"), testNotification("b1", "B"),
				testNotification("c1", "C"), testNotification("d1", "D"),
				testNotification("a2", "A"),
			},
			wantSummary: 4,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := setupNotificationTest(t)

			// Establish a cursor from a first connection, then publish while disconnected.
			first := env.watch(t, time.Time{})
			cursor := receiveMsg(t, first).GetSentAt().AsTime()
			require.NoError(t, first.Close())
			env.broadcaster.Publish(tt.publish...)

			stream := env.watch(t, cursor)
			var gotIDs []string
			for range tt.wantIDs {
				msg := receiveMsg(t, stream)
				require.True(t, msg.HasNotification(), "got %v", msg)
				gotIDs = append(gotIDs, msg.GetNotification().GetId())
			}
			assert.Equal(t, tt.wantIDs, gotIDs)

			if tt.wantSummary > 0 {
				msg := receiveMsg(t, stream)
				require.True(t, msg.HasSummary(), "got %v", msg)
				assert.Equal(t, tt.wantSummary, msg.GetSummary().GetCount())
				assert.Contains(t, msg.GetSummary().GetUrl(), "/?triage=inbox")
			}

			badge := receiveMsg(t, stream)
			assert.True(t, badge.HasBadge(), "catch-up is followed by the badge, got %v", badge)
		})
	}
}

func TestWatchNotifications_NoCatchUpWithoutCursor(t *testing.T) {
	env := setupNotificationTest(t)
	env.broadcaster.Publish(testNotification("a1", "A"))
	stream := env.watch(t, time.Time{})
	assert.True(t, receiveMsg(t, stream).HasBadge())
}

func TestWatchNotifications_EndsOnShutdown(t *testing.T) {
	env := setupNotificationTest(t)
	stream := env.watch(t, time.Time{})
	require.True(t, receiveMsg(t, stream).HasBadge())
	env.broadcaster.Close()

	done := make(chan bool, 1)
	go func() { done <- stream.Receive() }()
	select {
	case ok := <-done:
		assert.False(t, ok)
		require.NoError(t, stream.Err())
	case <-time.After(5 * time.Second):
		require.FailNow(t, "stream did not end after broadcaster close")
	}
}

func TestUpdateConfig_ValidatesNotificationSettings(t *testing.T) {
	env := setupNotificationTest(t)
	update := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
		Config: octodeckv1.Config_builder{
			NotificationSettings: octodeckv1.NotificationSettings_builder{
				AuthorExcludes: []string{"bad\x01login"},
			}.Build(),
		}.Build(),
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"notification_settings"}},
	}.Build())
	env.addHeaders(update)
	_, err := env.client.UpdateConfig(t.Context(), update)
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestUpdateConfig_NotificationSettingsRoundTrip(t *testing.T) {
	env := setupNotificationTest(t)

	get := connect.NewRequest(&octodeckv1.GetConfigRequest{})
	env.addHeaders(get)
	resp, err := env.client.GetConfig(t.Context(), get)
	require.NoError(t, err)
	defaults := resp.Msg.GetConfig().GetNotificationSettings()
	assert.True(t, defaults.GetEnabled())
	assert.True(t, defaults.GetAlwaysIncludeMentions())
	assert.Equal(t, octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_INBOX, defaults.GetBadgeCountMode())

	update := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
		Config: octodeckv1.Config_builder{
			NotificationSettings: octodeckv1.NotificationSettings_builder{
				Enabled:      config.Ptr(false),
				RepoIncludes: []string{"kubernetes/*"},
			}.Build(),
		}.Build(),
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"notification_settings"}},
	}.Build())
	env.addHeaders(update)
	updated, err := env.client.UpdateConfig(t.Context(), update)
	require.NoError(t, err)
	got := updated.Msg.GetConfig().GetNotificationSettings()
	assert.False(t, got.GetEnabled(), "explicit false is kept")
	assert.Equal(t, []string{"kubernetes/*"}, got.GetRepoIncludes())
	assert.True(t, got.GetAlwaysIncludeMentions(), "unset fields take defaults")
}

func TestUpdateConfig_MaskedDashboardSavePreservesNotificationSettings(t *testing.T) {
	env := setupNotificationTest(t)

	// The extension changes the notification settings.
	setNotifications := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
		Config: octodeckv1.Config_builder{
			NotificationSettings: octodeckv1.NotificationSettings_builder{
				Enabled:      config.Ptr(false),
				RepoIncludes: []string{"kubernetes/*"},
			}.Build(),
		}.Build(),
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"notification_settings"}},
	}.Build())
	env.addHeaders(setNotifications)
	_, err := env.client.UpdateConfig(t.Context(), setNotifications)
	require.NoError(t, err)

	get := connect.NewRequest(&octodeckv1.GetConfigRequest{})
	env.addHeaders(get)
	before, err := env.client.GetConfig(t.Context(), get)
	require.NoError(t, err)

	// The dashboard then saves from a stale copy that still has the old notification settings
	// and a different port, masked to only the fields it edits.
	staleNotifications := octodeckv1.NotificationSettings_builder{Enabled: config.Ptr(true)}.Build()
	dashboardSave := connect.NewRequest(octodeckv1.UpdateConfigRequest_builder{
		Config: octodeckv1.Config_builder{
			PollingIntervalMin:   config.Ptr(int32(42)),
			WatchedRepos:         []string{"golang/go"},
			AutoAckOwnActivity:   config.Ptr(false),
			Port:                 config.Ptr(int32(1234)),
			NotificationSettings: staleNotifications,
		}.Build(),
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{
			"polling_interval_min", "watched_repos", "excluded_repos", "pinned_repos", "known_bots",
			"auto_ack_own_activity", "included_labels", "excluded_labels", "tracked_queries",
			"auto_subscribe_queries", "discovery_interval_min",
		}},
	}.Build())
	env.addHeaders(dashboardSave)
	resp, err := env.client.UpdateConfig(t.Context(), dashboardSave)
	require.NoError(t, err)

	got := resp.Msg.GetConfig()
	assert.Equal(t, int32(42), got.GetPollingIntervalMin())
	assert.Equal(t, []string{"golang/go"}, got.GetWatchedRepos())
	assert.False(t, got.GetAutoAckOwnActivity())
	assert.Equal(t, before.Msg.GetConfig().GetPort(), got.GetPort(), "unmasked port is untouched")
	assert.False(t, got.GetNotificationSettings().GetEnabled(), "notification settings are preserved")
	assert.Equal(t, []string{"kubernetes/*"}, got.GetNotificationSettings().GetRepoIncludes())
}
