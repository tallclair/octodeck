package logic

import (
	"sort"
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
	if currentUser == "" {
		return false, time.Time{}
	}

	var events []event

	// 1. Process Comments
	for _, comment := range item.GetComments() {
		author := comment.GetAuthor().GetLogin()
		// Own comments are always significant events regardless of slash commands.
		// For comments by others, filter out noise (bot authors or slash commands).
		if author == currentUser || !IsNoise(comment, knownBots) {
			if comment.GetCreatedAt() != nil {
				events = append(events, event{
					timestamp: comment.GetCreatedAt().AsTime(),
					author:    author,
				})
			}
		}
	}

	// 2. Process Reviews
	for _, review := range item.GetReviews() {
		if review.GetSubmittedAt() != nil {
			events = append(events, event{
				timestamp: review.GetSubmittedAt().AsTime(),
				author:    review.GetAuthor().GetLogin(),
			})
		}
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

	// Sort events by timestamp descending (newest first)
	sort.Slice(events, func(i, j int) bool {
		return events[i].timestamp.After(events[j].timestamp)
	})

	lastEvent := events[0]

	if lastEvent.author == currentUser {
		return true, lastEvent.timestamp
	}

	return false, time.Time{}
}
