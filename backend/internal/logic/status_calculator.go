package logic

import (
	"time"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// CalculateStatus derives the status of an item based on its history and user interaction.
func CalculateStatus(item *octodeckv1.Item, currentUser string, knownBots []string) octodeckv1.ItemStatus {
	hasAcked := item.GetLocal().GetAckedAt() != nil && item.GetLocal().GetAckedAt().GetSeconds() > 0
	var ackedAt time.Time
	updatedAt := item.GetUpdatedAt().AsTime()

	if hasAcked {
		ackedAt = item.GetLocal().GetAckedAt().AsTime()

		// 1. Fast-path: if not updated since acked, it remains Acked.
		if !updatedAt.After(ackedAt) {
			return octodeckv1.ItemStatus_ITEM_STATUS_ACKED
		}

		// Check if subsequent non-noise comments, PR reviews, state events, or commits un-ack the item.
		// If none occurred, the item remains Acked.
		if !hasValidNewComments(item, ackedAt, currentUser, knownBots) &&
			!hasValidNewReviews(item, ackedAt, currentUser, knownBots) &&
			!hasValidNewStateEvents(item, ackedAt, currentUser) &&
			!hasNewCommits(item, ackedAt) {
			return octodeckv1.ItemStatus_ITEM_STATUS_ACKED
		}
	}

	// 1. Never before seen => New (blue)
	hasViewed := item.GetLocal().GetLastViewedAt() != nil && item.GetLocal().GetLastViewedAt().GetSeconds() > 0
	if !hasViewed && !hasAcked {
		return octodeckv1.ItemStatus_ITEM_STATUS_NEW
	}

	// Determine baseline timestamp "since" for what constitutes new activity to the user.
	// Activity preceding either last view or acknowledge has already been viewed or accepted.
	var since time.Time
	if hasViewed {
		since = item.GetLocal().GetLastViewedAt().AsTime()
	}
	if hasAcked && (since.IsZero() || ackedAt.After(since)) {
		since = ackedAt
	}

	// If no updates since baseline
	if !updatedAt.After(since) {
		return octodeckv1.ItemStatus_ITEM_STATUS_IDLE
	}

	// 2. New non-noise comments, PR reviews, OR state events => New Activity (yellow/orange)
	if hasValidNewComments(item, since, currentUser, knownBots) ||
		hasValidNewReviews(item, since, currentUser, knownBots) ||
		hasValidNewStateEvents(item, since, currentUser) {
		return octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY
	}

	// 3. New commit pushed => New Commit (green)
	if hasNewCommits(item, since) {
		return octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE
	}

	// 4. New noise comments => Noise (grey, faded)
	if hasNoiseActivity(item, since, currentUser, knownBots) {
		return octodeckv1.ItemStatus_ITEM_STATUS_NOISE
	}

	// 5. Idle (no display)
	return octodeckv1.ItemStatus_ITEM_STATUS_IDLE
}

func hasNoiseActivity(item *octodeckv1.Item, since time.Time, currentUser string, knownBots []string) bool {
	for _, c := range item.GetComments() {
		if c.GetCreatedAt() != nil && c.GetCreatedAt().AsTime().After(since) {
			author := c.GetAuthor().GetLogin()
			if author != currentUser && IsNoise(c, knownBots) {
				return true
			}
		}
	}
	for _, r := range item.GetReviews() {
		if r.GetSubmittedAt() != nil && r.GetSubmittedAt().AsTime().After(since) {
			author := r.GetAuthor().GetLogin()
			if author != currentUser && IsBot(author, r.GetAuthor().GetType(), knownBots) {
				return true
			}
		}
	}
	return false
}

func hasValidNewReviews(item *octodeckv1.Item, since time.Time, currentUser string, knownBots []string) bool {
	for _, r := range item.GetReviews() {
		if r.GetSubmittedAt() != nil && r.GetSubmittedAt().AsTime().After(since) {
			author := r.GetAuthor().GetLogin()
			if author != currentUser && !IsBot(author, r.GetAuthor().GetType(), knownBots) {
				return true
			}
		}
	}
	return false
}

func hasNewCommits(item *octodeckv1.Item, since time.Time) bool {
	for _, c := range item.GetCommits() {
		if c.GetCommittedDate() != nil && c.GetCommittedDate().AsTime().After(since) {
			return true
		}
	}
	return false
}

func hasValidNewComments(item *octodeckv1.Item, since time.Time, currentUser string, knownBots []string) bool {
	for _, c := range item.GetComments() {
		if c.GetCreatedAt() != nil && c.GetCreatedAt().AsTime().After(since) {
			author := c.GetAuthor().GetLogin()
			if author != currentUser && !IsNoise(c, knownBots) {
				return true
			}
		}
	}
	return false
}

func hasValidNewStateEvents(item *octodeckv1.Item, since time.Time, currentUser string) bool {
	for _, e := range item.GetStateEvents() {
		if e.GetCreatedAt() != nil && e.GetCreatedAt().AsTime().After(since) {
			if e.GetActor().GetLogin() != currentUser {
				return true
			}
		}
	}
	return false
}
