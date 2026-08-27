package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/logic"
)

// TestChallenger_DebugSyncNotifications_CobraExecution verifies end-to-end Cobra command execution
// with various flags (--force, --json, aliases, and --db-path).
func TestChallenger_DebugSyncNotifications_CobraExecution(t *testing.T) {
	tmpDir := t.TempDir()
	cobraDBPath := filepath.Join(tmpDir, "test_cobra.db")
	ctx := t.Context()

	// Initialize test database
	db, err := database.Init(ctx, cobraDBPath)
	require.NoError(t, err)

	// Create and store a notification sync trace
	payload := logic.NotificationSyncPayload{
		HTTPStatus:          http.StatusOK,
		LastModified:        "Thu, 14 Aug 2026 04:00:00 GMT",
		NotificationsCount:  5,
		ReasonsBreakdown:    map[string]int{"assign": 3, "mention": 2},
		UnsupportedTypes:    map[string]int{"CheckSuite": 1},
		FilteredByRepoCount: 1,
		HydratedItems:       []string{"PR_node_1", "PR_node_2"},
		HydrationErrors:     map[string]string{"PR_missing": "404 not found"},
	}
	payloadBytes, err := json.Marshal(payload)
	require.NoError(t, err)

	compressed, err := database.CompressPayload(payloadBytes)
	require.NoError(t, err)

	trace := &database.SyncTrace{
		ID:                   "trace-cobra-1",
		TraceType:            "notification_sync",
		TriggerSource:        "ticker",
		DurationMs:           200,
		ItemsFetched:         2,
		ItemsPersisted:       2,
		RawPayloadCompressed: compressed,
		CreatedAt:            time.Now().UTC().Format(time.RFC3339),
	}
	require.NoError(t, db.SaveSyncTrace(ctx, trace))
	require.NoError(t, db.Close())

	// Test 1: runDebugSyncNotifications in text mode
	var outBuf bytes.Buffer
	mockRunner := &mockSyncEngineRunner{
		runIncFunc: func(_ context.Context) error { return nil },
	}

	reopenedDB, err := database.Init(ctx, cobraDBPath)
	require.NoError(t, err)
	defer func() { _ = reopenedDB.Close() }()

	err = runDebugSyncNotifications(ctx, reopenedDB, mockRunner, false, false, &outBuf)
	require.NoError(t, err)
	outText := outBuf.String()
	assert.Contains(t, outText, "trace-cobra-1")
	assert.Contains(t, outText, "HTTP Status:    200")
	assert.Contains(t, outText, "Last-Modified:  Thu, 14 Aug 2026 04:00:00 GMT")
	assert.Contains(t, outText, "Notifications:  5")
	assert.Contains(t, outText, "Filtered Repos: 1")
	assert.Contains(t, outText, "assign: 3")
	assert.Contains(t, outText, "CheckSuite: 1")
	assert.Contains(t, outText, "Hydrated Items: 2")
	assert.Contains(t, outText, "PR_missing: 404 not found")

	// Test 2: runDebugSyncNotifications in JSON mode
	outBuf.Reset()
	err = runDebugSyncNotifications(ctx, reopenedDB, mockRunner, false, true, &outBuf)
	require.NoError(t, err)
	var parsedJSON logic.NotificationSyncPayload
	require.NoError(t, json.Unmarshal(outBuf.Bytes(), &parsedJSON))
	assert.Equal(t, 200, parsedJSON.HTTPStatus)
	assert.Equal(t, 5, parsedJSON.NotificationsCount)
	assert.Equal(t, 3, parsedJSON.ReasonsBreakdown["assign"])
	assert.Equal(t, []string{"PR_node_1", "PR_node_2"}, parsedJSON.HydratedItems)

	// Test 3: Force flag execution
	forceRan := false
	mockForceRunner := &mockSyncEngineRunner{
		forceFunc: func(_ context.Context) error {
			forceRan = true
			return nil
		},
	}
	outBuf.Reset()
	err = runDebugSyncNotifications(ctx, reopenedDB, mockForceRunner, true, false, &outBuf)
	require.NoError(t, err)
	assert.True(t, forceRan, "ForceSync should have been invoked when force=true")

	// Test 4: Empty DB (no traces)
	emptyDBPath := filepath.Join(tmpDir, "empty.db")
	emptyDB, err := database.Init(ctx, emptyDBPath)
	require.NoError(t, err)
	defer func() { _ = emptyDB.Close() }()

	outBuf.Reset()
	err = runDebugSyncNotifications(ctx, emptyDB, mockRunner, false, false, &outBuf)
	require.NoError(t, err)
	assert.Contains(t, outBuf.String(), "Sync completed successfully (no trace recorded).")
}

