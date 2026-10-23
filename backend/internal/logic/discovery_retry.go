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

// trackDiscoveryHydrationFailures records this run's hydration failures and returns the failed
// candidates to retry (whose queries keep their cursors below them) and those passed over. A
// candidate's count resets when it isn't among the failures of a run. If the counts can't be
// read or stored, nothing is retried: without them retries could repeat forever, and passing a
// candidate over only delays it until its next update rather than stalling discovery.
func (s *SyncEngine) trackDiscoveryHydrationFailures(
	ctx context.Context,
	failed map[string]string,
) (map[string]struct{}, []string) {
	previous, err := s.loadDiscoveryHydrationFailures(ctx)
	if err != nil {
		slog.ErrorContext(ctx, "Failed to read discovery hydration failures; not retrying failed items",
			"error", err, "failed", len(failed))
		return nil, slices.Sorted(maps.Keys(failed))
	}

	retry := make(map[string]struct{}, len(failed))
	counts := make(map[string]int, len(failed))
	var abandoned []string
	for id, msg := range failed {
		attempts := previous[id] + 1
		if attempts > discoveryMaxHydrationAttempts {
			slog.ErrorContext(ctx, "Giving up on a discovered item that keeps failing to hydrate",
				"id", id, "attempts", attempts, "error", msg)
			abandoned = append(abandoned, id)
			continue
		}
		slog.WarnContext(ctx, "Discovered item failed to hydrate; will retry on the next run",
			"id", id, "attempt", attempts, "error", msg)
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
			slog.ErrorContext(ctx, "Failed to encode discovery hydration failures", "error", err)
			return nil, slices.Sorted(maps.Keys(failed))
		}
		value = string(b)
	}
	if err := s.db.SetMetadata(ctx, KeyDiscoveryHydrationFailures, value); err != nil {
		slog.ErrorContext(ctx, "Failed to store discovery hydration failures; not retrying failed items",
			"error", err)
		return nil, slices.Sorted(maps.Keys(failed))
	}
	return retry, abandoned
}

func (s *SyncEngine) loadDiscoveryHydrationFailures(ctx context.Context) (map[string]int, error) {
	counts := map[string]int{}
	raw, err := s.db.GetMetadata(ctx, KeyDiscoveryHydrationFailures)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && raw == "") {
		return counts, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(raw), &counts); err != nil {
		// Unreadable counts are discarded: every failure starts over, which is bounded because
		// the next store replaces them.
		slog.WarnContext(ctx, "Discarding unreadable discovery hydration failures", "error", err)
		return map[string]int{}, nil
	}
	return counts, nil
}
