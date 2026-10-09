package logic

import (
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

const (
	catNone     = octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_UNSPECIFIED
	catMention  = octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_MENTION
	catNewItem  = octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_NEW_ITEM
	catActivity = octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_ACTIVITY
	catCode     = octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_CODE
	catNoise    = octodeckv1.NotificationCategory_NOTIFICATION_CATEGORY_NOISE
)

// notifSettings returns the defaults with only_assigned_or_authored off (so items by other
// authors can notify), then applies mutate.
func notifSettings(mutate ...func(*octodeckv1.NotificationSettings)) *octodeckv1.NotificationSettings {
	s := config.DefaultNotificationSettings()
	s.SetOnlyAssignedOrAuthored(false)
	for _, m := range mutate {
		m(s)
	}
	return s
}

func withComment(item *octodeckv1.Item, id int64, author, body string, at time.Time) *octodeckv1.Item {
	c := ackTestComment(author, at)
	c.SetCommentId(id)
	c.SetBodyText(body)
	item.SetComments(append(item.GetComments(), c))
	touch(item, at)
	return item
}

// notifTestNow returns the evaluation time: shortly after the fixtures' activity.
func notifTestNow() time.Time { return ackTestTime(30) }

// reviewWithComment returns a submitted review by another user carrying one review comment.
func reviewWithComment(id string, submitted, commentCreated time.Time, body string) *octodeckv1.Review {
	return octodeckv1.Review_builder{
		Id:          config.Ptr(id),
		Author:      ackTestUserProto(ackTestOther),
		State:       config.Ptr("COMMENTED"),
		SubmittedAt: timestamppb.New(submitted),
		Comments: []*octodeckv1.ReviewComment{octodeckv1.ReviewComment_builder{
			Id:        config.Ptr(id + "-c1"),
			Body:      config.Ptr(body),
			Author:    ackTestUserProto(ackTestOther),
			CreatedAt: timestamppb.New(commentCreated),
		}.Build()},
	}.Build()
}

func TestEvaluateNotification(t *testing.T) {
	// A viewed item (last viewed at t-30) with one comment from another user at t-40, already
	// stored. Each case derives the fetched copy from it.
	base := func() *octodeckv1.Item {
		item := ackTestItem(ackTestOther)
		item.SetRepo("owner/repo")
		return withComment(item, 1, ackTestOther, "old comment", ackTestTime(-40))
	}

	tests := []struct {
		name     string
		stored   func() *octodeckv1.Item // nil func means the item wasn't stored
		fetched  func() *octodeckv1.Item
		settings *octodeckv1.NotificationSettings
		want     octodeckv1.NotificationCategory
		wantAt   time.Time
	}{
		{
			name:    "new comment from another user",
			stored:  base,
			fetched: func() *octodeckv1.Item { return withComment(base(), 2, ackTestOther, "hi", ackTestTime(10)) },
			want:    catActivity,
			wantAt:  ackTestTime(10),
		},
		{
			name: "second comment on an item that already has unseen activity",
			stored: func() *octodeckv1.Item {
				return withComment(base(), 2, ackTestOther, "first", ackTestTime(10))
			},
			fetched: func() *octodeckv1.Item {
				return withComment(withComment(base(), 2, ackTestOther, "first", ackTestTime(10)),
					3, ackTestOther, "second", ackTestTime(20))
			},
			want:   catActivity,
			wantAt: ackTestTime(20),
		},
		{
			name: "same activity does not notify twice",
			stored: func() *octodeckv1.Item {
				return withComment(base(), 2, ackTestOther, "first", ackTestTime(10))
			},
			fetched: func() *octodeckv1.Item {
				return withComment(base(), 2, ackTestOther, "first", ackTestTime(10))
			},
			want: catNone,
		},
		{
			name:    "own comment never notifies",
			stored:  base,
			fetched: func() *octodeckv1.Item { return withComment(base(), 2, ackTestUser, "mine", ackTestTime(10)) },
			want:    catNone,
		},
		{
			name:   "own commit never notifies",
			stored: base,
			fetched: func() *octodeckv1.Item {
				item := base()
				item.SetCommits([]*octodeckv1.Commit{ackTestCommit(ackTestUser, ackTestTime(10))})
				return item
			},
			want: catNone,
		},
		{
			name:   "own state event never notifies",
			stored: base,
			fetched: func() *octodeckv1.Item {
				item := base()
				item.SetStateEvents([]*octodeckv1.StateEvent{ackTestStateEvent(ackTestUser, ackTestTime(10))})
				return item
			},
			want: catNone,
		},
		{
			name:   "own review never notifies",
			stored: base,
			fetched: func() *octodeckv1.Item {
				item := base()
				item.SetReviews([]*octodeckv1.Review{octodeckv1.Review_builder{
					Id:          config.Ptr("R1"),
					Author:      ackTestUserProto(ackTestUser),
					State:       config.Ptr("APPROVED"),
					SubmittedAt: timestamppb.New(ackTestTime(10)),
				}.Build()})
				return item
			},
			want: catNone,
		},
		{
			name: "activity before own later comment does not notify",
			stored: func() *octodeckv1.Item {
				return base()
			},
			fetched: func() *octodeckv1.Item {
				return withComment(withComment(base(), 2, ackTestOther, "q", ackTestTime(10)),
					3, ackTestUser, "answer", ackTestTime(20))
			},
			want: catNone,
		},
		{
			name:   "new commit from another user",
			stored: base,
			fetched: func() *octodeckv1.Item {
				item := base()
				item.SetCommits([]*octodeckv1.Commit{ackTestCommit(ackTestOther, ackTestTime(10))})
				return item
			},
			want:   catCode,
			wantAt: ackTestTime(10),
		},
		{
			name:   "bot comment notifies as noise when bots are not ignored",
			stored: base,
			fetched: func() *octodeckv1.Item {
				return withComment(base(), 2, ackTestBot, "CI passed", ackTestTime(10))
			},
			settings: notifSettings(func(s *octodeckv1.NotificationSettings) { s.SetIgnoreBots(false) }),
			want:     catNoise,
			wantAt:   ackTestTime(10),
		},
		{
			name:   "bot comment is ignored when ignore_bots is set",
			stored: base,
			fetched: func() *octodeckv1.Item {
				return withComment(base(), 2, ackTestBot, "CI passed", ackTestTime(10))
			},
			want: catNone,
		},
		{
			name:   "slash command is noise",
			stored: base,
			fetched: func() *octodeckv1.Item {
				return withComment(base(), 2, ackTestOther, "/lgtm", ackTestTime(10))
			},
			want: catNone,
		},
		{
			name:   "bot mention is a mention",
			stored: base,
			fetched: func() *octodeckv1.Item {
				return withComment(base(), 2, ackTestBot, "@me please rebase", ackTestTime(10))
			},
			want:   catMention,
			wantAt: ackTestTime(10),
		},
		{
			name:   "mention bypasses filters",
			stored: base,
			fetched: func() *octodeckv1.Item {
				return withComment(base(), 2, ackTestOther, "cc @me", ackTestTime(10))
			},
			settings: notifSettings(func(s *octodeckv1.NotificationSettings) {
				s.SetRepoExcludes([]string{"owner/*"})
				s.SetNotifyOnNewActivity(false)
			}),
			want:   catMention,
			wantAt: ackTestTime(10),
		},
		{
			name:   "mention is filtered when always_include_mentions is off",
			stored: base,
			fetched: func() *octodeckv1.Item {
				return withComment(base(), 2, ackTestOther, "cc @me", ackTestTime(10))
			},
			settings: notifSettings(func(s *octodeckv1.NotificationSettings) {
				s.SetRepoExcludes([]string{"owner/*"})
				s.SetAlwaysIncludeMentions(false)
			}),
			want: catNone,
		},
		{
			name:   "disabled suppresses mentions too",
			stored: base,
			fetched: func() *octodeckv1.Item {
				return withComment(base(), 2, ackTestOther, "cc @me", ackTestTime(10))
			},
			settings: notifSettings(func(s *octodeckv1.NotificationSettings) { s.SetEnabled(false) }),
			want:     catNone,
		},
		{
			name:   "repo exclude blocks activity",
			stored: base,
			fetched: func() *octodeckv1.Item {
				return withComment(base(), 2, ackTestOther, "hi", ackTestTime(10))
			},
			settings: notifSettings(func(s *octodeckv1.NotificationSettings) {
				s.SetRepoExcludes([]string{"owner/*"})
			}),
			want: catNone,
		},
		{
			name:   "only_assigned_or_authored blocks items by others",
			stored: base,
			fetched: func() *octodeckv1.Item {
				return withComment(base(), 2, ackTestOther, "hi", ackTestTime(10))
			},
			settings: notifSettings(func(s *octodeckv1.NotificationSettings) { s.SetOnlyAssignedOrAuthored(true) }),
			want:     catNone,
		},
		{
			name: "only_assigned_or_authored allows assigned items",
			stored: func() *octodeckv1.Item {
				item := base()
				item.SetAssignees([]*octodeckv1.User{ackTestUserProto(ackTestUser)})
				return item
			},
			fetched: func() *octodeckv1.Item {
				item := withComment(base(), 2, ackTestOther, "hi", ackTestTime(10))
				item.SetAssignees([]*octodeckv1.User{ackTestUserProto(ackTestUser)})
				return item
			},
			settings: notifSettings(func(s *octodeckv1.NotificationSettings) { s.SetOnlyAssignedOrAuthored(true) }),
			want:     catActivity,
			wantAt:   ackTestTime(10),
		},
		{
			name:   "notify_on_new_activity off",
			stored: base,
			fetched: func() *octodeckv1.Item {
				return withComment(base(), 2, ackTestOther, "hi", ackTestTime(10))
			},
			settings: notifSettings(func(s *octodeckv1.NotificationSettings) { s.SetNotifyOnNewActivity(false) }),
			want:     catNone,
		},
		{
			name: "new unseen item",
			fetched: func() *octodeckv1.Item {
				item := ackTestItem(ackTestOther)
				item.GetLocal().ClearLastViewedAt()
				return item
			},
			want:   catNewItem,
			wantAt: ackTestTime(-60),
		},
		{
			name: "new item mentioning the user in its body",
			fetched: func() *octodeckv1.Item {
				item := ackTestItem(ackTestOther)
				item.GetLocal().ClearLastViewedAt()
				item.SetBody("@me can you review?")
				return item
			},
			settings: notifSettings(func(s *octodeckv1.NotificationSettings) { s.SetNotifyOnNewItems(false) }),
			want:     catMention,
			wantAt:   ackTestTime(-60),
		},
		{
			name: "notify_on_new_items off",
			fetched: func() *octodeckv1.Item {
				item := ackTestItem(ackTestOther)
				item.GetLocal().ClearLastViewedAt()
				return item
			},
			settings: notifSettings(func(s *octodeckv1.NotificationSettings) { s.SetNotifyOnNewItems(false) }),
			want:     catNone,
		},
		{
			name: "new item authored by the user",
			fetched: func() *octodeckv1.Item {
				item := ackTestItem(ackTestUser)
				item.GetLocal().ClearLastViewedAt()
				return item
			},
			want: catNone,
		},
		{
			name:   "activity before last viewed does not notify",
			stored: base,
			fetched: func() *octodeckv1.Item {
				// Comment at t-35 is new to the database but before last_viewed_at (t-30).
				return withComment(base(), 2, ackTestOther, "hi", ackTestTime(-35))
			},
			want: catNone,
		},
		{
			name: "activity before the ack watermark does not notify",
			stored: func() *octodeckv1.Item {
				item := base()
				item.GetLocal().SetAckedActivityAt(timestamppb.New(ackTestTime(15)))
				return item
			},
			fetched: func() *octodeckv1.Item {
				item := withComment(base(), 2, ackTestOther, "hi", ackTestTime(10))
				item.GetLocal().SetAckedActivityAt(timestamppb.New(ackTestTime(15)))
				return item
			},
			want: catNone,
		},
		{
			name: "backfilled history older than the stored latest does not notify",
			stored: func() *octodeckv1.Item {
				return withComment(base(), 3, ackTestOther, "latest", ackTestTime(20))
			},
			fetched: func() *octodeckv1.Item {
				item := withComment(base(), 2, ackTestOther, "gap", ackTestTime(10))
				return withComment(item, 3, ackTestOther, "latest", ackTestTime(20))
			},
			want: catNone,
		},
		{
			name: "backfilled mention older than the stored latest does not notify",
			stored: func() *octodeckv1.Item {
				return withComment(base(), 3, ackTestOther, "latest", ackTestTime(20))
			},
			fetched: func() *octodeckv1.Item {
				item := withComment(base(), 2, ackTestOther, "@me look", ackTestTime(10))
				return withComment(item, 3, ackTestOther, "latest", ackTestTime(20))
			},
			want: catNone,
		},
		{
			name: "deferred review backfill with a mention on a never-viewed item does not notify",
			stored: func() *octodeckv1.Item {
				item := withComment(ackTestItem(ackTestOther), 3, ackTestOther, "latest", ackTestTime(20))
				item.GetLocal().ClearLastViewedAt()
				return item
			},
			fetched: func() *octodeckv1.Item {
				item := withComment(ackTestItem(ackTestOther), 3, ackTestOther, "latest", ackTestTime(20))
				item.GetLocal().ClearLastViewedAt()
				review := reviewWithComment("R1", ackTestTime(5), ackTestTime(5), "@me nit")
				item.SetReviews([]*octodeckv1.Review{review})
				return item
			},
			want: catNone,
		},
		{
			name:   "review comment drafted earlier counts from when its review was submitted",
			stored: func() *octodeckv1.Item { return withComment(base(), 3, ackTestOther, "latest", ackTestTime(20)) },
			fetched: func() *octodeckv1.Item {
				item := withComment(base(), 3, ackTestOther, "latest", ackTestTime(20))
				review := reviewWithComment("R1", ackTestTime(25), ackTestTime(5), "@me nit")
				item.SetReviews([]*octodeckv1.Review{review})
				touch(item, ackTestTime(25))
				return item
			},
			want:   catMention,
			wantAt: ackTestTime(25),
		},
		{
			name:   "bot commit is ignored when ignore_bots is set",
			stored: base,
			fetched: func() *octodeckv1.Item {
				item := base()
				item.SetCommits([]*octodeckv1.Commit{ackTestCommit(ackTestBot, ackTestTime(10))})
				return item
			},
			want: catNone,
		},
		{
			name:   "bot commit is noise when bots are not ignored",
			stored: base,
			fetched: func() *octodeckv1.Item {
				item := base()
				item.SetCommits([]*octodeckv1.Commit{ackTestCommit(ackTestBot, ackTestTime(10))})
				return item
			},
			settings: notifSettings(func(s *octodeckv1.NotificationSettings) { s.SetIgnoreBots(false) }),
			want:     catNoise,
			wantAt:   ackTestTime(10),
		},
		{
			name: "unstored old item with only old activity does not notify",
			fetched: func() *octodeckv1.Item {
				item := ackTestItem(ackTestOther)
				item.GetLocal().ClearLastViewedAt()
				item.SetCreatedAt(timestamppb.New(notifTestNow().Add(-72 * time.Hour)))
				return withComment(item, 2, ackTestOther, "old", notifTestNow().Add(-48*time.Hour))
			},
			want: catNone,
		},
		{
			name: "unstored old item notifies only for recent activity",
			fetched: func() *octodeckv1.Item {
				item := ackTestItem(ackTestOther)
				item.GetLocal().ClearLastViewedAt()
				item.SetCreatedAt(timestamppb.New(notifTestNow().Add(-72 * time.Hour)))
				item = withComment(item, 2, ackTestOther, "old", notifTestNow().Add(-48*time.Hour))
				return withComment(item, 3, ackTestOther, "new", ackTestTime(10))
			},
			want:   catActivity,
			wantAt: ackTestTime(10),
		},
		{
			name:   "pending reviews are ignored",
			stored: base,
			fetched: func() *octodeckv1.Item {
				item := base()
				item.SetReviews([]*octodeckv1.Review{octodeckv1.Review_builder{
					Id:     config.Ptr("R1"),
					Author: ackTestUserProto(ackTestOther),
					State:  config.Ptr("PENDING"),
				}.Build()})
				return item
			},
			want: catNone,
		},
		{
			name:   "submitted review from another user",
			stored: base,
			fetched: func() *octodeckv1.Item {
				item := base()
				item.SetReviews([]*octodeckv1.Review{octodeckv1.Review_builder{
					Id:          config.Ptr("R1"),
					Author:      ackTestUserProto(ackTestOther),
					State:       config.Ptr("CHANGES_REQUESTED"),
					Body:        config.Ptr("Please fix"),
					SubmittedAt: timestamppb.New(ackTestTime(10)),
				}.Build()})
				return item
			},
			want:   catActivity,
			wantAt: ackTestTime(10),
		},
		{
			name:   "mention outranks activity",
			stored: base,
			fetched: func() *octodeckv1.Item {
				item := withComment(base(), 2, ackTestOther, "@me ping", ackTestTime(10))
				return withComment(item, 3, ackTestOther, "more", ackTestTime(20))
			},
			want:   catMention,
			wantAt: ackTestTime(20),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stored *octodeckv1.Item
			if tt.stored != nil {
				stored = tt.stored()
			}
			settings := tt.settings
			if settings == nil {
				settings = notifSettings()
			}
			got := EvaluateNotification(stored, tt.fetched(), ackTestUser, ackTestBots(), settings, notifTestNow())
			assert.Equal(t, tt.want, got.Category)
			assert.Equal(t, tt.want != catNone, got.Notify())
			if tt.want != catNone {
				assert.True(t, tt.wantAt.Equal(got.NewestEventAt),
					"NewestEventAt = %v, want %v", got.NewestEventAt, tt.wantAt)
			}
		})
	}
}

