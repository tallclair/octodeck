package database

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
	_ "github.com/mattn/go-sqlite3" // Register sqlite3 driver.
	"github.com/pressly/goose/v3"
	"google.golang.org/protobuf/proto"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

//go:embed migrations/*.sql
var embedMigrations embed.FS

const (
	// InMemoryDSN is the data source name for an in-memory SQLite database.
	InMemoryDSN = ":memory:"
)

// DB wraps the sqlx.DB connection.
type DB struct {
	*sqlx.DB
}

// itemRow matches the database schema for the items table.
type itemRow struct {
	ID           string         `db:"id"`
	Repo         string         `db:"repo"`
	Type         int32          `db:"type"`
	State        int32          `db:"state"`
	AuthorLogin  string         `db:"author_login"`
	IsAssigned   bool           `db:"is_assigned"`
	IsViewed     bool           `db:"is_viewed"`
	UpdatedAt    string         `db:"updated_at"`
	LastSyncedAt sql.NullString `db:"last_synced_at"`
	Data         []byte         `db:"data"`
}

func (r itemRow) toItem() (*octodeckv1.Item, error) {
	var item octodeckv1.Item
	if err := proto.Unmarshal(r.Data, &item); err != nil {
		return nil, fmt.Errorf("failed to unmarshal item data: %w", err)
	}
	return &item, nil
}

func newItemRow(item *octodeckv1.Item) (itemRow, error) {
	data, err := proto.Marshal(item)
	if err != nil {
		return itemRow{}, fmt.Errorf("failed to marshal item: %w", err)
	}

	// Helper to safely get local state
	var isViewed bool
	// Default to empty/false if local is nil, though it shouldn't be for fully populated items
	if item.GetLocal() != nil {
		// Check if last_viewed_at is set (not nil and valid timestamp)
		if item.GetLocal().GetLastViewedAt() != nil && item.GetLocal().GetLastViewedAt().GetSeconds() > 0 {
			isViewed = true
		}
	}

	// Helper to check assignment.
	// TODO(v2): The `is_assigned` column is intended for the "Assigned to Me" filter.
	// Since we don't have the current user's login here, we temporarily index if *anyone* is assigned.
	// We should eventually inject the user context or add a flag to the Proto.
	isAssigned := len(item.GetAssignees()) > 0

	updatedAt := ""
	if item.GetUpdatedAt() != nil {
		updatedAt = item.GetUpdatedAt().AsTime().UTC().Format(time.RFC3339)
	}

	var lastSyncedAt sql.NullString
	if item.GetLastSyncedAt() != nil {
		lastSyncedAt = sql.NullString{
			String: item.GetLastSyncedAt().AsTime().UTC().Format(time.RFC3339),
			Valid:  true,
		}
	}

	var authorLogin string
	if item.GetAuthor() != nil {
		authorLogin = item.GetAuthor().GetLogin()
	}

	return itemRow{
		ID:           item.GetId(),
		Repo:         item.GetRepo(),
		Type:         int32(item.GetType()),
		State:        int32(item.GetState()),
		AuthorLogin:  authorLogin,
		IsAssigned:   isAssigned,
		IsViewed:     isViewed,
		UpdatedAt:    updatedAt,
		LastSyncedAt: lastSyncedAt,
		Data:         data,
	}, nil
}

