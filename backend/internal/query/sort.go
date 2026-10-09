package query

import (
	"cmp"
	"math"
	"slices"
	"strings"

	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/logic"
)

const (
	millisPerSecond = 1000
	nanosPerMilli   = 1e6
)

// SortViews orders views in place for GetItems, matching the dashboard's ordering: starred items
// first, then by the sort key in the requested order, then by latest non-noise activity
// (newest first), then by id. An unset sort is SORT_KEY_UPDATED, SORT_ORDER_DESC.
//
// The views' comments must already be classified (NewViews does this), since the latest non-noise
// activity depends on comment noise.
func SortViews(views []*View, sort *octodeckv1.Sort) {
	key := sort.GetKey()
	asc := sort.GetOrder() == octodeckv1.SortOrder_SORT_ORDER_ASC

	type entry struct {
		view    *View
		starred bool
		key     int64
		latest  int64
	}
	entries := make([]entry, len(views))
	for i, v := range views {
		latest := logic.LatestNonNoiseActivityMs(v.Item)
		entries[i] = entry{
			view:    v,
			starred: v.Item.GetLocal().GetStarred(),
			key:     sortKeyMs(v.Item, key, latest),
			latest:  latest,
		}
	}
	slices.SortStableFunc(entries, func(a, b entry) int {
		if a.starred != b.starred {
			if a.starred {
				return -1
			}
			return 1
		}
		if a.key != b.key {
			if asc {
				return cmp.Compare(a.key, b.key)
			}
			return cmp.Compare(b.key, a.key)
		}
		if a.latest != b.latest {
			return cmp.Compare(b.latest, a.latest)
		}
		return strings.Compare(a.view.Item.GetId(), b.view.Item.GetId())
	})
	for i, e := range entries {
		views[i] = e.view
	}
}

// sortKeyMs returns the item's timestamp for the sort key, in Unix milliseconds.
func sortKeyMs(item *octodeckv1.Item, key octodeckv1.SortKey, latest int64) int64 {
	switch key {
	case octodeckv1.SortKey_SORT_KEY_ACKED:
		return ackedMs(item.GetLocal().GetAckedAt())
	case octodeckv1.SortKey_SORT_KEY_CREATED:
		if created := logic.ProtoMs(item.GetCreatedAt()); created > 0 {
			return created
		}
		return logic.ProtoMs(item.GetUpdatedAt())
	case octodeckv1.SortKey_SORT_KEY_UNSPECIFIED, octodeckv1.SortKey_SORT_KEY_UPDATED:
		return latest
	}
	return latest
}

// ackedMs returns when the item was acked, rounding nanoseconds to the nearest millisecond as the
// dashboard does. Items never acked (or with a non-positive time) sort as oldest (0).
func ackedMs(ts *timestamppb.Timestamp) int64 {
	if ts.GetSeconds() <= 0 {
		return 0
	}
	return ts.GetSeconds()*millisPerSecond + int64(math.Round(float64(ts.GetNanos())/nanosPerMilli))
}
