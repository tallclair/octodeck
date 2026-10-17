package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

const (
	// MaxSavedSearches is the maximum number of saved searches allowed when creating via RPC.
	MaxSavedSearches = 50
	// MaxSavedSearchNameLen is the maximum length of a saved search name in Unicode runes.
	MaxSavedSearchNameLen = 80
	// MaxSavedSearchQueryLen is the maximum length of a saved search query in Unicode runes.
	MaxSavedSearchQueryLen = 1000
	savedSearchIDBytes     = 16
)

var (
	// ErrSavedSearchNotFound is returned when a saved search ID does not exist.
	ErrSavedSearchNotFound = errors.New("saved search not found")
	// ErrSavedSearchNameTaken is returned when a saved search name is already used.
	ErrSavedSearchNameTaken = errors.New("saved search name already used")
	// ErrSavedSearchLimit is returned when creating a saved search would exceed MaxSavedSearches.
	ErrSavedSearchLimit = errors.New("too many saved searches")
	// ErrSavedSearchInvalid is returned when a saved search field or update mask is invalid.
	ErrSavedSearchInvalid = errors.New("invalid saved search")
	// ErrSavedSearchStaleOrder is returned when reorder IDs are not a permutation of current IDs.
	ErrSavedSearchStaleOrder = errors.New("saved search ids changed")
)

// GetSavedSearches returns a deep copy of the saved searches in display order.
func (c *Config) GetSavedSearches() []*octodeckv1.SavedSearch {
	d := c.data.Load()
	if d == nil {
		return nil
	}
	return cloneSavedSearches(d.GetSavedSearches())
}

// UpdateSavedSearches runs fn on a deep copy of the saved searches list under c.mu, stores the
// result and writes it to disk. If fn fails or the disk write fails, the previous configuration
// pointer is restored and the error is returned.
func (c *Config) UpdateSavedSearches(
	fn func([]*octodeckv1.SavedSearch) ([]*octodeckv1.SavedSearch, error),
) ([]*octodeckv1.SavedSearch, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	current := c.data.Load()
	next, err := fn(cloneSavedSearches(current.GetSavedSearches()))
	if err != nil {
		return nil, err
	}

	updated, _ := proto.Clone(current).(*octodeckv1.Config)
	updated.SetSavedSearches(cloneSavedSearches(next))
	if err := c.writeProtoLocked(updated); err != nil {
		return nil, err
	}
	c.data.Store(updated)
	return cloneSavedSearches(next), nil
}

// CreateSavedSearch validates input, appends a new saved search with a fresh ID, and persists it.
func (c *Config) CreateSavedSearch(
	input *octodeckv1.SavedSearch,
) (*octodeckv1.SavedSearch, []*octodeckv1.SavedSearch, error) {
	var created *octodeckv1.SavedSearch
	list, err := c.UpdateSavedSearches(func(current []*octodeckv1.SavedSearch) ([]*octodeckv1.SavedSearch, error) {
		var opErr error
		var next []*octodeckv1.SavedSearch
		next, created, opErr = CreateSavedSearchInList(current, input)
		return next, opErr
	})
	if err != nil {
		return nil, nil, err
	}
	return created, list, nil
}

// UpdateSavedSearch updates an existing saved search by ID according to mask and persists the list.
func (c *Config) UpdateSavedSearch(
	patch *octodeckv1.SavedSearch,
	mask *fieldmaskpb.FieldMask,
) ([]*octodeckv1.SavedSearch, error) {
	return c.UpdateSavedSearches(func(current []*octodeckv1.SavedSearch) ([]*octodeckv1.SavedSearch, error) {
		return UpdateSavedSearchInList(current, patch, mask)
	})
}

// DeleteSavedSearch deletes the saved search with the given ID and persists the remaining list.
func (c *Config) DeleteSavedSearch(id string) ([]*octodeckv1.SavedSearch, error) {
	return c.UpdateSavedSearches(func(current []*octodeckv1.SavedSearch) ([]*octodeckv1.SavedSearch, error) {
		return DeleteSavedSearchInList(current, id)
	})
}

