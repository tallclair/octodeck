-- +goose Up
-- Denormalized from ItemLocalState (review_backfill_before set and no sync_error) so the sync
-- engine can find items eligible for a pending PR review backfill without decoding every blob.
-- An item with a sync_error leaves the sweep until a successful re-hydration clears the error
-- (a notification, a manual refetch, or the stale refresh of open items during garbage
-- collection); closed items only recover via a notification before they are pruned.
ALTER TABLE items ADD COLUMN review_backfill_pending INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_items_review_backfill_pending ON items(last_synced_at) WHERE review_backfill_pending = 1;

-- +goose Down
DROP INDEX IF EXISTS idx_items_review_backfill_pending;
ALTER TABLE items DROP COLUMN review_backfill_pending;
