package logic

import (
	"sort"
	"strings"
	"time"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

type event struct {
	timestamp time.Time
	author    string
}

// ShouldAutoAck determines if an item should be automatically acknowledged
// based on whether the last significant action was performed by the current user.
// Returns whether to auto-ack and the timestamp of the action.
func ShouldAutoAck(item *octodeckv1.Item, currentUser string, knownBots []string) (bool, time.Time) {
	if strings.TrimSpace(currentUser) == "" {
		return false, time.Time{}
	}

	// An event is significant if the user performed it, or if it would supersede an
	// acknowledgement according to the status calculator. Sharing the predicates keeps the two in
	// agreement: noise (bot comments, slash commands, bot reviews and review comments, bot state
	// events) never blocks auto-acking the user's own action.
	var events []event

	// Opening the item is its first event. An item the user opened is acknowledged at creation
	// unless someone else has acted on it since; for items opened by others it is just an earlier
	// event that the user's own later activity supersedes.
	if validTimestamp(item.GetCreatedAt()) {
		events = append(events, event{
			timestamp: item.GetCreatedAt().AsTime(),
			author:    item.GetAuthor().GetLogin(),
		})
	}

	events = appendCommentEvents(events, item, currentUser, knownBots)

	// Unsubmitted (pending) reviews are only visible to their author and are not activity yet.
	for _, review := range item.GetReviews() {
		if isPendingReview(review) {
			continue
		}
		events = appendReviewEvents(events, review, currentUser, knownBots)
	}

	events = appendStateEventEvents(events, item, currentUser, knownBots)

	if len(events) == 0 {
		return false, time.Time{}
	}

	// Sort events by timestamp descending (newest first).
	// Break timestamp ties by placing non-currentUser events first so simultaneous external activity prevents auto-ack.
	sort.Slice(events, func(i, j int) bool {
		if events[i].timestamp.Equal(events[j].timestamp) {
			return !isSameUser(events[i].author, currentUser) && isSameUser(events[j].author, currentUser)
		}
		return events[i].timestamp.After(events[j].timestamp)
	})

	lastEvent := events[0]

	if isSameUser(lastEvent.author, currentUser) {
		return true, lastEvent.timestamp
	}

	return false, time.Time{}
}

func appendCommentEvents(events []event, item *octodeckv1.Item, currentUser string, knownBots []string) []event {
	for _, comment := range item.GetComments() {
		author := comment.GetAuthor().GetLogin()
		if comment.GetCreatedAt() != nil &&
			(isSameUser(author, currentUser) || isOthersSignificantComment(comment, currentUser, knownBots)) {
			events = append(events, event{
				timestamp: comment.GetCreatedAt().AsTime(),
				author:    author,
			})
		}
	}
	return events
}

// appendStateEventEvents collects significant state events. Bot-performed events (e.g. Prow
// merging after the user's "/approve") are noise and must not block auto-acking the user's own
// triggering action.
func appendStateEventEvents(events []event, item *octodeckv1.Item, currentUser string, knownBots []string) []event {
	for _, se := range item.GetStateEvents() {
		if se.GetCreatedAt() == nil || se.GetActor() == nil {
			continue
		}
		actor := se.GetActor().GetLogin()
		if isSameUser(actor, currentUser) || isOthersSignificantStateEvent(se, currentUser, knownBots) {
			events = append(events, event{
				timestamp: se.GetCreatedAt().AsTime(),
				author:    actor,
			})
		}
	}
	return events
}

func appendReviewEvents(
	events []event,
	review *octodeckv1.Review,
	currentUser string,
	knownBots []string,
) []event {
	isSignificant := func(author *octodeckv1.User, body string) bool {
		return isSameUser(author.GetLogin(), currentUser) ||
			isOthersSignificantReviewActivity(author, body, currentUser, knownBots)
	}

	var reviewTime time.Time
	if review.GetSubmittedAt() != nil {
		reviewTime = review.GetSubmittedAt().AsTime()
		if isSignificant(review.GetAuthor(), review.GetBody()) {
			events = append(events, event{
				timestamp: reviewTime,
				author:    review.GetAuthor().GetLogin(),
			})
		}
	}

	for _, rc := range review.GetComments() {
		rcTime := effectiveReviewCommentTime(reviewTime, rc)
		if rcTime.IsZero() {
			continue
		}
		rcAuthor := reviewCommentAuthor(rc, review)
		if isSignificant(rcAuthor, rc.GetBody()) {
			events = append(events, event{
				timestamp: rcTime,
				author:    rcAuthor.GetLogin(),
			})
		}
	}

	return events
}

func effectiveReviewCommentTime(reviewTime time.Time, rc *octodeckv1.ReviewComment) time.Time {
	if rc.GetCreatedAt() == nil {
		return reviewTime
	}
	created := rc.GetCreatedAt().AsTime()
	if reviewTime.IsZero() || created.After(reviewTime) {
		return created
	}
	return reviewTime
}
