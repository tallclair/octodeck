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

	var events []event

	// 1. Process Comments
	for _, comment := range item.GetComments() {
		author := comment.GetAuthor().GetLogin()
		// Own comments are always significant events regardless of slash commands.
		// Comments by others that explicitly @mention currentUser or are non-noise are also significant.
		if isSameUser(author, currentUser) || !IsNoiseForUser(comment, knownBots, currentUser) {
			if comment.GetCreatedAt() != nil {
				events = append(events, event{
					timestamp: comment.GetCreatedAt().AsTime(),
					author:    author,
				})
			}
		}
	}

	// 2. Process Reviews & Review Comments
	for _, review := range item.GetReviews() {
		events = appendReviewEvents(events, review, currentUser, knownBots)
	}

	// 3. Process StateEvents
	for _, se := range item.GetStateEvents() {
		if se.GetCreatedAt() != nil && se.GetActor() != nil {
			events = append(events, event{
				timestamp: se.GetCreatedAt().AsTime(),
				author:    se.GetActor().GetLogin(),
			})
		}
	}

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

func appendReviewEvents(
	events []event,
	review *octodeckv1.Review,
	currentUser string,
	knownBots []string,
) []event {
	reviewAuthor := review.GetAuthor().GetLogin()
	var reviewTime time.Time
	if review.GetSubmittedAt() != nil {
		reviewTime = review.GetSubmittedAt().AsTime()
		events = append(events, event{
			timestamp: reviewTime,
			author:    reviewAuthor,
		})
	}

	for _, rc := range review.GetComments() {
		rcTime := effectiveReviewCommentTime(reviewTime, rc)
		if rcTime.IsZero() {
			continue
		}
		rcAuthor := rc.GetAuthor().GetLogin()
		rcType := rc.GetAuthor().GetType()
		if rcAuthor == "" {
			rcAuthor = reviewAuthor
			rcType = review.GetAuthor().GetType()
		}
		if isSameUser(rcAuthor, currentUser) ||
			ContainsMention(rc.GetBody(), currentUser) ||
			!IsBot(rcAuthor, rcType, knownBots) {
			events = append(events, event{
				timestamp: rcTime,
				author:    rcAuthor,
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
