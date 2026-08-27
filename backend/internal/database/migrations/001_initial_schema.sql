-- +goose Up
CREATE TABLE items (
    -- Primary Key
    id TEXT PRIMARY KEY,

    -- Index/Filter Columns (The "Smart Index")
    repo TEXT NOT NULL COLLATE NOCASE, -- Case-insensitive repo matching
    type INTEGER NOT NULL,             -- Maps to ItemType enum
    state INTEGER NOT NULL,            -- Maps to ItemState enum
    author_login TEXT NOT NULL,        -- For "My Issues" vs "Others"
    
    -- Status & Workflow Flags
    is_assigned BOOLEAN NOT NULL,      -- For "Assigned to Me"
    is_viewed BOOLEAN NOT NULL,        -- For read/unread state

    -- Time Handling (Stored as UTC ISO8601 Strings for SQLite ordering compatibility)
    updated_at TEXT NOT NULL,     
    last_synced_at TEXT,

    -- The Payload
    data BLOB NOT NULL                 -- The serialized `v1.Item` Protobuf message
);

CREATE INDEX idx_items_repo ON items(repo COLLATE NOCASE);
CREATE INDEX idx_items_updated ON items(updated_at);
CREATE INDEX idx_items_workflow ON items(is_assigned);

CREATE TABLE tokens (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);

CREATE TABLE metadata (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE sync_traces (
    id TEXT PRIMARY KEY,
    trace_type TEXT NOT NULL,
    trigger_source TEXT NOT NULL,
    query_string TEXT,
    repos_evaluated TEXT,
    since_timestamp TEXT,
    duration_ms INTEGER NOT NULL,
    pages_count INTEGER NOT NULL,
    items_fetched INTEGER NOT NULL,
    items_persisted INTEGER NOT NULL,
    rate_limit_remaining INTEGER,
    error_message TEXT,
    request_headers TEXT,
    raw_payload_compressed BLOB,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_sync_traces_created ON sync_traces(created_at);
CREATE INDEX idx_sync_traces_type ON sync_traces(trace_type);

CREATE TABLE notification_stats (
    bucket_hour TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
);

-- +goose Down
DROP TABLE IF EXISTS notification_stats;
DROP TABLE IF EXISTS sync_traces;
DROP TABLE IF EXISTS metadata;
DROP TABLE IF EXISTS tokens;
DROP TABLE IF EXISTS items;
