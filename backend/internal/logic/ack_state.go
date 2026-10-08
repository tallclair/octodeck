package logic

import (
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// The acknowledgement state of an item is stored in two ItemLocalState fields:
//   - acked_at: when the ack happened (daemon wall clock, or the user's own GitHub event time for
//     auto-ack). Its presence marks the item as acked; it orders "Last Acked".
//   - acked_activity_at: the activity watermark (GitHub clock). Activity at or before it is
//     acknowledged. Rows written before this field existed stored the watermark in acked_at, so
//     readers fall back to acked_at when it is unset.
//
// All readers and writers go through the helpers below so the fallback is applied consistently.

func validTimestamp(ts *timestamppb.Timestamp) bool {
	return ts != nil && ts.GetSeconds() > 0
}

// IsAcked reports whether the item has been acknowledged (explicitly or via auto-ack). This does
// not mean its computed status is ACKED: newer activity may have superseded the ack.
func IsAcked(l *octodeckv1.ItemLocalState) bool {
	return validTimestamp(l.GetAckedAt()) || validTimestamp(l.GetAckedActivityAt())
}

// AckedActivityAt returns the activity watermark: acked_activity_at, falling back to acked_at
// when unset. Returns the zero time if the item is not acked.
func AckedActivityAt(l *octodeckv1.ItemLocalState) time.Time {
	if validTimestamp(l.GetAckedActivityAt()) {
		return l.GetAckedActivityAt().AsTime()
	}
	if validTimestamp(l.GetAckedAt()) {
		return l.GetAckedAt().AsTime()
	}
	return time.Time{}
}

// SetAcked marks the item as acknowledged at actionTime with the given activity watermark.
func SetAcked(l *octodeckv1.ItemLocalState, actionTime, watermark time.Time) {
	l.SetAckedAt(timestamppb.New(actionTime))
	l.SetAckedActivityAt(timestamppb.New(watermark))
}

// ClearAcked removes the acknowledgement.
func ClearAcked(l *octodeckv1.ItemLocalState) {
	l.ClearAckedAt()
	l.ClearAckedActivityAt()
}

// LatestActivityTime returns the newest synced timestamp among everything CalculateStatus
// inspects: updated_at, created_at, comments, reviews and their comments, commits, and state
// events. Using it as the watermark guarantees that an item acked at this time stays ACKED until
// newer activity is synced. Returns the zero time if the item has no timestamps.
func LatestActivityTime(item *octodeckv1.Item) time.Time {
	var latest time.Time
	consider := func(ts *timestamppb.Timestamp) {
		if validTimestamp(ts) && ts.AsTime().After(latest) {
			latest = ts.AsTime()
		}
	}

	consider(item.GetUpdatedAt())
	consider(item.GetCreatedAt())
	for _, c := range item.GetComments() {
		consider(c.GetCreatedAt())
	}
	for _, r := range item.GetReviews() {
		consider(r.GetSubmittedAt())
		for _, rc := range r.GetComments() {
			consider(rc.GetCreatedAt())
		}
	}
	for _, c := range item.GetCommits() {
		consider(c.GetCommittedDate())
	}
	for _, e := range item.GetStateEvents() {
		consider(e.GetCreatedAt())
	}
	return latest
}
