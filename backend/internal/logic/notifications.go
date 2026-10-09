package logic

import (
	"fmt"
	"net/url"
	"strconv"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

// Notifications are decided when sync reconciles a freshly fetched item with its stored copy.
// Only events that the stored copy didn't have can notify, so the same activity never notifies
// twice and no notification state needs to be persisted. Events at or before the status baseline
// (the later of the effective last-viewed time and the ack watermark) never notify, which excludes
// everything the user has viewed, acknowledged, or done themselves.

// eventKind classifies a single event for notification purposes, mirroring the predicates the
// status calculator uses.
type eventKind int

const (
	eventNoise eventKind = iota
	eventCode
	eventActivity
	eventMention
)

// itemEvent is a single timestamped event on an item.
type itemEvent struct {
	key  string
	at   time.Time
	kind eventKind
	// own is true when the authenticated user performed the event.
	own bool
}

// NotificationDecision is the result of EvaluateNotification.
type NotificationDecision struct {
	// Category is NOTIFICATION_CATEGORY_UNSPECIFIED when nothing should be sent.
	Category octodeckv1.NotificationCategory
	// NewestEventAt is the time of the newest new event (or the item creation for a new item).
	NewestEventAt time.Time
}

// Notify reports whether a notification should be sent.
func (d NotificationDecision) Notify() bool {
	return d.Category != octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_UNSPECIFIED
}

// EvaluateNotification decides whether reconciling fetched with stored (nil if the item wasn't in
// the database) produces a notification at time now.
//
// New events are events in fetched whose identity is absent from stored, that became visible
// strictly after the status baseline, and that are newer than the stored copy's latest activity.
// The last rule keeps history that sync backfills later (comment gaps, older reviews, review
// comment pages) from notifying. Events are timed by when they became visible: a review comment
// counts from when its review was submitted, so comments drafted before a review was submitted
// still notify when it is.
//
// An item that wasn't stored, that the user has never seen, acked or acted on, and that was
// created within incrementalSyncLookback is a new item. Any other item that wasn't stored (e.g. an
// old item that was pruned, or imported for the first time because of new activity) only notifies
// for events within incrementalSyncLookback, under the activity categories.
func EvaluateNotification(
	stored, fetched *octodeckv1.Item,
	currentUser string,
	knownBots []string,
	settings *octodeckv1.NotificationSettings,
	now time.Time,
) NotificationDecision {
	none := NotificationDecision{}
	if fetched == nil || currentUser == "" || !settings.GetEnabled() {
		return none
	}

	baseline := notificationBaseline(fetched, currentUser)
	cutoff := baseline
	isNewItem := false
	if stored == nil {
		recent := now.Add(-incrementalSyncLookback)
		created := fetched.GetCreatedAt()
		isNewItem = baseline.IsZero() && validTimestamp(created) && created.AsTime().After(recent)
		if !isNewItem && recent.After(cutoff) {
			cutoff = recent
		}
	}
	c := collectNewEvents(stored, fetched, cutoff, currentUser, knownBots)

	if isNewItem {
		if isSameUser(fetched.GetAuthor().GetLogin(), currentUser) {
			return none
		}
		if ContainsMention(fetched.GetBody(), currentUser) {
			c.hasMention = true
		}
		if created := fetched.GetCreatedAt(); created.AsTime().After(c.newest) {
			c.newest = created.AsTime()
		}
	} else if !c.any() {
		return none
	}

	c.isNewItem = isNewItem
	c.passes = passesNotificationFilters(fetched, currentUser, settings)
	category := chooseNotificationCategory(c, settings)
	if category == octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_UNSPECIFIED {
		return none
	}
	return NotificationDecision{Category: category, NewestEventAt: c.newest}
}

type notificationCandidates struct {
	isNewItem                                  bool
	hasMention, hasActivity, hasCode, hasNoise bool
	// newest is the time of the newest new event.
	newest time.Time
	// passes reports whether the item passes the repo/label/author and assigned-or-authored
	// filters.
	passes bool
}

func (c notificationCandidates) any() bool {
	return c.hasMention || c.hasActivity || c.hasCode || c.hasNoise
}

// collectNewEvents classifies the events in fetched that are new relative to stored and that
// became visible after cutoff (see EvaluateNotification).
func collectNewEvents(
	stored, fetched *octodeckv1.Item,
	cutoff time.Time,
	currentUser string,
	knownBots []string,
) notificationCandidates {
	storedKeys := map[string]struct{}{}
	var storedLatest time.Time
	if stored != nil {
		for _, e := range itemEvents(stored, currentUser, knownBots) {
			storedKeys[e.key] = struct{}{}
		}
		storedLatest = LatestActivityTime(stored)
	}

	var c notificationCandidates
	for _, e := range itemEvents(fetched, currentUser, knownBots) {
		if e.own || !e.at.After(cutoff) || !e.at.After(storedLatest) {
			continue
		}
		if _, seen := storedKeys[e.key]; seen {
			continue
		}
		switch e.kind {
		case eventMention:
			c.hasMention = true
		case eventActivity:
			c.hasActivity = true
		case eventCode:
			c.hasCode = true
		case eventNoise:
			c.hasNoise = true
		}
		if e.at.After(c.newest) {
			c.newest = e.at
		}
	}
	return c
}

// chooseNotificationCategory maps candidate events to the highest-priority category the settings
// allow: mention > new item > activity > code > noise.
func chooseNotificationCategory(
	c notificationCandidates,
	s *octodeckv1.NotificationSettings,
) octodeckv1.NotificationCategory {
	// The flag that governs this item: new items vs. new activity on known items.
	kindEnabled := s.GetNotifyOnNewActivity()
	if c.isNewItem {
		kindEnabled = s.GetNotifyOnNewItems()
	}
	if c.hasMention && ((c.passes && kindEnabled) || s.GetAlwaysIncludeMentions()) {
		return octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_MENTION
	}
	if !c.passes || !kindEnabled {
		return octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_UNSPECIFIED
	}
	switch {
	case c.isNewItem:
		return octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_NEW_ITEM
	case c.hasActivity:
		return octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_ACTIVITY
	case c.hasCode:
		return octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_CODE
	case c.hasNoise && !s.GetIgnoreBots():
		return octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_NOISE
	}
	return octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_UNSPECIFIED
}

// notificationBaseline returns the status baseline: the later of the effective last-viewed time
// and, if acked, the ack watermark. Zero means the user has never seen the item.
func notificationBaseline(item *octodeckv1.Item, currentUser string) time.Time {
	local := item.GetLocal()
	return baselineSince(EffectiveLastViewedAt(item, currentUser), IsAcked(local), AckedActivityAt(local))
}

// passesNotificationFilters applies the repo, label and author include/exclude patterns and the
// only-assigned-or-authored setting.
func passesNotificationFilters(
	item *octodeckv1.Item,
	currentUser string,
	s *octodeckv1.NotificationSettings,
) bool {
	if !MatchesFilter(item.GetRepo(), s.GetRepoIncludes(), s.GetRepoExcludes()) {
		return false
	}
	labels := make([]string, 0, len(item.GetLabels()))
	for _, l := range item.GetLabels() {
		labels = append(labels, l.GetName())
	}
	if !MatchesAnyValueFilter(labels, s.GetLabelIncludes(), s.GetLabelExcludes()) {
		return false
	}
	if !MatchesFilter(item.GetAuthor().GetLogin(), s.GetAuthorIncludes(), s.GetAuthorExcludes()) {
		return false
	}
	return !s.GetOnlyAssignedOrAuthored() || isAssignedOrAuthored(item, currentUser)
}

func isAssignedOrAuthored(item *octodeckv1.Item, currentUser string) bool {
	if isSameUser(item.GetAuthor().GetLogin(), currentUser) {
		return true
	}
	for _, a := range item.GetAssignees() {
		if isSameUser(a.GetLogin(), currentUser) {
			return true
		}
	}
	return false
}

// itemEvents lists the item's timestamped events with stable identities. Pending reviews are not
// events. Comments, reviews and review comments are identified by their IDs (falling back to URL
// or timestamp and author); commits and state events have no IDs, so they use timestamp and author
// (and type), matching how sync deduplicates them.
func itemEvents(item *octodeckv1.Item, currentUser string, knownBots []string) []itemEvent {
	var events []itemEvent
	add := func(key string, ts *timestamppb.Timestamp, kind eventKind, actor string) {
		if !validTimestamp(ts) {
			return
		}
		events = append(events, itemEvent{key: key, at: ts.AsTime(), kind: kind, own: isSameUser(actor, currentUser)})
	}

	for _, c := range item.GetComments() {
		author := c.GetAuthor().GetLogin()
		id := c.GetCommentId()
		key := "comment:" + fallbackKey(strconv.FormatInt(id, 10), id == 0, c.GetCreatedAt(), author)
		add(key, c.GetCreatedAt(), classifyComment(c, currentUser, knownBots), author)
	}
	for _, r := range item.GetReviews() {
		if !isPendingReview(r) {
			addReviewEvents(r, currentUser, knownBots, add)
		}
	}
	for _, c := range item.GetCommits() {
		// committedDate is set on the committer's machine, so commits pushed long after they were
		// written (e.g. older than the item's latest comment) are not "newer than the stored latest
		// activity" and don't notify. GitHub doesn't expose the push time on the commit.
		kind := eventCode
		if IsBot(c.GetAuthorLogin(), octodeckv1.UserType_USER_TYPE_UNSPECIFIED, knownBots) {
			kind = eventNoise
		}
		add("commit:"+fallbackKey("", true, c.GetCommittedDate(), c.GetAuthorLogin()), c.GetCommittedDate(),
			kind, c.GetAuthorLogin())
	}
	for _, e := range item.GetStateEvents() {
		actor := e.GetActor().GetLogin()
		kind := eventActivity
		if isBotStateEvent(e, knownBots) {
			kind = eventNoise
		}
		add(fmt.Sprintf("state:%v:", e.GetType())+fallbackKey("", true, e.GetCreatedAt(), actor), e.GetCreatedAt(),
			kind, actor)
	}
	return events
}

// addReviewEvents adds a submitted review and its review comments.
func addReviewEvents(
	r *octodeckv1.Review,
	currentUser string,
	knownBots []string,
	add func(key string, ts *timestamppb.Timestamp, kind eventKind, actor string),
) {
	author := r.GetAuthor().GetLogin()
	id := r.GetId()
	if id == "" {
		id = r.GetUrl()
	}
	add("review:"+fallbackKey(id, id == "", r.GetSubmittedAt(), author), r.GetSubmittedAt(),
		classifyReviewActivity(r.GetAuthor(), r.GetBody(), currentUser, knownBots), author)
	for _, rc := range r.GetComments() {
		rcAuthor := reviewCommentAuthor(rc, r)
		rcID := rc.GetId()
		if rcID == "" {
			rcID = rc.GetUrl()
		}
		// The identity uses the comment's own timestamp, which never changes; the event is
		// timed by when it became visible: not before its review was submitted.
		created := rc.GetCreatedAt()
		if !validTimestamp(created) {
			created = r.GetSubmittedAt()
		}
		add("review_comment:"+fallbackKey(rcID, rcID == "", created, rcAuthor.GetLogin()),
			laterTimestamp(created, r.GetSubmittedAt()),
			classifyReviewActivity(rcAuthor, rc.GetBody(), currentUser, knownBots), rcAuthor.GetLogin())
	}
}

// fallbackKey returns id unless useFallback is set, in which case it identifies the event by its
// timestamp (whole seconds) and actor.
func fallbackKey(id string, useFallback bool, ts *timestamppb.Timestamp, actor string) string {
	if !useFallback {
		return id
	}
	return fmt.Sprintf("%d:%s", ts.GetSeconds(), actor)
}

// laterTimestamp returns the later of two timestamps, ignoring unset ones.
func laterTimestamp(a, b *timestamppb.Timestamp) *timestamppb.Timestamp {
	if !validTimestamp(a) || (validTimestamp(b) && b.AsTime().After(a.AsTime())) {
		return b
	}
	return a
}

func classifyComment(c *octodeckv1.Comment, currentUser string, knownBots []string) eventKind {
	switch {
	case ContainsMention(c.GetBodyText(), currentUser):
		return eventMention
	case IsNoiseForUser(c, knownBots, currentUser):
		return eventNoise
	default:
		return eventActivity
	}
}

func classifyReviewActivity(author *octodeckv1.User, body, currentUser string, knownBots []string) eventKind {
	switch {
	case ContainsMention(body, currentUser):
		return eventMention
	case isReviewActivityNoise(author, body, currentUser, knownBots):
		return eventNoise
	default:
		return eventActivity
	}
}

// BuildNotification renders the notification for an item. The ID is derived from the item and its
// newest new event, so re-sending the same notification never shows a duplicate.
func BuildNotification(
	item *octodeckv1.Item,
	d NotificationDecision,
	baseURL string,
	now time.Time,
) *octodeckv1.Notification {
	id := fmt.Sprintf("%s@%d", item.GetId(), d.NewestEventAt.UnixMilli())
	title := item.GetRepo()
	if item.GetNumber() != 0 {
		title = fmt.Sprintf("%s #%d", item.GetRepo(), item.GetNumber())
	}
	message := item.GetTitle()
	if prefix := notificationPrefix(d.Category); prefix != "" {
		message = prefix + ": " + message
	}
	return octodeckv1.Notification_builder{
		Id:        &id,
		ItemId:    config.Ptr(item.GetId()),
		Title:     &title,
		Message:   &message,
		Url:       config.Ptr(DashboardItemURL(baseURL, item.GetId())),
		Category:  &d.Category,
		CreatedAt: timestamppb.New(now),
	}.Build()
}

func notificationPrefix(c octodeckv1.NotificationCategory) string {
	switch c {
	case octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_MENTION:
		return "Mentioned"
	case octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_NEW_ITEM:
		return "New"
	case octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_ACTIVITY:
		return "New activity"
	case octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_CODE:
		return "New commits"
	case octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_NOISE:
		return "Bot activity"
	case octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_UNSPECIFIED:
	}
	return ""
}

// DashboardItemURL returns the dashboard URL that opens the item's details.
func DashboardItemURL(baseURL, itemID string) string {
	return baseURL + "/?item=" + url.QueryEscape(itemID)
}

// DashboardInboxURL returns the dashboard URL of the Inbox view.
func DashboardInboxURL(baseURL string) string {
	return baseURL + "/?triage=inbox"
}

// maxBadgeCount is the largest count shown on the badge; larger counts show "*".
const maxBadgeCount = 99

// countsTowardBadge reports whether an item with the given status is counted in mode. Inbox
// counts items that are not acknowledged; unread additionally excludes idle and noise items.
func countsTowardBadge(status octodeckv1.ItemStatus, mode octodeckv1.BadgeCountMode) bool {
	switch status {
	case octodeckv1.ItemStatus_ITEM_STATUS_ACKED:
		return false
	case octodeckv1.ItemStatus_ITEM_STATUS_IDLE, octodeckv1.ItemStatus_ITEM_STATUS_NOISE:
		return mode != octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_UNREAD
	case octodeckv1.ItemStatus_ITEM_STATUS_UNSPECIFIED,
		octodeckv1.ItemStatus_ITEM_STATUS_NEW,
		octodeckv1.ItemStatus_ITEM_STATUS_NEW_ACTIVITY,
		octodeckv1.ItemStatus_ITEM_STATUS_NEW_CODE,
		octodeckv1.ItemStatus_ITEM_STATUS_NEW_MENTION:
	}
	return true
}

// ComputeBadge counts items for the toolbar badge (see countsTowardBadge).
func ComputeBadge(
	items []*octodeckv1.Item,
	currentUser string,
	knownBots []string,
	mode octodeckv1.BadgeCountMode,
) *octodeckv1.BadgeUpdate {
	if mode == octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_UNSPECIFIED {
		mode = octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_INBOX
	}
	var count int32
	if mode != octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_DISABLED {
		for _, item := range items {
			if countsTowardBadge(CalculateStatus(item, currentUser, knownBots), mode) {
				count++
			}
		}
	}

	text := ""
	tooltip := "Open OctoDeck Dashboard"
	if count > 0 {
		text = strconv.Itoa(int(count))
		if count > maxBadgeCount {
			text = "*"
		}
		kind := "inbox"
		if mode == octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_UNREAD {
			kind = "unread"
		}
		tooltip = fmt.Sprintf("OctoDeck (%d %s items)", count, kind)
	}
	return octodeckv1.BadgeUpdate_builder{
		Count:   &count,
		Mode:    &mode,
		Text:    &text,
		Tooltip: &tooltip,
	}.Build()
}

// ValidateAuthorPattern validates a single author login pattern.
func ValidateAuthorPattern(pattern string) error {
	_, err := ValidatePatternBase(pattern, "author")
	return err
}

// ValidateAuthorPatterns validates a list of author login patterns.
func ValidateAuthorPatterns(patterns []string) error {
	return ValidatePatterns(patterns, ValidateAuthorPattern)
}
