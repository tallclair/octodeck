package database

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPayloadCompression(t *testing.T) {
	original := []byte(`{"nodes": [{"id": "PR_1", "title": "Test Pull Request", "number": 100}]}`)

	compressed, err := CompressPayload(original)
	require.NoError(t, err)
	assert.NotEmpty(t, compressed)

	decompressed, err := DecompressPayload(compressed)
	require.NoError(t, err)
	assert.Equal(t, original, decompressed)

	// Empty payload
	emptyCompressed, err := CompressPayload(nil)
	require.NoError(t, err)
	assert.Nil(t, emptyCompressed)

	emptyDecompressed, err := DecompressPayload(nil)
	require.NoError(t, err)
	assert.Nil(t, emptyDecompressed)
}

func TestSyncTraces_SaveAndGet(t *testing.T) {
	db := setupTestDB(t)

	now := time.Now().UTC()
	rateLimit := int32(4950)
	payload := []byte(`{"search": {"nodes": [{"id": "PR_1"}]}}`)
	compressed, err := CompressPayload(payload)
	require.NoError(t, err)

	trace1 := &SyncTrace{
		ID:                   "trace-1",
		TraceType:            "heartbeat",
		TriggerSource:        "ticker",
		QueryString:          "repo:k8s/k8s updated:>2026-08-13T18:00:00Z",
		ReposEvaluated:       `["kubernetes/kubernetes"]`,
		SinceTimestamp:       "2026-08-13T18:00:00Z",
		DurationMs:           150,
		PagesCount:           1,
		ItemsFetched:         1,
		ItemsPersisted:       1,
		RateLimitRemaining:   &rateLimit,
		RequestHeaders:       `{"Accept": "application/json"}`,
		RawPayloadCompressed: compressed,
		CreatedAt:            now.Add(-10 * time.Minute).Format(time.RFC3339),
	}

	trace2 := &SyncTrace{
		ID:             "trace-2",
		TraceType:      "inventory",
		TriggerSource:  "startup",
		QueryString:    "is:open (assignee:@me OR author:@me)",
		DurationMs:     320,
		PagesCount:     2,
		ItemsFetched:   5,
		ItemsPersisted: 5,
		CreatedAt:      now.Add(-5 * time.Minute).Format(time.RFC3339),
	}

	require.NoError(t, db.SaveSyncTrace(t.Context(), trace1))
	require.NoError(t, db.SaveSyncTrace(t.Context(), trace2))

	// Get all traces
	allTraces, err := db.GetSyncTraces(t.Context(), 10, "")
	require.NoError(t, err)
	require.Len(t, allTraces, 2)
	assert.Equal(t, "trace-2", allTraces[0].ID) // Order by created_at DESC
	assert.Equal(t, "trace-1", allTraces[1].ID)

	// Filter by trace_type
	heartbeatTraces, err := db.GetSyncTraces(t.Context(), 10, "heartbeat")
	require.NoError(t, err)
	require.Len(t, heartbeatTraces, 1)
	assert.Equal(t, "trace-1", heartbeatTraces[0].ID)
	require.NotNil(t, heartbeatTraces[0].RateLimitRemaining)
	assert.Equal(t, int32(4950), *heartbeatTraces[0].RateLimitRemaining)

	// Get single trace by ID
	singleTrace, err := db.GetSyncTrace(t.Context(), "trace-1")
	require.NoError(t, err)
	assert.Equal(t, "trace-1", singleTrace.ID)
	assert.Equal(t, "heartbeat", singleTrace.TraceType)
	assert.Equal(t, "repo:k8s/k8s updated:>2026-08-13T18:00:00Z", singleTrace.QueryString)

	decompressedPayload, err := DecompressPayload(singleTrace.RawPayloadCompressed)
	require.NoError(t, err)
	assert.Equal(t, payload, decompressedPayload)

	// Non-existent trace
	_, err = db.GetSyncTrace(t.Context(), "non-existent")
	require.Error(t, err)
}

func TestSyncTraces_PruneOld(t *testing.T) {
	db := setupTestDB(t)

	now := time.Now().UTC()
	oldTime := now.Add(-25 * time.Hour)
	recentTime := now.Add(-2 * time.Hour)

	oldTrace := &SyncTrace{
		ID:            "old-trace",
		TraceType:     "heartbeat",
		TriggerSource: "ticker",
		DurationMs:    100,
		CreatedAt:     oldTime.Format(time.RFC3339),
	}
	recentTrace := &SyncTrace{
		ID:            "recent-trace",
		TraceType:     "heartbeat",
		TriggerSource: "ticker",
		DurationMs:    120,
		CreatedAt:     recentTime.Format(time.RFC3339),
	}

	require.NoError(t, db.SaveSyncTrace(t.Context(), oldTrace))
	require.NoError(t, db.SaveSyncTrace(t.Context(), recentTrace))

	cutoff := now.Add(-24 * time.Hour)
	prunedCount, err := db.PruneOldSyncTraces(t.Context(), cutoff)
	require.NoError(t, err)
	assert.Equal(t, int64(1), prunedCount)

	remaining, err := db.GetSyncTraces(t.Context(), 10, "")
	require.NoError(t, err)
	require.Len(t, remaining, 1)
	assert.Equal(t, "recent-trace", remaining[0].ID)
}