// ReorderSavedSearches reorders the saved searches to match ids and persists the list.
func (c *Config) ReorderSavedSearches(ids []string) ([]*octodeckv1.SavedSearch, error) {
	return c.UpdateSavedSearches(func(current []*octodeckv1.SavedSearch) ([]*octodeckv1.SavedSearch, error) {
		return ReorderSavedSearchesInList(current, ids)
	})
}

// ValidateSavedSearchName checks that name has no control characters and is 1-80 characters after trimming.
func ValidateSavedSearchName(name string) error {
	if !utf8.ValidString(name) {
		return fmt.Errorf("%w: name contains invalid UTF-8", ErrSavedSearchInvalid)
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return fmt.Errorf("%w: name must not contain control characters", ErrSavedSearchInvalid)
		}
	}
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return fmt.Errorf("%w: name must not be empty", ErrSavedSearchInvalid)
	}
	if utf8.RuneCountInString(trimmed) > MaxSavedSearchNameLen {
		return fmt.Errorf("%w: name must be at most %d characters", ErrSavedSearchInvalid, MaxSavedSearchNameLen)
	}
	return nil
}

// ValidateSavedSearchQuery checks that query is non-empty after trimming, at most 1000 characters,
// and contains no line breaks.
func ValidateSavedSearchQuery(query string) error {
	if !utf8.ValidString(query) {
		return fmt.Errorf("%w: query contains invalid UTF-8", ErrSavedSearchInvalid)
	}
	if strings.ContainsAny(query, "\r\n") {
		return fmt.Errorf("%w: query must not contain line breaks", ErrSavedSearchInvalid)
	}
	if strings.TrimSpace(query) == "" {
		return fmt.Errorf("%w: query must not be empty", ErrSavedSearchInvalid)
	}
	if utf8.RuneCountInString(query) > MaxSavedSearchQueryLen {
		return fmt.Errorf("%w: query must be at most %d characters", ErrSavedSearchInvalid, MaxSavedSearchQueryLen)
	}
	return nil
}

// CreateSavedSearchInList validates input against per-operation create rules and appends it to list.
func CreateSavedSearchInList(
	list []*octodeckv1.SavedSearch,
	input *octodeckv1.SavedSearch,
) ([]*octodeckv1.SavedSearch, *octodeckv1.SavedSearch, error) {
	if input == nil {
		return nil, nil, fmt.Errorf("%w: saved_search is required", ErrSavedSearchInvalid)
	}
	if err := ValidateSavedSearchName(input.GetName()); err != nil {
		return nil, nil, err
	}
	if err := ValidateSavedSearchQuery(input.GetQuery()); err != nil {
		return nil, nil, err
	}
	if len(list) >= MaxSavedSearches {
		return nil, nil, fmt.Errorf("%w: maximum of %d saved searches reached", ErrSavedSearchLimit, MaxSavedSearches)
	}
	trimmedName := strings.TrimSpace(input.GetName())
	for _, s := range list {
		if strings.EqualFold(s.GetName(), trimmedName) {
			return nil, nil, fmt.Errorf("%w: %q", ErrSavedSearchNameTaken, trimmedName)
		}
	}

	usedIDs := make(map[string]struct{}, len(list))
	for _, s := range list {
		usedIDs[s.GetId()] = struct{}{}
	}
	id := generateSavedSearchID(usedIDs)
	query := input.GetQuery()
	b := octodeckv1.SavedSearch_builder{
		Id:    &id,
		Name:  &trimmedName,
		Query: &query,
	}
	if input.HasSort() {
		clonedSort, _ := proto.Clone(input.GetSort()).(*octodeckv1.Sort)
		b.Sort = clonedSort
	}
	created := b.Build()
	next := append(cloneSavedSearches(list), created)
	clonedCreated, _ := proto.Clone(created).(*octodeckv1.SavedSearch)
	return next, clonedCreated, nil
}