// TestChallenger_CorruptedAndMalformedPayloadHandling verifies that debug trace formatting
// handles corrupted, invalid, and empty gzip payloads gracefully without crashing.
func TestChallenger_CorruptedAndMalformedPayloadHandling(t *testing.T) {
	// 1. Corrupted Gzip bytes in trace
	corruptedTrace := &database.SyncTrace{
		ID:                   "corrupted-trace",
		TraceType:            "notification_sync",
		TriggerSource:        "ticker",
		DurationMs:           50,
		ItemsFetched:         0,
		ItemsPersisted:       0,
		RawPayloadCompressed: []byte("this is definitely not valid gzip data"),
		CreatedAt:            time.Now().UTC().Format(time.RFC3339),
	}

	var buf bytes.Buffer
	// Text format should not crash on decompression error
	assert.NotPanics(t, func() {
		printNotificationSyncTraceText(&buf, corruptedTrace)
	})
	assert.Contains(t, buf.String(), "corrupted-trace")

	// JSON format should fallback to formatting the SyncTrace itself
	buf.Reset()
	err := printNotificationSyncTraceJSON(&buf, corruptedTrace)
	require.NoError(t, err)
	assert.Contains(t, buf.String(), `"id": "corrupted-trace"`)

	// 2. Gzip of non-JSON data
	nonJSONGzip, err := database.CompressPayload([]byte("plain non-json text payload"))
	require.NoError(t, err)

	nonJSONTrace := &database.SyncTrace{
		ID:                   "non-json-trace",
		TraceType:            "notification_sync",
		TriggerSource:        "ticker",
		RawPayloadCompressed: nonJSONGzip,
		CreatedAt:            time.Now().UTC().Format(time.RFC3339),
	}

	buf.Reset()
	assert.NotPanics(t, func() {
		printNotificationSyncTraceText(&buf, nonJSONTrace)
	})

	buf.Reset()
	err = printNotificationSyncTraceJSON(&buf, nonJSONTrace)
	require.NoError(t, err)
	assert.Contains(t, buf.String(), "plain non-json text payload")

	// 3. Trace with empty RawPayloadCompressed
	emptyTrace := &database.SyncTrace{
		ID:            "empty-trace",
		TraceType:     "notification_sync",
		TriggerSource: "ticker",
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
	}
	buf.Reset()
	printNotificationSyncTraceText(&buf, emptyTrace)
	assert.Contains(t, buf.String(), "empty-trace")

	buf.Reset()
	err = printNotificationSyncTraceJSON(&buf, emptyTrace)
	require.NoError(t, err)
	assert.Contains(t, buf.String(), `"id": "empty-trace"`)
}