func TestEvaluateNotificationRequiresUser(t *testing.T) {
	fetched := withComment(ackTestItem(ackTestOther), 2, ackTestOther, "hi", ackTestTime(10))
	got := EvaluateNotification(ackTestItem(ackTestOther), fetched, "", ackTestBots(), notifSettings(), notifTestNow())
	assert.False(t, got.Notify())
}

func TestEvaluateNotificationLabelFilters(t *testing.T) {
	label := func(name string) *octodeckv1.Label {
		return octodeckv1.Label_builder{Name: config.Ptr(name)}.Build()
	}
	item := func() *octodeckv1.Item {
		i := ackTestItem(ackTestOther)
		i.SetLabels([]*octodeckv1.Label{label("kind/bug"), label("area/kubelet")})
		return i
	}
	fetched := func() *octodeckv1.Item { return withComment(item(), 2, ackTestOther, "hi", ackTestTime(10)) }

	tests := []struct {
		name               string
		includes, excludes []string
		want               bool
	}{
		{name: "no filters", want: true},
		{name: "include matches one label", includes: []string{"area/*"}, want: true},
		{name: "include matches none", includes: []string{"sig/*"}, want: false},
		{name: "exclude matches one label", excludes: []string{"kind/bug"}, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := notifSettings(func(s *octodeckv1.NotificationSettings) {
				s.SetLabelIncludes(tt.includes)
				s.SetLabelExcludes(tt.excludes)
			})
			got := EvaluateNotification(item(), fetched(), ackTestUser, ackTestBots(), s, notifTestNow())
			assert.Equal(t, tt.want, got.Notify())
		})
	}
}

