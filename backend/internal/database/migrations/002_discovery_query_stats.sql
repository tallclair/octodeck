-- +goose Up
CREATE TABLE discovery_query_stats (
    query_hash TEXT NOT NULL,
    bucket_hour TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (query_hash, bucket_hour)
);

CREATE INDEX idx_discovery_query_stats_bucket ON discovery_query_stats(bucket_hour);

-- +goose Down
DROP TABLE IF EXISTS discovery_query_stats;