// Init initializes the database connection and runs migrations.
func Init(ctx context.Context, dbPath string) (*DB, error) {
	// Ensure directory exists if not in-memory
	if dbPath != InMemoryDSN {
		if err := os.MkdirAll(filepath.Dir(dbPath), 0750); err != nil {
			return nil, fmt.Errorf("failed to create database directory: %w", err)
		}
	}

	// sqlx.Connect opens and pings
	dsn := dbPath + "?parseTime=true&_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL"
	db, err := sqlx.ConnectContext(ctx, "sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// In SQLite WAL mode, restrict write/open pool connections to prevent SQLITE_BUSY contention
	if dbPath != InMemoryDSN {
		db.SetMaxOpenConns(1)
	}

	const pragmaQuery = "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; " +
		"PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;"
	if _, err := db.ExecContext(ctx, pragmaQuery); err != nil {
		return nil, fmt.Errorf("failed to enable foreign keys and WAL mode: %w", err)
	}

	// Apply migrations
	goose.SetBaseFS(embedMigrations)
	if err := goose.SetDialect("sqlite3"); err != nil {
		return nil, fmt.Errorf("failed to set goose dialect: %w", err)
	}
	if err := goose.UpContext(ctx, db.DB, "migrations"); err != nil {
		return nil, fmt.Errorf("failed to apply migrations: %w", err)
	}

	return &DB{db}, nil
}

// Close closes the database connection.
func (d *DB) Close() error {
	return d.DB.Close()
}

// SaveItems upserts a list of items into the database.
func (d *DB) SaveItems(ctx context.Context, items []*octodeckv1.Item) (err error) {
	tx, err := d.BeginTxx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, fmt.Errorf("failed to rollback tx: %w", rollbackErr))
		}
	}()

	query := `
		INSERT INTO items (
			id, repo, type, state, author_login, is_assigned, is_viewed,
			updated_at, last_synced_at, data
		) VALUES (
			:id, :repo, :type, :state, :author_login, :is_assigned, :is_viewed,
			:updated_at, :last_synced_at, :data
		)
		ON CONFLICT(id) DO UPDATE SET
			repo = excluded.repo,
			type = excluded.type,
			state = excluded.state,
			author_login = excluded.author_login,
			is_assigned = excluded.is_assigned,
			is_viewed = excluded.is_viewed,
			updated_at = excluded.updated_at,
			last_synced_at = excluded.last_synced_at,
			data = excluded.data
	`

	// Prepare the rows
	rows := make([]itemRow, len(items))
	for i, item := range items {
		row, err := newItemRow(item)
		if err != nil {
			return err
		}
		rows[i] = row
	}

	// Use NamedExecContext for the batch
	if _, err := tx.NamedExecContext(ctx, query, rows); err != nil {
		return fmt.Errorf("failed to upsert items: %w", err)
	}

	return tx.Commit()
}

// IsPopulated checks if the items table has any rows.
func (d *DB) IsPopulated(ctx context.Context) (bool, error) {
	var count int
	err := d.GetContext(ctx, &count, "SELECT count(*) FROM items LIMIT 1")
	if err != nil {
		return false, fmt.Errorf("failed to check if populated: %w", err)
	}
	return count > 0, nil
}

// GetDistinctRepos returns a sorted list of unique repository names from the items table.
func (d *DB) GetDistinctRepos(ctx context.Context) ([]string, error) {
	var repos []string
	query := "SELECT DISTINCT repo FROM items WHERE repo != '' ORDER BY repo ASC"
	err := d.SelectContext(ctx, &repos, query)
	if err != nil {
		return nil, fmt.Errorf("failed to query distinct repos: %w", err)
	}
	return repos, nil
}

// GetItems retrieves items from the database matching the provided filter.
func (d *DB) GetItems(ctx context.Context, filter *octodeckv1.Filter) ([]*octodeckv1.Item, error) {
	query, args := buildGetItemsQuery(filter)

	// Expand IN clauses
	query, argsSlice, err := sqlx.Named(query, args)
	if err != nil {
		return nil, fmt.Errorf("failed to prepare named query: %w", err)
	}
	query, argsSlice, err = sqlx.In(query, argsSlice...)
	if err != nil {
		return nil, fmt.Errorf("failed to expand IN clauses: %w", err)
	}
	query = d.Rebind(query)

	var rows []itemRow
	err = d.SelectContext(ctx, &rows, query, argsSlice...)
	if err != nil {
		return nil, fmt.Errorf("failed to query items: %w", err)
	}

	items := make([]*octodeckv1.Item, len(rows))
	for i, r := range rows {
		item, err := r.toItem()
		if err != nil {
			return nil, err
		}
		items[i] = item
	}

	return items, nil
}

func buildGetItemsQuery(filter *octodeckv1.Filter) (string, map[string]any) {
	query := "SELECT data FROM items"
	var conditions []string
	args := map[string]any{}

	if filter != nil {
		conditions, args = applyFilterConditions(filter, conditions, args)
	}

	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}

	// Always sort by updated_at desc
	query += " ORDER BY updated_at DESC"
	return query, args
}

