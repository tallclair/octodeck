package query

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

// The sort tests mirror the dashboard's sort cases (frontend filterEngine.test.ts) so the backend
// ordering matches what the UI did client-side.

const sortEpoch = 1_700_000_000

type sortFixture struct {
	id       string
	created  int64 // seconds after sortEpoch; 0 = unset
	updated  int64
	ackedAt  int64
	ackNanos int32
	starred  bool
	comments []sortComment
}

type sortComment struct {
	author string
	at     int64
}

func secs(offset int64) *timestamppb.Timestamp {
	return timestamppb.New(time.Unix(sortEpoch+offset, 0))
}

func (f sortFixture) build() *octodeckv1.Item {
	b := octodeckv1.Item_builder{Id: config.Ptr(f.id), Repo: config.Ptr("o/r"), UpdatedAt: secs(f.updated)}
	if f.created != 0 {
		b.CreatedAt = secs(f.created)
	}
	for _, c := range f.comments {
		b.Comments = append(b.Comments, octodeckv1.Comment_builder{
			Author:    octodeckv1.User_builder{Login: config.Ptr(c.author)}.Build(),
			CreatedAt: secs(c.at),
		}.Build())
	}
	local := octodeckv1.ItemLocalState_builder{Starred: config.Ptr(f.starred)}
	if f.ackedAt != 0 {
		local.AckedAt = &timestamppb.Timestamp{Seconds: sortEpoch + f.ackedAt, Nanos: f.ackNanos}
	}
	b.Local = local.Build()
	return b.Build()
}

func sortedIDs(fs []sortFixture, key octodeckv1.SortKey, order octodeckv1.SortOrder) []string {
	items := make([]*octodeckv1.Item, len(fs))
	for i, f := range fs {
		items[i] = f.build()
	}
	views := NewViews(items, Env{CurrentUser: testUser, KnownBots: testBots})
	var s *octodeckv1.Sort
	if key != octodeckv1.SortKey_SORT_KEY_UNSPECIFIED || order != octodeckv1.SortOrder_SORT_ORDER_UNSPECIFIED {
		s = octodeckv1.Sort_builder{Key: key.Enum(), Order: order.Enum()}.Build()
	}
	SortViews(views, s)
	return ids(views)
}

const (
	sortUpdated = octodeckv1.SortKey_SORT_KEY_UPDATED
	sortAcked   = octodeckv1.SortKey_SORT_KEY_ACKED
	sortCreated = octodeckv1.SortKey_SORT_KEY_CREATED
	orderDesc   = octodeckv1.SortOrder_SORT_ORDER_DESC
	orderAsc    = octodeckv1.SortOrder_SORT_ORDER_ASC
	unsetKey    = octodeckv1.SortKey_SORT_KEY_UNSPECIFIED
	unsetOrder  = octodeckv1.SortOrder_SORT_ORDER_UNSPECIFIED
)

func TestSortViews_UpdatedUsesNonNoiseActivity(t *testing.T) {
	items := []sortFixture{
		// Bot comment at 900 is noise, so the latest non-noise activity is the creation at 100.
		{id: "BOT_LATER", created: 100, updated: 900, comments: []sortComment{{author: "k8s-ci-robot", at: 900}}},
		{id: "HUMAN_LATER", created: 100, updated: 200, comments: []sortComment{{author: "alice", at: 500}}},
	}
	assert.Equal(t, []string{"HUMAN_LATER", "BOT_LATER"}, sortedIDs(items, sortUpdated, orderDesc))
	assert.Equal(t, []string{"BOT_LATER", "HUMAN_LATER"}, sortedIDs(items, sortUpdated, orderAsc))
}

func TestSortViews_UnsetSortIsUpdatedDescending(t *testing.T) {
	items := []sortFixture{
		{id: "OLD", created: 100, updated: 100},
		{id: "NEW", created: 300, updated: 300},
		{id: "MID", created: 200, updated: 200},
	}
	assert.Equal(t, []string{"NEW", "MID", "OLD"}, sortedIDs(items, unsetKey, unsetOrder))
	assert.Equal(t, []string{"NEW", "MID", "OLD"}, sortedIDs(items, sortUpdated, unsetOrder))
}

func TestSortViews_AckedTime(t *testing.T) {
	items := []sortFixture{
		{id: "ACK_2", updated: 200, ackedAt: 400},
		{id: "UNACK_3", updated: 300},
		{id: "ACK_1", updated: 100, ackedAt: 500},
	}
	assert.Equal(t, []string{"ACK_1", "ACK_2", "UNACK_3"}, sortedIDs(items, sortAcked, orderDesc))
	assert.Equal(t, []string{"UNACK_3", "ACK_2", "ACK_1"}, sortedIDs(items, sortAcked, orderAsc))
}

func TestSortViews_AckedRoundsNanosToMillis(t *testing.T) {
	// 0.4ms rounds down and 0.6ms rounds up, so B (rounded to +1ms) is the more recent ack.
	items := []sortFixture{
		{id: "A", updated: 100, ackedAt: 500, ackNanos: 400_000},
		{id: "B", updated: 100, ackedAt: 500, ackNanos: 600_000},
	}
	assert.Equal(t, []string{"B", "A"}, sortedIDs(items, sortAcked, orderDesc))
}

func TestSortViews_CreatedFallsBackToUpdated(t *testing.T) {
	items := []sortFixture{
		{id: "A", created: 100, updated: 900},
		{id: "B", created: 300, updated: 200},
		{id: "C", created: 200, updated: 500},
	}
	assert.Equal(t, []string{"B", "C", "A"}, sortedIDs(items, sortCreated, orderDesc))
	assert.Equal(t, []string{"A", "C", "B"}, sortedIDs(items, sortCreated, orderAsc))

	// Without a creation time the update time is used.
	noCreated := []sortFixture{
		{id: "X", updated: 250},
		{id: "Y", created: 200, updated: 900},
	}
	assert.Equal(t, []string{"X", "Y"}, sortedIDs(noCreated, sortCreated, orderDesc))
}

func TestSortViews_StarredFirst(t *testing.T) {
	items := []sortFixture{
		{id: "NORM_1", updated: 900},
		{id: "STAR_1", updated: 100, starred: true},
		{id: "NORM_2", updated: 800},
		{id: "STAR_2", updated: 300, starred: true},
	}
	assert.Equal(t, []string{"STAR_2", "STAR_1", "NORM_1", "NORM_2"}, sortedIDs(items, sortUpdated, orderDesc))
	// Starred items stay first in ascending order too.
	assert.Equal(t, []string{"STAR_1", "STAR_2", "NORM_2", "NORM_1"}, sortedIDs(items, sortUpdated, orderAsc))
}

func TestSortViews_TieBreaks(t *testing.T) {
	// Equal sort keys (never acked) fall back to latest activity descending, then id ascending,
	// regardless of the requested order.
	items := []sortFixture{
		{id: "b", updated: 100},
		{id: "c", updated: 300},
		{id: "a", updated: 100},
	}
	assert.Equal(t, []string{"c", "a", "b"}, sortedIDs(items, sortAcked, orderDesc))
	assert.Equal(t, []string{"c", "a", "b"}, sortedIDs(items, sortAcked, orderAsc))
}
