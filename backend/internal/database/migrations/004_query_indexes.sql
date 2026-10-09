-- +goose Up
-- Indexes for the query engine's SQL prefilter (repo already has idx_items_repo). The author index
-- uses NOCASE because the prefilter compares author_login COLLATE NOCASE.
CREATE INDEX idx_items_author_nocase ON items(author_login COLLATE NOCASE);
CREATE INDEX idx_items_state ON items(state);
CREATE INDEX idx_items_type ON items(type);

-- +goose Down
DROP INDEX IF EXISTS idx_items_type;
DROP INDEX IF EXISTS idx_items_state;
DROP INDEX IF EXISTS idx_items_author_nocase;