func applyFilterConditions(filter *octodeckv1.Filter,
	conditions []string, args map[string]any) ([]string, map[string]any) {
	if filter.HasIsViewed() {
		conditions = append(conditions, "is_viewed = :is_viewed")
		args["is_viewed"] = filter.GetIsViewed()
	}
	if filter.HasIsAssigned() {
		conditions = append(conditions, "is_assigned = :is_assigned")
		args["is_assigned"] = filter.GetIsAssigned()
	}
	if filter.GetType() != octodeckv1.ItemType_ITEM_TYPE_UNSPECIFIED {
		conditions = append(conditions, "type = :type")
		args["type"] = filter.GetType()
	}
	if filter.GetState() != octodeckv1.ItemState_ITEM_STATE_UNSPECIFIED {
		conditions = append(conditions, "state = :state")
		args["state"] = filter.GetState()
	}
	if len(filter.GetRepos()) > 0 {
		conditions = append(conditions, "repo IN (:repos)")
		args["repos"] = filter.GetRepos()
	}
	if len(filter.GetAuthors()) > 0 {
		conditions = append(conditions, "author_login IN (:authors)")
		args["authors"] = filter.GetAuthors()
	}
	if filter.GetQuery() != "" {
		conditions = append(conditions, "repo LIKE :query")
		args["query"] = "%" + filter.GetQuery() + "%"
	}
	return conditions, args
}

const maxIDParts = 2

func ParseRepoAndNumber(id string) (string, int32, bool) {
	if !strings.Contains(id, "#") {
		return "", 0, false
	}
	parts := strings.SplitN(id, "#", maxIDParts)
	if len(parts) != maxIDParts {
		return "", 0, false
	}
	num, err := strconv.ParseInt(parts[1], 10, 32)
	if err != nil {
		return "", 0, false
	}
	return parts[0], int32(num), true
}

func findItemByRepoAndNumber(
	ctx context.Context,
	q sqlx.QueryerContext,
	repo string,
	number int32,
) (*itemRow, error) {
	var rows []itemRow
	query := "SELECT id, repo, type, state, author_login, is_assigned, is_viewed, updated_at, last_synced_at, data " +
		"FROM items WHERE LOWER(repo) = LOWER(?)"
	if err := sqlx.SelectContext(ctx, q, &rows, query, repo); err == nil {
		for _, r := range rows {
			item, err := r.toItem()
			if err == nil && item.GetNumber() == number {
				return &r, nil
			}
		}
	}

	// Fallback in case repo in database differs slightly
	var allRows []itemRow
	fallbackQuery := "SELECT id, repo, type, state, author_login, is_assigned, is_viewed, " +
		"updated_at, last_synced_at, data FROM items"
	if err := sqlx.SelectContext(ctx, q, &allRows, fallbackQuery); err == nil {
		for _, r := range allRows {
			item, err := r.toItem()
			if err == nil && item.GetNumber() == number {
				itemRepo := strings.ToLower(item.GetRepo())
				targetRepo := strings.ToLower(repo)
				if itemRepo == targetRepo ||
					strings.HasSuffix(itemRepo, "/"+targetRepo) ||
					strings.HasSuffix(targetRepo, "/"+itemRepo) {
					return &r, nil
				}
			}
		}
	}

	return nil, sql.ErrNoRows
}

// GetItem retrieves a single item by ID or by repo#number reference.
func (d *DB) GetItem(ctx context.Context, id string) (*octodeckv1.Item, error) {
	var row itemRow
	err := d.GetContext(ctx, &row, "SELECT data FROM items WHERE id = ?", id)
	if err == nil {
		return row.toItem()
	}

	if repo, number, ok := ParseRepoAndNumber(id); ok {
		if matchedRow, refErr := findItemByRepoAndNumber(ctx, d, repo, number); refErr == nil {
			return matchedRow.toItem()
		}
	}

	return nil, err
}