// UpdateSavedSearchInList updates one entry in list by ID using the given update mask.
func UpdateSavedSearchInList(
	list []*octodeckv1.SavedSearch,
	patch *octodeckv1.SavedSearch,
	mask *fieldmaskpb.FieldMask,
) ([]*octodeckv1.SavedSearch, error) {
	if patch == nil {
		return nil, fmt.Errorf("%w: saved_search is required", ErrSavedSearchInvalid)
	}
	updateName, updateQuery, updateSort, err := parseSavedSearchUpdateMask(mask)
	if err != nil {
		return nil, err
	}

	id := patch.GetId()
	idx := slices.IndexFunc(list, func(s *octodeckv1.SavedSearch) bool {
		return s.GetId() == id && id != ""
	})
	if idx < 0 {
		return nil, fmt.Errorf("%w: %q", ErrSavedSearchNotFound, id)
	}

	next := cloneSavedSearches(list)
	target := next[idx]

	if updateName {
		if err := ValidateSavedSearchName(patch.GetName()); err != nil {
			return nil, err
		}
		trimmedName := strings.TrimSpace(patch.GetName())
		for i, s := range next {
			if i != idx && strings.EqualFold(s.GetName(), trimmedName) {
				return nil, fmt.Errorf("%w: %q", ErrSavedSearchNameTaken, trimmedName)
			}
		}
		target.SetName(trimmedName)
	}

	if updateQuery {
		if err := ValidateSavedSearchQuery(patch.GetQuery()); err != nil {
			return nil, err
		}
		target.SetQuery(patch.GetQuery())
	}

	if updateSort {
		if patch.HasSort() {
			clonedSort, _ := proto.Clone(patch.GetSort()).(*octodeckv1.Sort)
			target.SetSort(clonedSort)
		} else {
			target.ClearSort()
		}
	}

	return next, nil
}

func parseSavedSearchUpdateMask(mask *fieldmaskpb.FieldMask) (updateName, updateQuery, updateSort bool, err error) {
	if mask == nil || len(mask.GetPaths()) == 0 {
		return true, true, true, nil
	}
	for _, p := range mask.GetPaths() {
		switch p {
		case "name":
			updateName = true
		case "query":
			updateQuery = true
		case "sort":
			updateSort = true
		default:
			return false, false, false, fmt.Errorf("%w: unsupported update_mask path %q", ErrSavedSearchInvalid, p)
		}
	}
	return updateName, updateQuery, updateSort, nil
}

// DeleteSavedSearchInList removes the entry with the given ID from list.
func DeleteSavedSearchInList(
	list []*octodeckv1.SavedSearch,
	id string,
) ([]*octodeckv1.SavedSearch, error) {
	idx := slices.IndexFunc(list, func(s *octodeckv1.SavedSearch) bool {
		return s.GetId() == id && id != ""
	})
	if idx < 0 {
		return nil, fmt.Errorf("%w: %q", ErrSavedSearchNotFound, id)
	}
	next := cloneSavedSearches(list)
	next = slices.Delete(next, idx, idx+1)
	if len(next) == 0 {
		return nil, nil
	}
	return next, nil
}

