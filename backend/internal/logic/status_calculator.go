package logic

import (
	"regexp"
	"strings"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

var (
	htmlCommentRegex     = regexp.MustCompile("(?s)<!--.*?-->")
	fencedCodeBlockRegex = regexp.MustCompile("(?s)```.*?```|~~~.*?~~~")
	blockquoteLineRegex  = regexp.MustCompile(`(?m)^\s*>.*$`)
)

// CalculateStatus derives the status of an item based on its history and user interaction.
func CalculateStatus(item *octodeckv1.Item, currentUser string, knownBots []string) octodeckv1.ItemStatus {
	hasAcked := IsAcked(item.GetLocal())
	// ackedAt is the activity watermark (GitHub clock), not the time the ack happened.
	var ackedAt time.Time
	updatedAt := item.GetUpdatedAt().AsTime()

	if hasAcked {
		ackedAt = AckedActivityAt(item.GetLocal())
		if remainsAcked(item, ackedAt, updatedAt, currentUser, knownBots) {
			return octodeckv1.ItemStatus_ITEM_STATUS_ACKED
		}
	}

	// The user has seen everything up to their own latest activity (including authoring the item),
	// so own activity always counts as viewed, whether or not auto-ack is enabled.
	viewedAt := EffectiveLastViewedAt(item, currentUser)
	hasViewed := !viewedAt.IsZero()

	// 1. Never before seen => New Mention if explicitly mentioned, otherwise New (blue).
	if !hasViewed && !hasAcked {
		if hasNewMention(item, time.Time{}, currentUser) {
			return octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION
		}
		return octodeckv1.ItemStatus_ITEM_STATUS_NEW
	}

	// Determine baseline timestamp "since" for what constitutes new activity to the user.
	// Activity preceding either the effective last view or the acknowledgement has already been
	// viewed or accepted. At least one of them is set here, so since is never zero.
	since := baselineSince(viewedAt, hasAcked, ackedAt)

	// If no updates since baseline
	if !updatedAt.After(since) {
		return octodeckv1.ItemStatus_ITEM_STATUS_IDLE
	}

	// 2. Explicit @mention of the authenticated user in new comments or reviews => New Mention (highest priority)
	if hasNewMention(item, since, currentUser) {
		return octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION
	}

	// 3. New non-noise comments, PR reviews, OR state events => New Activity (yellow/orange)
	if hasValidNewComments(item, since, currentUser, knownBots) ||
		hasValidNewReviews(item, since, currentUser, knownBots) ||
		hasValidNewStateEvents(item, since, currentUser, knownBots) {
		return octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY
	}

	// 4. New commit pushed => New Commit (green)
	if hasValidNewCommits(item, since, currentUser) {
		return octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE
	}

	// 5. New noise comments => Noise (grey, faded)
	if hasNoiseActivity(item, since, currentUser, knownBots) {
		return octodeckv1.ItemStatus_ITEM_STATUS_NOISE
	}

	// 6. Idle (no display)
	return octodeckv1.ItemStatus_ITEM_STATUS_IDLE
}

func remainsAcked(
	item *octodeckv1.Item,
	ackedAt, updatedAt time.Time,
	currentUser string,
	knownBots []string,
) bool {
	// Fast-path: if not updated since acked, it remains Acked.
	if !updatedAt.After(ackedAt) {
		return true
	}

	// Check if subsequent mentions, non-noise comments, PR reviews, state events, or commits un-ack the item.
	return !hasNewMention(item, ackedAt, currentUser) &&
		!hasValidNewComments(item, ackedAt, currentUser, knownBots) &&
		!hasValidNewReviews(item, ackedAt, currentUser, knownBots) &&
		!hasValidNewStateEvents(item, ackedAt, currentUser, knownBots) &&
		!hasValidNewCommits(item, ackedAt, currentUser)
}

// baselineSince returns the later of the effective last-viewed time and, if acked, the ack
// watermark.
func baselineSince(viewedAt time.Time, hasAcked bool, ackedAt time.Time) time.Time {
	since := viewedAt
	if hasAcked && ackedAt.After(since) {
		since = ackedAt
	}
	return since
}

func isSameUser(a, b string) bool {
	cleanA := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(a), "@"))
	cleanB := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(b), "@"))
	return cleanA != "" && cleanB != "" && strings.EqualFold(cleanA, cleanB)
}