// UpdateItem performs an atomic read-modify-write operation on an item within a transaction.
func (d *DB) UpdateItem(
	ctx context.Context,
	id string,
	updateFn func(*octodeckv1.Item) error,
) (*octodeckv1.Item, error) {
	tx, err := d.BeginTxx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, fmt.Errorf("failed to rollback tx: %w", rollbackErr))
		}
	}()

	var row itemRow
	fetchErr := tx.GetContext(
		ctx,
		&row,
		"SELECT id, repo, type, state, author_login, is_assigned, is_viewed, updated_at, last_synced_at, data "+
			"FROM items WHERE id = ?",
		id,
	)
	if fetchErr != nil {
		if repo, number, ok := ParseRepoAndNumber(id); ok {
			if matchedRow, refErr := findItemByRepoAndNumber(ctx, tx, repo, number); refErr == nil {
				row = *matchedRow
				fetchErr = nil
			}
		}
	}

	if fetchErr != nil {
		return nil, fmt.Errorf("failed to fetch item: %w", fetchErr)
	}

	item, err := row.toItem()
	if err != nil {
		return nil, err
	}

	if err := updateFn(item); err != nil {
		return nil, err
	}

	newRow, err := newItemRow(item)
	if err != nil {
		return nil, err
	}

	query := `
		UPDATE items SET
			repo = :repo,
			type = :type,
			state = :state,
			author_login = :author_login,
			is_assigned = :is_assigned,
			is_viewed = :is_viewed,
			updated_at = :updated_at,
			last_synced_at = :last_synced_at,
			data = :data
		WHERE id = :id
	`
	if _, err := tx.NamedExecContext(ctx, query, newRow); err != nil {
		return nil, fmt.Errorf("failed to update item: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}

	return item, nil
}

// GetMetadata retrieves a value from the metadata table.
func (d *DB) GetMetadata(ctx context.Context, key string) (string, error) {
	var value string
	err := d.GetContext(ctx, &value, "SELECT value FROM metadata WHERE key = ?", key)
	return value, err
}

// SetMetadata sets a value in the metadata table.
func (d *DB) SetMetadata(ctx context.Context, key, value string) error {
	_, err := d.ExecContext(ctx, `
		INSERT INTO metadata (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
	`, key, value, time.Now())
	return err
}

// GetStaleItems retrieves items that are OPEN and haven't been synced since the specified cutoff.
func (d *DB) GetStaleItems(ctx context.Context, cutoff time.Time) ([]*octodeckv1.Item, error) {
	var rows []itemRow
	// We pass the cutoff time as a string because we store it as ISO8601 string
	cutoffStr := cutoff.UTC().Format(time.RFC3339)

	err := d.SelectContext(ctx, &rows, `
		SELECT data
		FROM items
		WHERE state = ?
		AND last_synced_at < ?
	`, int32(octodeckv1.ItemState_ITEM_STATE_OPEN), cutoffStr)
	if err != nil {
		return nil, fmt.Errorf("failed to query stale items: %w", err)
	}

	items := make([]*octodeckv1.Item, len(rows))
	for i, r := range rows {
		item, err := r.toItem()
		if err != nil {
			return nil, err
		}
		items[i] = item
	}

	return items, nil
}

// DeleteItems removes items with the specified IDs from the database.
func (d *DB) DeleteItems(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	query, args, err := sqlx.In("DELETE FROM items WHERE id IN (?)", ids)
	if err != nil {
		return fmt.Errorf("failed to construct delete query: %w", err)
	}
	query = d.Rebind(query)

	if _, err := d.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("failed to delete items: %w", err)
	}
	return nil
}

// PruneOldItems removes items that are closed and haven't been updated since the cutoff.
func (d *DB) PruneOldItems(ctx context.Context, cutoff time.Time) (int64, error) {
	cutoffStr := cutoff.UTC().Format(time.RFC3339)
	res, err := d.ExecContext(ctx, `
		DELETE FROM items
		WHERE state IN (?, ?)
		AND updated_at < ?
	`, int32(octodeckv1.ItemState_ITEM_STATE_CLOSED), int32(octodeckv1.ItemState_ITEM_STATE_MERGED), cutoffStr)
	if err != nil {
		return 0, fmt.Errorf("failed to prune old items: %w", err)
	}
	return res.RowsAffected()
}

// RecordNotificationCount records the number of notifications received during a time window bucket.
func (d *DB) RecordNotificationCount(ctx context.Context, t time.Time, count int) error {
	if count <= 0 {
		return nil
	}
	bucketHour := t.UTC().Truncate(time.Hour).Format(time.RFC3339)
	query := `
		INSERT INTO notification_stats (bucket_hour, count)
		VALUES (?, ?)
		ON CONFLICT(bucket_hour) DO UPDATE SET count = count + excluded.count
	`
	_, err := d.ExecContext(ctx, query, bucketHour, count)
	if err != nil {
		return fmt.Errorf("failed to record notification count: %w", err)
	}
	return nil
}

