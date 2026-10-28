package logic

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"maps"
	"slices"
)

// KeyDiscoveryHydrationFailures is the metadata key for the JSON map of discovery candidates
// that failed to hydrate in their latest attempt to the number of consecutive runs they failed.
const KeyDiscoveryHydrationFailures = "discovery_hydration_failures"

// discoveryMaxHydrationAttempts is how many consecutive discovery runs may fail to hydrate a
// candidate (with a per-item error such as FORBIDDEN or SAML enforcement) while its queries'
// cursors are held below it. After that it is passed over, so an item that can never be
// hydrated doesn't pin a query's cursor and stall discovery of everything newer.
const discoveryMaxHydrationAttempts = 3

// trackDiscoveryHydrationFailures records this discovery run's hydration failures (see
// trackHydrationFailures).
func (s *SyncEngine) trackDiscoveryHydrationFailures(
	ctx context.Context,
	failed map[string]string,
) (map[string]struct{}, []string) {
	return s.trackHydrationFailures(ctx, KeyDiscoveryHydrationFailures, failed)
}

// trackHydrationFailures records a cursor-driven run's hydration failures under the metadata
// key and returns the failed items to retry (whose cursors are kept below them) and those
// passed over after discoveryMaxHydrationAttempts consecutive failures. An item's count resets
// when it isn't among the failures of a run. If the counts can't be read or stored, nothing is
// retried: without them retries could repeat forever, and passing an item over only delays it
// until its next update rather than stalling the cursor.
func (s *SyncEngine) trackHydrationFailures(
	ctx context.Context,
	key string,
	failed map[string]string,
) (map[string]struct{}, []string) {
	previous, err := s.loadHydrationFailures(ctx, key)
	if err != nil {
		slog.ErrorContext(ctx, "Failed to read hydration failures; not retrying failed items",
			"key", key, "error", err, "failed", len(failed))
		return nil, slices.Sorted(maps.Keys(failed))
	}

	retry := make(map[string]struct{}, len(failed))
	counts := make(map[string]int, len(failed))
	var abandoned []string
	for id, msg := range failed {
		attempts := previous[id] + 1
		if attempts > discoveryMaxHydrationAttempts {
			slog.ErrorContext(ctx, "Giving up on an item that keeps failing to hydrate",
				"key", key, "id", id, "attempts", attempts, "error", msg)
			abandoned = append(abandoned, id)
			continue
		}
		slog.WarnContext(ctx, "Item failed to hydrate; will retry on the next run",
			"key", key, "id", id, "attempt", attempts, "error", msg)
		retry[id] = struct{}{}
		counts[id] = attempts
	}
	slices.Sort(abandoned)

	if len(counts) == 0 && len(previous) == 0 {
		return retry, abandoned
	}
	value := ""
	if len(counts) > 0 {
		b, err := json.Marshal(counts)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to encode hydration failures", "key", key, "error", err)
			return nil, slices.Sorted(maps.Keys(failed))
		}
		value = string(b)
	}
	if err := s.db.SetMetadata(ctx, key, value); err != nil {
		slog.ErrorContext(ctx, "Failed to store hydration failures; not retrying failed items",
			"key", key, "error", err)
		return nil, slices.Sorted(maps.Keys(failed))
	}
	return retry, abandoned
}

func (s *SyncEngine) loadHydrationFailures(ctx context.Context, key string) (map[string]int, error) {
	counts := map[string]int{}
	raw, err := s.db.GetMetadata(ctx, key)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && raw == "") {
		return counts, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(raw), &counts); err != nil {
		// Unreadable counts are discarded: every failure starts over, which is bounded because
		// the next store replaces them.
		slog.WarnContext(ctx, "Discarding unreadable hydration failures", "key", key, "error", err)
		return map[string]int{}, nil
	}
	return counts, nil
}
