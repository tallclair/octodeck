package logic

import (
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/github"
)

// mergedCloseSlackMs is how far a CLOSED event may precede a MERGED event and still be treated as
// part of the merge (GitHub records both, with slightly different timestamps).
const mergedCloseSlackMs = 1000

// nanosPerMilli converts protobuf timestamp nanoseconds to milliseconds.
const nanosPerMilli = 1_000_000

// millisPerSecond converts protobuf timestamp seconds to milliseconds.
const millisPerSecond = 1000

// ProtoMs returns a timestamp in Unix milliseconds, truncating sub-millisecond precision, the same
// way the frontend's getProtoTimestampMs does. A nil timestamp is 0.
func ProtoMs(ts *timestamppb.Timestamp) int64 {
	if ts == nil {
		return 0
	}
	return ts.GetSeconds()*millisPerSecond + int64(ts.GetNanos())/nanosPerMilli
}

// msMax tracks the maximum of a set of millisecond timestamps and whether any was added.
type msMax struct {
	v  int64
	ok bool
}

func (m *msMax) add(ms int64) {
	if !m.ok || ms > m.v {
		m.v = ms
	}
	m.ok = true
}

// LatestNonNoiseActivityMs returns the time of the item's latest non-noise activity in Unix
// milliseconds. It is the sort key for "recently updated" and mirrors the frontend timeline
// (getLatestNonNoiseActivityMs in frontend/src/logic/timeline.ts): the latest of non-noise
// comments, the latest commit, submitted reviews and state changes, but never earlier than the
// item's creation. Without any such activity it falls back to created_at, then updated_at.
//
// Comment noise is read from noise_type, so comments must be classified (ClassifyCommentsForUser)
// before calling this.
func LatestNonNoiseActivityMs(item *octodeckv1.Item) int64 {
	var acc msMax
	addNonNoiseComments(&acc, item)
	addLatestCommit(&acc, item)
	addSubmittedReviews(&acc, item)
	addStateEvents(&acc, item)

	created := ProtoMs(item.GetCreatedAt())
	if acc.ok {
		return max(created, acc.v)
	}
	if created > 0 {
		return created
	}
	return ProtoMs(item.GetUpdatedAt())
}

// addNonNoiseComments adds every comment not classified as noise. A comment without a timestamp is
// placed at the epoch, as in the timeline.
func addNonNoiseComments(acc *msMax, item *octodeckv1.Item) {
	for _, c := range item.GetComments() {
		if c.GetNoiseType() != octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_UNSPECIFIED {
			continue
		}
		acc.add(ProtoMs(c.GetCreatedAt()))
	}
}

// addLatestCommit adds the most recent commit; the timeline condenses commits to that one.
func addLatestCommit(acc *msMax, item *octodeckv1.Item) {
	for _, c := range item.GetCommits() {
		acc.add(ProtoMs(c.GetCommittedDate()))
	}
}

// addSubmittedReviews adds reviews that have a submission time and are not pending drafts.
func addSubmittedReviews(acc *msMax, item *octodeckv1.Item) {
	for _, r := range item.GetReviews() {
		ms := ProtoMs(r.GetSubmittedAt())
		if ms == 0 || r.GetState() == github.ReviewStatePending {
			continue
		}
		acc.add(ms)
	}
}

type stateEventMs struct {
	merged bool
	closed bool
	ms     int64
}

// addStateEvents adds close, merge, reopen and assign events. Items that are closed or merged but
// have no such events get a synthetic one at updated_at. A CLOSED event at, after, or within a
// second before a MERGED event is part of the merge and is not counted separately.
func addStateEvents(acc *msMax, item *octodeckv1.Item) {
	events := collectStateEvents(item)
	if len(events) == 0 {
		events = fallbackStateEvent(item)
	}
	var merged []int64
	for _, e := range events {
		if e.merged {
			merged = append(merged, e.ms)
		}
	}
	for _, e := range events {
		if e.closed && isMergedClose(e.ms, merged) {
			continue
		}
		acc.add(e.ms)
	}
}

func collectStateEvents(item *octodeckv1.Item) []stateEventMs {
	var events []stateEventMs
	for _, e := range item.GetStateEvents() {
		ms := ProtoMs(e.GetCreatedAt())
		switch e.GetType() {
		case octodeckv1.StateChangeType_STATE_CHANGE_TYPE_CLOSED:
			events = append(events, stateEventMs{closed: true, ms: ms})
		case octodeckv1.StateChangeType_STATE_CHANGE_TYPE_MERGED:
			events = append(events, stateEventMs{merged: true, ms: ms})
		case octodeckv1.StateChangeType_STATE_CHANGE_TYPE_REOPENED,
			octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED:
			events = append(events, stateEventMs{ms: ms})
		case octodeckv1.StateChangeType_STATE_CHANGE_TYPE_UNSPECIFIED:
			// Not rendered in the timeline.
		}
	}
	return events
}

func fallbackStateEvent(item *octodeckv1.Item) []stateEventMs {
	ms := ProtoMs(item.GetUpdatedAt())
	switch item.GetState() {
	case octodeckv1.ItemState_ITEM_STATE_MERGED:
		return []stateEventMs{{merged: true, ms: ms}}
	case octodeckv1.ItemState_ITEM_STATE_CLOSED:
		return []stateEventMs{{closed: true, ms: ms}}
	case octodeckv1.ItemState_ITEM_STATE_UNSPECIFIED, octodeckv1.ItemState_ITEM_STATE_OPEN:
		return nil
	}
	return nil
}

func isMergedClose(closeMs int64, merged []int64) bool {
	for _, m := range merged {
		if closeMs >= m-mergedCloseSlackMs {
			return true
		}
	}
	return false
}