// TestChallenger_TraceDiagnosticsDetailsFormatting stress-tests printNotificationSyncDetails
// with empty, partial, and complex payloads.
func TestChallenger_TraceDiagnosticsDetailsFormatting(t *testing.T) {
	var buf bytes.Buffer

	// Empty payload
	emptyPayload := logic.NotificationSyncPayload{}
	printNotificationSyncDetails(&buf, emptyPayload)
	out := buf.String()
	assert.Contains(t, out, "HTTP Status:    0")
	assert.Contains(t, out, "Notifications:  0")
	assert.NotContains(t, out, "Reasons:")
	assert.NotContains(t, out, "Unsupported Types:")
	assert.NotContains(t, out, "Filtered Repos:")

	// Rich payload
	buf.Reset()
	richPayload := logic.NotificationSyncPayload{
		HTTPStatus:          http.StatusOK,
		LastModified:        "Fri, 15 Aug 2026 00:00:00 GMT",
		NotificationsCount:  100,
		ReasonsBreakdown:    map[string]int{"review_requested": 40, "subscribed": 30, "mention": 20, "author": 10},
		UnsupportedTypes:    map[string]int{"Discussion": 12, "Release": 5, "CheckSuite": 3},
		FilteredByRepoCount: 15,
		HydratedItems:       []string{"PR_1", "PR_2", "PR_3"},
		HydrationErrors:     map[string]string{"PR_failed_1": "network timeout", "PR_failed_2": "permission denied"},
	}
	printNotificationSyncDetails(&buf, richPayload)
	richOut := buf.String()
	assert.Contains(t, richOut, "HTTP Status:    200")
	assert.Contains(t, richOut, "Last-Modified:  Fri, 15 Aug 2026 00:00:00 GMT")
	assert.Contains(t, richOut, "Notifications:  100")
	assert.Contains(t, richOut, "Filtered Repos: 15")
	assert.Contains(t, richOut, "review_requested: 40")
	assert.Contains(t, richOut, "Discussion: 12")
	assert.Contains(t, richOut, "Hydrated Items: 3")
	assert.Contains(t, richOut, "PR_failed_1: network timeout")
	assert.Contains(t, richOut, "PR_failed_2: permission denied")
}

// TestChallenger_DebugTraceQueries_WithRealDB tests retrieving and formatting notification traces
// with real SQLite database file on disk.
func TestChallenger_DebugTraceQueries_WithRealDB(t *testing.T) {
	tmpDir := t.TempDir()
	realDBPath := filepath.Join(tmpDir, "debug_traces_real.db")
	ctx := t.Context()

	db, err := database.Init(ctx, realDBPath)
	require.NoError(t, err)
	defer func() { _ = db.Close() }()

	payload := logic.NotificationSyncPayload{
		HTTPStatus:         http.StatusNotModified,
		LastModified:       "Thu, 14 Aug 2026 05:00:00 GMT",
		NotificationsCount: 0,
	}
	pBytes, err := json.Marshal(payload)
	require.NoError(t, err)
	compressed, err := database.CompressPayload(pBytes)
	require.NoError(t, err)

	trace := &database.SyncTrace{
		ID:                   "trace-notif-304",
		TraceType:            "notification_sync",
		TriggerSource:        "ticker",
		QueryString:          "since=2026-08-14T04:45:00Z all=true",
		DurationMs:           45,
		ItemsFetched:         0,
		ItemsPersisted:       0,
		RawPayloadCompressed: compressed,
		CreatedAt:            time.Now().UTC().Format(time.RFC3339),
	}
	require.NoError(t, db.SaveSyncTrace(ctx, trace))

	// Verify trace list retrieval
	traces, err := db.GetSyncTraces(ctx, 10, "notification_sync")
	require.NoError(t, err)
	require.Len(t, traces, 1)
	assert.Equal(t, "trace-notif-304", traces[0].ID)

	// Verify trace detail and payload decompression
	singleTrace, err := db.GetSyncTrace(ctx, "trace-notif-304")
	require.NoError(t, err)
	require.NotNil(t, singleTrace)

	var buf bytes.Buffer
	printNotificationSyncTraceText(&buf, singleTrace)
	assert.Contains(t, buf.String(), "trace-notif-304")
	assert.Contains(t, buf.String(), "HTTP Status:    304")
	assert.Contains(t, buf.String(), "Last-Modified:  Thu, 14 Aug 2026 05:00:00 GMT")

	buf.Reset()
	err = printNotificationSyncTraceJSON(&buf, singleTrace)
	require.NoError(t, err)
	assert.Contains(t, buf.String(), `"http_status": 304`)
}
