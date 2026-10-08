package logic

import (
	"strings"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// LatestOwnActivityTime returns the time of currentUser's latest own activity on the item:
// authoring it, commenting, submitting reviews or review comments, pushing commits, or performing
// state events. Pending (unsubmitted) reviews are not activity. Returns the zero time if the user
// has no activity on the item or currentUser is empty.
func LatestOwnActivityTime(item *octodeckv1.Item, currentUser string) time.Time {
	if strings.TrimSpace(currentUser) == "" {
		return time.Time{}
	}

	var latest time.Time
	consider := func(login string, ts *timestamppb.Timestamp) {
		if isSameUser(login, currentUser) && validTimestamp(ts) && ts.AsTime().After(latest) {
			latest = ts.AsTime()
		}
	}

	consider(item.GetAuthor().GetLogin(), item.GetCreatedAt())
	for _, c := range item.GetComments() {
		consider(c.GetAuthor().GetLogin(), c.GetCreatedAt())
	}
	for _, r := range item.GetReviews() {
		if isPendingReview(r) {
			continue
		}
		consider(r.GetAuthor().GetLogin(), r.GetSubmittedAt())
		for _, rc := range r.GetComments() {
			consider(reviewCommentAuthor(rc, r).GetLogin(), rc.GetCreatedAt())
		}
	}
	for _, c := range item.GetCommits() {
		consider(c.GetAuthorLogin(), c.GetCommittedDate())
	}
	for _, e := range item.GetStateEvents() {
		consider(e.GetActor().GetLogin(), e.GetCreatedAt())
	}
	return latest
}

// EffectiveLastViewedAt returns the time up to which the user has seen the item: the later of the
// recorded last_viewed_at and the user's latest own activity on it. Acting on an item implies
// having seen it, so the result is never older than the user's own latest action, nor older than
// last_viewed_at. Returns the zero time if neither exists.
func EffectiveLastViewedAt(item *octodeckv1.Item, currentUser string) time.Time {
	var viewed time.Time
	if lv := item.GetLocal().GetLastViewedAt(); validTimestamp(lv) {
		viewed = lv.AsTime()
	}
	if own := LatestOwnActivityTime(item, currentUser); own.After(viewed) {
		viewed = own
	}
	return viewed
}

// SetComputedLastViewedAt sets (or clears, when there is none) the server-computed
// computed_last_viewed_at field from EffectiveLastViewedAt. Readers call it on every read, so a
// value that ever reached storage is never surfaced. The item must have local state attached.
func SetComputedLastViewedAt(item *octodeckv1.Item, currentUser string) {
	if viewed := EffectiveLastViewedAt(item, currentUser); !viewed.IsZero() {
		item.GetLocal().SetComputedLastViewedAt(timestamppb.New(viewed))
	} else {
		item.GetLocal().ClearComputedLastViewedAt()
	}
}