func isUsernameChar(b byte) bool {
	return (b >= 'a' && b <= 'z') ||
		(b >= 'A' && b <= 'Z') ||
		(b >= '0' && b <= '9') ||
		b == '-' || b == '_'
}

func isValidMentionPrefix(b byte) bool {
	return !isUsernameChar(b) && b != '@' && b != '/' && b != '.'
}

func isValidMentionSuffix(s string, end int) bool {
	b := s[end]
	if isUsernameChar(b) || b == '@' || b == '/' {
		return false
	}
	if b == '.' && end+1 < len(s) && isUsernameChar(s[end+1]) {
		return false
	}
	return true
}

func stripInlineCodeSpans(s string) string {
	if !strings.ContainsRune(s, '`') {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	i := 0
	for i < len(s) {
		if s[i] != '`' {
			b.WriteByte(s[i])
			i++
			continue
		}
		runStart := i
		for i < len(s) && s[i] == '`' {
			i++
		}
		runLen := i - runStart

		closeEnd := findClosingBacktickRun(s, i, runLen)
		if closeEnd != -1 {
			b.WriteByte(' ')
			i = closeEnd
		} else {
			b.WriteString(s[runStart:i])
		}
	}
	return b.String()
}

func findClosingBacktickRun(s string, start, targetLen int) int {
	j := start
	for j < len(s) && s[j] != '\n' {
		if s[j] != '`' {
			j++
			continue
		}
		runStart := j
		for j < len(s) && s[j] == '`' {
			j++
		}
		if j-runStart == targetLen {
			return j
		}
	}
	return -1
}

// ContainsMention returns true if text contains an explicit @mention of username
// outside of HTML comments, fenced code blocks, blockquotes, and inline code spans.
func ContainsMention(text, username string) bool {
	cleanUser := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	if cleanUser == "" || text == "" {
		return false
	}

	cleaned := htmlCommentRegex.ReplaceAllString(text, " ")
	cleaned = fencedCodeBlockRegex.ReplaceAllString(cleaned, " ")
	cleaned = blockquoteLineRegex.ReplaceAllString(cleaned, " ")
	cleaned = stripInlineCodeSpans(cleaned)

	lowerText := strings.ToLower(cleaned)
	target := "@" + strings.ToLower(cleanUser)

	offset := 0
	for offset < len(lowerText) {
		idx := strings.Index(lowerText[offset:], target)
		if idx == -1 {
			break
		}
		start := offset + idx
		end := start + len(target)

		validPrefix := start == 0 || isValidMentionPrefix(lowerText[start-1])
		validSuffix := end == len(lowerText) || isValidMentionSuffix(lowerText, end)
		if validPrefix && validSuffix {
			return true
		}
		offset = start + 1
	}

	return false
}

func isTimestampNew(ts *timestamppb.Timestamp, since time.Time) bool {
	if since.IsZero() {
		return true
	}
	return ts != nil && ts.AsTime().After(since)
}

func hasNewMention(item *octodeckv1.Item, since time.Time, currentUser string) bool {
	if strings.TrimSpace(currentUser) == "" {
		return false
	}

	if isTimestampNew(item.GetCreatedAt(), since) &&
		!isSameUser(item.GetAuthor().GetLogin(), currentUser) &&
		ContainsMention(item.GetBody(), currentUser) {
		return true
	}

	for _, c := range item.GetComments() {
		if c.GetCreatedAt() != nil && isTimestampNew(c.GetCreatedAt(), since) {
			author := c.GetAuthor().GetLogin()
			if !isSameUser(author, currentUser) && ContainsMention(c.GetBodyText(), currentUser) {
				return true
			}
		}
	}

	for _, r := range item.GetReviews() {
		if !isPendingReview(r) && reviewHasNewMention(r, since, currentUser) {
			return true
		}
	}

	return false
}

func reviewHasNewMention(r *octodeckv1.Review, since time.Time, currentUser string) bool {
	reviewIsNew := r.GetSubmittedAt() != nil && isTimestampNew(r.GetSubmittedAt(), since)
	reviewAuthor := r.GetAuthor().GetLogin()
	if reviewIsNew && !isSameUser(reviewAuthor, currentUser) && ContainsMention(r.GetBody(), currentUser) {
		return true
	}

	for _, rc := range r.GetComments() {
		if reviewCommentHasNewMention(rc, reviewAuthor, reviewIsNew, since, currentUser) {
			return true
		}
	}
	return false
}

func reviewCommentHasNewMention(
	rc *octodeckv1.ReviewComment,
	reviewAuthor string,
	reviewIsNew bool,
	since time.Time,
	currentUser string,
) bool {
	rcIsNew := reviewIsNew || (rc.GetCreatedAt() != nil && isTimestampNew(rc.GetCreatedAt(), since))
	if !rcIsNew {
		return false
	}
	rcAuthor := rc.GetAuthor().GetLogin()
	if rcAuthor == "" {
		rcAuthor = reviewAuthor
	}
	return !isSameUser(rcAuthor, currentUser) && ContainsMention(rc.GetBody(), currentUser)
}

func hasNoiseActivity(item *octodeckv1.Item, since time.Time, currentUser string, knownBots []string) bool {
	for _, c := range item.GetComments() {
		if c.GetCreatedAt() != nil && c.GetCreatedAt().AsTime().After(since) &&
			!isSameUser(c.GetAuthor().GetLogin(), currentUser) && IsNoiseForUser(c, knownBots, currentUser) {
			return true
		}
	}
	for _, r := range item.GetReviews() {
		if !isPendingReview(r) && reviewHasNoiseActivity(r, since, currentUser, knownBots) {
			return true
		}
	}
	for _, e := range item.GetStateEvents() {
		if e.GetCreatedAt() != nil && e.GetCreatedAt().AsTime().After(since) &&
			!isSameUser(e.GetActor().GetLogin(), currentUser) && isBotStateEvent(e, knownBots) {
			return true
		}
	}
	return false
}

func reviewHasNoiseActivity(
	r *octodeckv1.Review,
	since time.Time,
	currentUser string,
	knownBots []string,
) bool {
	if r.GetSubmittedAt() != nil && r.GetSubmittedAt().AsTime().After(since) &&
		isReviewActivityNoise(r.GetAuthor(), r.GetBody(), currentUser, knownBots) {
		return true
	}
	for _, rc := range r.GetComments() {
		if rc.GetCreatedAt() != nil && rc.GetCreatedAt().AsTime().After(since) &&
			isReviewActivityNoise(reviewCommentAuthor(rc, r), rc.GetBody(), currentUser, knownBots) {
			return true
		}
	}
	return false
}

func hasValidNewReviews(item *octodeckv1.Item, since time.Time, currentUser string, knownBots []string) bool {
	for _, r := range item.GetReviews() {
		if !isPendingReview(r) && reviewHasValidNewActivity(r, since, currentUser, knownBots) {
			return true
		}
	}
	return false
}

func reviewHasValidNewActivity(
	r *octodeckv1.Review,
	since time.Time,
	currentUser string,
	knownBots []string,
) bool {
	if r.GetSubmittedAt() != nil && r.GetSubmittedAt().AsTime().After(since) &&
		isOthersSignificantReviewActivity(r.GetAuthor(), r.GetBody(), currentUser, knownBots) {
		return true
	}
	for _, rc := range r.GetComments() {
		if rc.GetCreatedAt() != nil && rc.GetCreatedAt().AsTime().After(since) &&
			isOthersSignificantReviewActivity(reviewCommentAuthor(rc, r), rc.GetBody(), currentUser, knownBots) {
			return true
		}
	}
	return false
}

// reviewCommentAuthor returns the author of a review comment, falling back to the review's author
// when the comment carries none.
func reviewCommentAuthor(rc *octodeckv1.ReviewComment, r *octodeckv1.Review) *octodeckv1.User {
	if rc.GetAuthor().GetLogin() == "" {
		return r.GetAuthor()
	}
	return rc.GetAuthor()
}

// isReviewActivityNoise reports whether a submitted review or review comment is noise for
// currentUser: written by a bot other than currentUser without @mentioning currentUser. The status
// calculator and ShouldAutoAck share this predicate so they agree on which review activity counts.
func isReviewActivityNoise(author *octodeckv1.User, body, currentUser string, knownBots []string) bool {
	login := author.GetLogin()
	return !isSameUser(login, currentUser) &&
		IsBot(login, author.GetType(), knownBots) &&
		!ContainsMention(body, currentUser)
}

// isOthersSignificantReviewActivity reports whether review activity by someone other than
// currentUser is significant (not noise), and therefore supersedes an acknowledgement.
func isOthersSignificantReviewActivity(
	author *octodeckv1.User,
	body, currentUser string,
	knownBots []string,
) bool {
	return !isSameUser(author.GetLogin(), currentUser) && !isReviewActivityNoise(author, body, currentUser, knownBots)
}

// hasValidNewCommits reports whether commits after since count as new code or supersede an
// acknowledgement. Commits authored by currentUser are the user's own activity and never count as
// unviewed activity, regardless of who opened the PR; commits by anyone else (maintainers, bots)
// do. A commit whose author isn't linked to a GitHub login can't be attributed to the user, so it
// counts as new code rather than risk hiding someone else's work.
func hasValidNewCommits(item *octodeckv1.Item, since time.Time, currentUser string) bool {
	for _, c := range item.GetCommits() {
		if c.GetCommittedDate() == nil || !c.GetCommittedDate().AsTime().After(since) {
			continue
		}
		if isSameUser(c.GetAuthorLogin(), currentUser) {
			continue
		}
		return true
	}
	return false
}

func hasValidNewComments(item *octodeckv1.Item, since time.Time, currentUser string, knownBots []string) bool {
	for _, c := range item.GetComments() {
		if c.GetCreatedAt() != nil && c.GetCreatedAt().AsTime().After(since) &&
			isOthersSignificantComment(c, currentUser, knownBots) {
			return true
		}
	}
	return false
}

// isOthersSignificantComment reports whether a comment by someone other than currentUser is
// significant (not a bot comment or slash command, unless it @mentions currentUser).
func isOthersSignificantComment(c *octodeckv1.Comment, currentUser string, knownBots []string) bool {
	return !isSameUser(c.GetAuthor().GetLogin(), currentUser) && !IsNoiseForUser(c, knownBots, currentUser)
}

func hasValidNewStateEvents(item *octodeckv1.Item, since time.Time, currentUser string, knownBots []string) bool {
	for _, e := range item.GetStateEvents() {
		if e.GetCreatedAt() != nil && e.GetCreatedAt().AsTime().After(since) &&
			isOthersSignificantStateEvent(e, currentUser, knownBots) {
			return true
		}
	}
	return false
}

// isOthersSignificantStateEvent reports whether a state event performed by someone other than
// currentUser supersedes an acknowledgement.
func isOthersSignificantStateEvent(e *octodeckv1.StateEvent, currentUser string, knownBots []string) bool {
	return !isSameUser(e.GetActor().GetLogin(), currentUser) && !isBotStateEvent(e, knownBots)
}

// isBotStateEvent reports whether a state event was performed by a bot. Bots typically act on a
// human's command (e.g. Prow assigning, closing or merging after "/assign", "/close" or
// "/approve"), so these events are treated as noise rather than as new activity.
func isBotStateEvent(e *octodeckv1.StateEvent, knownBots []string) bool {
	actor := e.GetActor()
	return actor != nil && IsBot(actor.GetLogin(), actor.GetType(), knownBots)
}