// GetNotificationRates returns the average notifications per hour over the last 24 hours, 7 days, and 30 days.
func (d *DB) GetNotificationRates(ctx context.Context, now time.Time) (rate24h, rate7d, rate30d float64, err error) {
	since24h := now.Add(-24 * time.Hour).UTC().Format(time.RFC3339)
	since7d := now.Add(-7 * 24 * time.Hour).UTC().Format(time.RFC3339)
	since30d := now.Add(-30 * 24 * time.Hour).UTC().Format(time.RFC3339)

	var stats struct {
		Count24h int64 `db:"count_24h"`
		Count7d  int64 `db:"count_7d"`
		Count30d int64 `db:"count_30d"`
	}

	query := `
		SELECT
			COALESCE(SUM(CASE WHEN bucket_hour >= ? THEN count ELSE 0 END), 0) AS count_24h,
			COALESCE(SUM(CASE WHEN bucket_hour >= ? THEN count ELSE 0 END), 0) AS count_7d,
			COALESCE(SUM(CASE WHEN bucket_hour >= ? THEN count ELSE 0 END), 0) AS count_30d
		FROM notification_stats
		WHERE bucket_hour >= ?
	`
	if err := d.GetContext(ctx, &stats, query, since24h, since7d, since30d, since30d); err != nil {
		return 0, 0, 0, fmt.Errorf("failed to query notification rates: %w", err)
	}

	const (
		hoursPerDay  = 24.0
		daysPerWeek  = 7.0
		daysPerMonth = 30.0
	)

	rate24h = float64(stats.Count24h) / hoursPerDay
	rate7d = float64(stats.Count7d) / (daysPerWeek * hoursPerDay)
	rate30d = float64(stats.Count30d) / (daysPerMonth * hoursPerDay)
	return rate24h, rate7d, rate30d, nil
}

// PruneOldNotificationStats removes notification rate buckets older than the cutoff timestamp.
func (d *DB) PruneOldNotificationStats(ctx context.Context, cutoff time.Time) (int64, error) {
	cutoffStr := cutoff.UTC().Format(time.RFC3339)
	res, err := d.ExecContext(ctx, "DELETE FROM notification_stats WHERE bucket_hour < ?", cutoffStr)
	if err != nil {
		return 0, fmt.Errorf("failed to prune old notification stats: %w", err)
	}
	return res.RowsAffected()
}

func ptr[T any](v T) *T {
	return &v
}

// GetDatabaseStats computes and returns aggregated storage and item inventory statistics.
func (d *DB) GetDatabaseStats(ctx context.Context, dbPath string) (*octodeckv1.DatabaseStats, error) {
	items, err := d.GetItems(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to load items for database stats: %w", err)
	}

	var openItems, closedItems, prItems, issueItems, unackedItems, ackedItems int64
	repos := make(map[string]struct{})

	for _, it := range items {
		if it == nil {
			continue
		}
		if it.GetState() == octodeckv1.ItemState_ITEM_STATE_OPEN {
			openItems++
		} else {
			closedItems++
		}

		if it.GetType() == octodeckv1.ItemType_ITEM_TYPE_PR {
			prItems++
		} else {
			issueItems++
		}

		if it.GetLocal() != nil && it.GetLocal().GetAckedAt() != nil && it.GetLocal().GetAckedAt().GetSeconds() > 0 {
			ackedItems++
		} else {
			unackedItems++
		}

		if r := it.GetRepo(); r != "" {
			repos[r] = struct{}{}
		}
	}

	var totalTraces int64
	_ = d.GetContext(ctx, &totalTraces, "SELECT count(*) FROM sync_traces")

	var dbSizeBytes int64
	if dbPath != "" && dbPath != InMemoryDSN {
		if fi, statErr := os.Stat(dbPath); statErr == nil {
			dbSizeBytes = fi.Size()
		}
	}

	return octodeckv1.DatabaseStats_builder{
		TotalItems:   ptr(int64(len(items))),
		OpenItems:    ptr(openItems),
		ClosedItems:  ptr(closedItems),
		PrItems:      ptr(prItems),
		IssueItems:   ptr(issueItems),
		UnackedItems: ptr(unackedItems),
		AckedItems:   ptr(ackedItems),
		TotalRepos:   ptr(int64(len(repos))),
		TotalTraces:  ptr(totalTraces),
		DbSizeBytes:  ptr(dbSizeBytes),
		DbPath:       ptr(dbPath),
	}.Build(), nil
}
