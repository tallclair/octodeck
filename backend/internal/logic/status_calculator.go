package logic

import (
	"time"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// StatusResult contains the result of the status calculation.
type StatusResult struct {
	Status           octodeckv1.ItemStatus
	NewCommitsCount  int
	NewCommentsCount int
}

// CalculateStatus derives the status of an item based on its history and user interaction.
func CalculateStatus(item *octodeckv1.Item, currentUser string, knownBots []string) StatusResult {
	// Check if item is Acked (acked_at set and no subsequent non-noise activity)
	if item.GetLocal().GetAckedAt() != nil && item.GetLocal().GetAckedAt().GetSeconds() > 0 {
		ackedAt := item.GetLocal().GetAckedAt().AsTime()

		// Priority 2: New non-noise comments, PR reviews, or state events un-ack to NEW_ACTIVITY
		newCommentsCount := countValidNewCommentsAfterAck(item, ackedAt, currentUser, knownBots)
		newReviewsCount := countValidNewReviewsAfterAck(item, ackedAt, currentUser, knownBots)
		newStateEventsCount := countValidNewStateEvents(item, ackedAt, currentUser)
		if newCommentsCount > 0 || newReviewsCount > 0 || newStateEventsCount > 0 {
			return StatusResult{
				Status:           octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY,
				NewCommentsCount: newCommentsCount + newReviewsCount + newStateEventsCount,
			}
		}

		// Priority 3: New commits un-ack to NEW_CODE
		newCommitsCount := countNewCommits(item, ackedAt)
		if newCommitsCount > 0 {
			return StatusResult{
				Status:          octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE,
				NewCommitsCount: newCommitsCount,
			}
		}

		return StatusResult{Status: octodeckv1.ItemStatus_ITEM_STATUS_ACKED}
	}

	// 1. Never before seen => New (blue)
	if item.GetLocal().GetLastViewedAt() == nil || item.GetLocal().GetLastViewedAt().GetSeconds() == 0 {
		return StatusResult{Status: octodeckv1.ItemStatus_ITEM_STATUS_NEW}
	}

	lastViewedAt := item.GetLocal().GetLastViewedAt().AsTime()
	updatedAt := item.GetUpdatedAt().AsTime()

	// If no updates since last view
	if !updatedAt.After(lastViewedAt) {
		return StatusResult{Status: octodeckv1.ItemStatus_ITEM_STATUS_IDLE}
	}

	// 2. New non-noise comments, PR reviews, OR state events => New Activity (yellow/orange)
	newCommentsCount := countValidNewComments(item, lastViewedAt, currentUser, knownBots)
	newReviewsCount := countValidNewReviews(item, lastViewedAt, currentUser, knownBots)
	newStateEventsCount := countValidNewStateEvents(item, lastViewedAt, currentUser)
	if newCommentsCount > 0 || newReviewsCount > 0 || newStateEventsCount > 0 {
		return StatusResult{
			Status:           octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY,
			NewCommentsCount: newCommentsCount + newReviewsCount + newStateEventsCount,
		}
	}

	// 3. New commit pushed => New Commit (green)
	newCommitsCount := countNewCommits(item, lastViewedAt)
	if newCommitsCount > 0 {
		return StatusResult{
			Status:          octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE,
			NewCommitsCount: newCommitsCount,
		}
	}

	// 4. New noise comments => Noise (grey, faded)
	newNoiseCount := countNoiseActivity(item, lastViewedAt, currentUser, knownBots)
	if newNoiseCount > 0 {
		return StatusResult{
			Status:           octodeckv1.ItemStatus_ITEM_STATUS_NOISE,
			NewCommentsCount: newNoiseCount,
		}
	}

	// 5. Idle (no display)
	return StatusResult{Status: octodeckv1.ItemStatus_ITEM_STATUS_IDLE}
}

func countNoiseActivity(item *octodeckv1.Item, lastViewedAt time.Time, currentUser string, knownBots []string) int {
	count := 0
	for _, c := range item.GetComments() {
		if c.GetCreatedAt() != nil && c.GetCreatedAt().AsTime().After(lastViewedAt) {
			author := c.GetAuthor().GetLogin()
			if author != currentUser && IsNoise(c, knownBots) {
				count++
			}
		}
	}
	for _, r := range item.GetReviews() {
		if r.GetSubmittedAt() != nil && r.GetSubmittedAt().AsTime().After(lastViewedAt) {
			author := r.GetAuthor().GetLogin()
			if author != currentUser && IsBot(author, r.GetAuthor().GetType(), knownBots) {
				count++
			}
		}
	}
	return count
}

func countValidNewCommentsAfterAck(
	item *octodeckv1.Item, ackedAt time.Time, currentUser string, knownBots []string,
) int {
	count := 0
	for _, c := range item.GetComments() {
		if c.GetCreatedAt() != nil && c.GetCreatedAt().AsTime().After(ackedAt) {
			author := c.GetAuthor().GetLogin()
			if author != currentUser && !IsNoise(c, knownBots) {
				count++
			}
		}
	}
	return count
}

func countValidNewReviewsAfterAck(
	item *octodeckv1.Item, ackedAt time.Time, currentUser string, knownBots []string,
) int {
	count := 0
	for _, r := range item.GetReviews() {
		if r.GetSubmittedAt() != nil && r.GetSubmittedAt().AsTime().After(ackedAt) {
			author := r.GetAuthor().GetLogin()
			if author != currentUser && !IsBot(author, r.GetAuthor().GetType(), knownBots) {
				count++
			}
		}
	}
	return count
}

func countValidNewReviews(item *octodeckv1.Item, lastViewedAt time.Time, currentUser string, knownBots []string) int {
	count := 0
	for _, r := range item.GetReviews() {
		if r.GetSubmittedAt() != nil && r.GetSubmittedAt().AsTime().After(lastViewedAt) {
			author := r.GetAuthor().GetLogin()
			if author != currentUser && !IsBot(author, r.GetAuthor().GetType(), knownBots) {
				count++
			}
		}
	}
	return count
}

func countNewCommits(item *octodeckv1.Item, lastViewedAt time.Time) int {
	count := 0
	for _, c := range item.GetCommits() {
		if c.GetCommittedDate() != nil && c.GetCommittedDate().AsTime().After(lastViewedAt) {
			count++
		}
	}
	return count
}

func countValidNewComments(item *octodeckv1.Item, lastViewedAt time.Time, currentUser string, knownBots []string) int {
	count := 0
	for _, c := range item.GetComments() {
		if c.GetCreatedAt() != nil && c.GetCreatedAt().AsTime().After(lastViewedAt) {
			author := c.GetAuthor().GetLogin()
			if author != currentUser && !IsNoise(c, knownBots) {
				count++
			}
		}
	}
	return count
}

func countValidNewStateEvents(item *octodeckv1.Item, since time.Time, currentUser string) int {
	count := 0
	for _, e := range item.GetStateEvents() {
		if e.GetCreatedAt() != nil && e.GetCreatedAt().AsTime().After(since) {
			if e.GetActor().GetLogin() != currentUser {
				count++
			}
		}
	}
	return count
}