func TestEvaluateNotificationAuthorFilters(t *testing.T) {
	fetched := withComment(ackTestItem("dependabot"), 2, ackTestOther, "hi", ackTestTime(10))
	s := notifSettings(func(s *octodeckv1.NotificationSettings) {
		s.SetAuthorExcludes([]string{"dependabot*"})
	})
	evaluate := func() bool {
		return EvaluateNotification(ackTestItem("dependabot"), fetched, ackTestUser, nil, s, notifTestNow()).Notify()
	}
	assert.False(t, evaluate())
	s.SetAuthorExcludes(nil)
	assert.True(t, evaluate())
}

func TestBuildNotification(t *testing.T) {
	item := ackTestItem(ackTestOther)
	item.SetRepo("owner/repo")
	item.SetNumber(42)
	item.SetTitle("Fix the thing")
	at := ackTestTime(10)
	now := ackTestTime(11)

	n := BuildNotification(item, NotificationDecision{Category: catMention, NewestEventAt: at},
		"http://127.0.0.1:8080", now)

	want := octodeckv1.Notification_builder{
		Id:        config.Ptr("owner/repo#1@" + formatMillis(at)),
		ItemId:    config.Ptr("owner/repo#1"),
		Title:     config.Ptr("owner/repo #42"),
		Message:   config.Ptr("Mentioned: Fix the thing"),
		Url:       config.Ptr("http://127.0.0.1:8080/?item=owner%2Frepo%231"),
		Category:  config.Ptr(catMention),
		CreatedAt: timestamppb.New(now),
	}.Build()
	assert.True(t, proto.Equal(want, n), "got %v", n)
}

