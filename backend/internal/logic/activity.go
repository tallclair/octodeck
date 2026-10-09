package logic

import (
	"time"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// Activity is the triage state of an item, expressed as independent "new:" flags (see
// docs/internal/query_model_design.md §4.4). Unlike the single computed status, several flags can
// be set at once: an item with a new mention and new commits has both Mention and Code set.
//
// Acked items carry no flags, because any activity that matters un-acks them.
type Activity struct {
	// Acked reports that the item is acknowledged and the acknowledgement has not been superseded
	// by later activity (computed status ACKED).
	Acked bool
	// Item reports that the item was never viewed and never acked (new:item).
	Item bool
	// Mention reports a new explicit @mention of the current user (new:mention).
	Mention bool
	// Comment reports new non-noise comments, reviews or state changes (new:comment).
	Comment bool
	// Code reports new commits by someone other than the current user (new:code).
	Code bool
	// Noise reports new noise activity such as bot comments or slash commands (new:noise).
	Noise bool
}

// ComputeActivity computes the independent "new:" flags of an item for currentUser. It applies the
// same acknowledgement, last-viewed baseline and "no update since baseline" rules as the status
// calculator, so the single status derived by (Activity).Status is identical to the historical
// priority-ordered status.
func ComputeActivity(item *octodeckv1.Item, currentUser string, knownBots []string) Activity {
	hasAcked := IsAcked(item.GetLocal())
	// ackedAt is the activity watermark (GitHub clock), not the time the ack happened.
	var ackedAt time.Time
	updatedAt := item.GetUpdatedAt().AsTime()

	if hasAcked {
		ackedAt = AckedActivityAt(item.GetLocal())
		if remainsAcked(item, ackedAt, updatedAt, currentUser, knownBots) {
			return Activity{Acked: true}
		}
	}

	// The user has seen everything up to their own latest activity (including authoring the item),
	// so own activity always counts as viewed, whether or not auto-ack is enabled.
	viewedAt := EffectiveLastViewedAt(item, currentUser)

	// Never seen: everything the item contains is new to the user.
	if viewedAt.IsZero() && !hasAcked {
		a := contentActivity(item, time.Time{}, currentUser, knownBots)
		a.Item = true
		return a
	}

	// Activity preceding either the effective last view or the acknowledgement has already been
	// viewed or accepted. At least one of them is set here, so since is never zero.
	since := baselineSince(viewedAt, hasAcked, ackedAt)

	// No update since the baseline: nothing is new, even if individual timestamps disagree.
	if !updatedAt.After(since) {
		return Activity{}
	}

	return contentActivity(item, since, currentUser, knownBots)
}

// contentActivity computes the content flags (everything but Acked and Item) for activity after
// since. A zero since treats all content as new.
func contentActivity(item *octodeckv1.Item, since time.Time, currentUser string, knownBots []string) Activity {
	return Activity{
		Mention: hasNewMention(item, since, currentUser),
		Comment: hasValidNewComments(item, since, currentUser, knownBots) ||
			hasValidNewReviews(item, since, currentUser, knownBots) ||
			hasValidNewStateEvents(item, since, currentUser, knownBots),
		Code:  hasValidNewCommits(item, since, currentUser),
		Noise: hasNoiseActivity(item, since, currentUser, knownBots),
	}
}

// Status returns the single highest-priority status for the card badge: ACKED, then a mention,
// then a never-viewed item, then new comments, new code, noise, and finally IDLE.
func (a Activity) Status() octodeckv1.ItemStatus {
	switch {
	case a.Acked:
		return octodeckv1.ItemStatus_ITEM_STATUS_ACKED
	case a.Mention:
		return octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION
	case a.Item:
		return octodeckv1.ItemStatus_ITEM_STATUS_NEW
	case a.Comment:
		return octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY
	case a.Code:
		return octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE
	case a.Noise:
		return octodeckv1.ItemStatus_ITEM_STATUS_NOISE
	default:
		return octodeckv1.ItemStatus_ITEM_STATUS_IDLE
	}
}

// Any reports whether the item matches the new:any wildcard: a new item, mention, comment or code.
// Noise is never part of the wildcard, so items with only noise are "nothing worth looking at".
func (a Activity) Any() bool {
	return a.Item || a.Mention || a.Comment || a.Code
}