// ReorderSavedSearchesInList reorders list to match ids, requiring ids to be a permutation of the current IDs.
func ReorderSavedSearchesInList(
	list []*octodeckv1.SavedSearch,
	ids []string,
) ([]*octodeckv1.SavedSearch, error) {
	if len(ids) != len(list) {
		return nil, fmt.Errorf("%w: expected %d ids, got %d", ErrSavedSearchStaleOrder, len(list), len(ids))
	}
	byID := make(map[string]*octodeckv1.SavedSearch, len(list))
	for _, s := range list {
		byID[s.GetId()] = s
	}
	seen := make(map[string]struct{}, len(ids))
	reordered := make([]*octodeckv1.SavedSearch, 0, len(ids))
	for _, id := range ids {
		if _, dup := seen[id]; dup {
			return nil, fmt.Errorf("%w: duplicate id %q", ErrSavedSearchStaleOrder, id)
		}
		entry, ok := byID[id]
		if !ok {
			return nil, fmt.Errorf("%w: unknown id %q", ErrSavedSearchStaleOrder, id)
		}
		seen[id] = struct{}{}
		cloned, _ := proto.Clone(entry).(*octodeckv1.SavedSearch)
		reordered = append(reordered, cloned)
	}
	if len(reordered) == 0 {
		return nil, nil
	}
	return reordered, nil
}

// NormalizeSavedSearches repairs a loaded list of saved searches in place on a cloned slice:
// entries with an empty query after trimming are dropped; missing or duplicate IDs are assigned
// new IDs (the first occurrence keeps its ID); control characters in names are replaced by spaces,
// names are trimmed, empty names fall back to the query, and names longer than 80 runes are
// truncated on a rune boundary. Duplicate names and lists over 50 entries are kept and logged.
func NormalizeSavedSearches(list []*octodeckv1.SavedSearch) []*octodeckv1.SavedSearch {
	if len(list) == 0 {
		return nil
	}
	usedIDs := make(map[string]struct{}, len(list))
	seenNames := make(map[string]struct{}, len(list))
	out := make([]*octodeckv1.SavedSearch, 0, len(list))

	for _, raw := range list {
		if raw == nil || strings.TrimSpace(raw.GetQuery()) == "" {
			slog.Warn("Dropping saved search with empty query")
			continue
		}
		entry, _ := proto.Clone(raw).(*octodeckv1.SavedSearch)

		id := strings.TrimSpace(entry.GetId())
		if id == "" {
			id = generateSavedSearchID(usedIDs)
		} else if _, dup := usedIDs[id]; dup {
			slog.Warn("Duplicate saved search ID in config; assigning new ID", "id", id)
			id = generateSavedSearchID(usedIDs)
		}
		usedIDs[id] = struct{}{}
		entry.SetId(id)

		name := cleanSavedSearchName(entry.GetName())
		if name == "" {
			name = cleanSavedSearchName(entry.GetQuery())
		}
		name = truncateRunes(name, MaxSavedSearchNameLen)
		entry.SetName(name)

		foldedName := strings.ToLower(name)
		if _, dup := seenNames[foldedName]; dup {
			slog.Warn("Duplicate saved search name in config", "name", name)
		}
		seenNames[foldedName] = struct{}{}

		out = append(out, entry)
	}

	if len(out) > MaxSavedSearches {
		slog.Warn("Saved searches in config exceed limit", "count", len(out), "limit", MaxSavedSearches)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func cleanSavedSearchName(s string) string {
	mapped := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	return strings.TrimSpace(mapped)
}

func truncateRunes(s string, maxRunes int) string {
	if utf8.RuneCountInString(s) <= maxRunes {
		return s
	}
	runes := 0
	for i := range s {
		if runes == maxRunes {
			return s[:i]
		}
		runes++
	}
	return s
}

func generateSavedSearchID(used map[string]struct{}) string {
	for {
		var buf [savedSearchIDBytes]byte
		_, _ = rand.Read(buf[:])
		id := hex.EncodeToString(buf[:])
		if _, exists := used[id]; !exists {
			return id
		}
	}
}

func cloneSavedSearches(list []*octodeckv1.SavedSearch) []*octodeckv1.SavedSearch {
	if len(list) == 0 {
		return nil
	}
	out := make([]*octodeckv1.SavedSearch, len(list))
	for i, s := range list {
		out[i], _ = proto.Clone(s).(*octodeckv1.SavedSearch)
	}
	return out
}