func formatMillis(t time.Time) string {
	return strconv.FormatInt(t.UnixMilli(), 10)
}

func TestDashboardURLs(t *testing.T) {
	assert.Equal(t, "http://x/?item=a%2Fb%231", DashboardItemURL("http://x", "a/b#1"))
	assert.Equal(t, "http://x/?triage=inbox", DashboardInboxURL("http://x"))
}

func TestComputeBadge(t *testing.T) {
	acked := func() *octodeckv1.Item {
		item := ackTestItem(ackTestOther)
		item.GetLocal().SetAckedActivityAt(timestamppb.New(ackTestTime(5)))
		return item
	}
	active := func() *octodeckv1.Item {
		return withComment(ackTestItem(ackTestOther), 2, ackTestOther, "hi", ackTestTime(10))
	}
	idle := func() *octodeckv1.Item { return ackTestItem(ackTestOther) }

	items := []*octodeckv1.Item{acked(), active(), idle()}

	inbox := ComputeBadge(items, ackTestUser, ackTestBots(), octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_INBOX)
	assert.Equal(t, int32(2), inbox.GetCount())
	assert.Equal(t, "2", inbox.GetText())
	assert.Equal(t, "OctoDeck (2 inbox items)", inbox.GetTooltip())

	unread := ComputeBadge(items, ackTestUser, ackTestBots(), octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_UNREAD)
	assert.Equal(t, int32(1), unread.GetCount())
	assert.Equal(t, "1", unread.GetText())

	disabled := ComputeBadge(items, ackTestUser, ackTestBots(), octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_DISABLED)
	assert.Equal(t, int32(0), disabled.GetCount())
	assert.Empty(t, disabled.GetText())
	assert.Equal(t, octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_DISABLED, disabled.GetMode())

	unspecified := ComputeBadge(nil, ackTestUser, nil, octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_UNSPECIFIED)
	assert.Equal(t, octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_INBOX, unspecified.GetMode())
	assert.Empty(t, unspecified.GetText())

	many := make([]*octodeckv1.Item, 0, 100)
	for range 100 {
		many = append(many, active())
	}
	overflow := ComputeBadge(many, ackTestUser, nil, octodeckv1.BadgeCountMode_BADGE_COUNT_MODE_INBOX)
	require.Equal(t, int32(100), overflow.GetCount())
	assert.Equal(t, "*", overflow.GetText())
}

func TestValidateAuthorPatterns(t *testing.T) {
	require.NoError(t, ValidateAuthorPatterns([]string{"alice", "dependabot*"}))
	assert.Error(t, ValidateAuthorPatterns([]string{"bad\x01login"}))
}
