package database

import (
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"fmt"
	"io"
	"time"
)

// CompressPayload compresses a byte slice using gzip.
func CompressPayload(data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, nil
	}
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	if _, err := gw.Write(data); err != nil {
		return nil, fmt.Errorf("failed to gzip write: %w", err)
	}
	if err := gw.Close(); err != nil {
		return nil, fmt.Errorf("failed to gzip close: %w", err)
	}
	return buf.Bytes(), nil
}

// DecompressPayload decompresses a gzip-compressed byte slice.
func DecompressPayload(compressed []byte) ([]byte, error) {
	if len(compressed) == 0 {
		return nil, nil
	}
	gr, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, fmt.Errorf("failed to create gzip reader: %w", err)
	}
	defer gr.Close()

	decompressed, err := io.ReadAll(gr)
	if err != nil {
		return nil, fmt.Errorf("failed to read decompressed payload: %w", err)
	}
	return decompressed, nil
}

// SyncTrace represents a trace record for a synchronization or GitHub query execution.
type SyncTrace struct {
	ID                   string        `db:"id" json:"id"`
	TraceType            string        `db:"trace_type" json:"trace_type"`
	TriggerSource        string        `db:"trigger_source" json:"trigger_source"`
	QueryString          string        `db:"query_string" json:"query_string"`
	ReposEvaluated       string        `db:"repos_evaluated" json:"repos_evaluated"`
	SinceTimestamp       string        `db:"since_timestamp" json:"since_timestamp"`
	DurationMs           int64         `db:"duration_ms" json:"duration_ms"`
	PagesCount           int64         `db:"pages_count" json:"pages_count"`
	ItemsFetched         int64         `db:"items_fetched" json:"items_fetched"`
	ItemsPersisted       int64         `db:"items_persisted" json:"items_persisted"`
	RateLimitRemaining   *int32        `db:"-" json:"rate_limit_remaining,omitempty"`
	RateLimitRemainingDB sql.NullInt32 `db:"rate_limit_remaining" json:"-"`
	ErrorMessage         string        `db:"error_message" json:"error_message,omitempty"`
	RequestHeaders       string        `db:"request_headers" json:"request_headers,omitempty"`
	RawPayloadCompressed []byte        `db:"raw_payload_compressed" json:"-"`
	CreatedAt            string        `db:"created_at" json:"created_at"`
}

// SaveSyncTrace inserts a sync trace record into the database.
func (d *DB) SaveSyncTrace(ctx context.Context, trace *SyncTrace) error {
	if trace == nil {
		return nil
	}

	if trace.CreatedAt == "" {
		trace.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if trace.RateLimitRemaining != nil {
		trace.RateLimitRemainingDB = sql.NullInt32{
			Int32: *trace.RateLimitRemaining,
			Valid: true,
		}
	} else {
		trace.RateLimitRemainingDB = sql.NullInt32{Valid: false}
	}

	query := `
		INSERT INTO sync_traces (
			id, trace_type, trigger_source, query_string, repos_evaluated,
			since_timestamp, duration_ms, pages_count, items_fetched,
			items_persisted, rate_limit_remaining, error_message,
			request_headers, raw_payload_compressed, created_at
		) VALUES (
			:id, :trace_type, :trigger_source, :query_string, :repos_evaluated,
			:since_timestamp, :duration_ms, :pages_count, :items_fetched,
			:items_persisted, :rate_limit_remaining, :error_message,
			:request_headers, :raw_payload_compressed, :created_at
		)
	`
	_, err := d.NamedExecContext(ctx, query, trace)
	if err != nil {
		return fmt.Errorf("failed to insert sync trace: %w", err)
	}
	return nil
}

// GetSyncTraces retrieves recent sync traces, optionally filtered by traceType.
func (d *DB) GetSyncTraces(ctx context.Context, limit int, traceType string) ([]*SyncTrace, error) {
	if limit <= 0 {
		limit = 50
	}

	var traces []*SyncTrace
	var query string
	var args []any

	if traceType != "" {
		query = `
			SELECT id, trace_type, trigger_source, query_string, repos_evaluated,
				since_timestamp, duration_ms, pages_count, items_fetched,
				items_persisted, rate_limit_remaining, error_message,
				request_headers, raw_payload_compressed, created_at
			FROM sync_traces
			WHERE trace_type = ?
			ORDER BY created_at DESC
			LIMIT ?
		`
		args = []any{traceType, limit}
	} else {
		query = `
			SELECT id, trace_type, trigger_source, query_string, repos_evaluated,
				since_timestamp, duration_ms, pages_count, items_fetched,
				items_persisted, rate_limit_remaining, error_message,
				request_headers, raw_payload_compressed, created_at
			FROM sync_traces
			ORDER BY created_at DESC
			LIMIT ?
		`
		args = []any{limit}
	}

	err := d.SelectContext(ctx, &traces, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query sync traces: %w", err)
	}

	for _, t := range traces {
		if t.RateLimitRemainingDB.Valid {
			val := t.RateLimitRemainingDB.Int32
			t.RateLimitRemaining = &val
		}
	}

	return traces, nil
}

// GetSyncTrace retrieves a single sync trace by ID.
func (d *DB) GetSyncTrace(ctx context.Context, id string) (*SyncTrace, error) {
	var trace SyncTrace
	query := `
		SELECT id, trace_type, trigger_source, query_string, repos_evaluated,
			since_timestamp, duration_ms, pages_count, items_fetched,
			items_persisted, rate_limit_remaining, error_message,
			request_headers, raw_payload_compressed, created_at
		FROM sync_traces
		WHERE id = ?
	`
	err := d.GetContext(ctx, &trace, query, id)
	if err != nil {
		return nil, fmt.Errorf("failed to get sync trace %s: %w", id, err)
	}

	if trace.RateLimitRemainingDB.Valid {
		val := trace.RateLimitRemainingDB.Int32
		trace.RateLimitRemaining = &val
	}

	return &trace, nil
}

// PruneOldSyncTraces removes sync traces older than the cutoff timestamp (typically 24h).
func (d *DB) PruneOldSyncTraces(ctx context.Context, cutoff time.Time) (int64, error) {
	cutoffStr := cutoff.UTC().Format(time.RFC3339)
	res, err := d.ExecContext(ctx, "DELETE FROM sync_traces WHERE created_at < ?", cutoffStr)
	if err != nil {
		return 0, fmt.Errorf("failed to prune old sync traces: %w", err)
	}
	return res.RowsAffected()
}
