package query

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestCount_ConformanceVectors verifies that for every conformance vector in fixtures_test.go,
// Count equals len(q.Filter(views)), with NewCount and InboxCount equal to the new:any and
// triage:inbox subsets.
func TestCount_ConformanceVectors(t *testing.T) {
	for _, suite := range conformanceSuites() {
		for _, tc := range suite.cases {
			user := tc.user()
			views := facetViews(suite.fixtures, user)
			q, err := Compile(tc.expr, Options{CurrentUser: user})
			require.NoError(t, err, "%s: %s", suite.name, tc.name)

			counts := Count(q, views)
			matched := q.Filter(views)

			var wantNew, wantInbox int32
			for _, v := range matched {
				if matchNew(valueAny, v) {
					wantNew++
				}
				if matchTriage(valueInbox, v) {
					wantInbox++
				}
			}

			assert.Equal(t, int32(len(matched)), counts.Count,
				"%s %s: count equals len(q.Filter(views))", suite.name, tc.name)
			assert.Equal(t, wantNew, counts.NewCount,
				"%s %s: new_count equals new:any subset", suite.name, tc.name)
			assert.Equal(t, wantInbox, counts.InboxCount,
				"%s %s: inbox_count equals triage:inbox subset", suite.name, tc.name)
		}
	}
}

// TestCount_EmptyViews verifies that Count returns all zeros when views is empty.
func TestCount_EmptyViews(t *testing.T) {
	q, err := Compile(nil, Options{CurrentUser: testUser})
	require.NoError(t, err)

	counts := Count(q, nil)
	assert.Equal(t, int32(0), counts.Count)
	assert.Equal(t, int32(0), counts.NewCount)
	assert.Equal(t, int32(0), counts.InboxCount)
}

// TestCount_ImplicitInboxVsExplicitScope verifies that unscoped queries apply the implicit inbox
// (so InboxCount equals Count), while triage:all includes acked items.
func TestCount_ImplicitInboxVsExplicitScope(t *testing.T) {
	views := facetViews(facetFixtures(), testUser)

	// Unscoped query: implicit inbox applies; all matched items are in inbox.
	unscopedQ, err := Compile(p(fRepo, "zeta/old"), Options{CurrentUser: testUser})
	require.NoError(t, err)
	unscopedCounts := Count(unscopedQ, views)
	// X4 in zeta/old is acked, so unscoped (implicit inbox) matches 0 items.
	assert.Equal(t, int32(0), unscopedCounts.Count)
	assert.Equal(t, int32(0), unscopedCounts.InboxCount)

	// Explicit triage:all query includes the acked X4.
	scopedQ, err := Compile(ta(p(fRepo, "zeta/old")), Options{CurrentUser: testUser})
	require.NoError(t, err)
	scopedCounts := Count(scopedQ, views)
	assert.Equal(t, int32(1), scopedCounts.Count)
	assert.Equal(t, int32(0), scopedCounts.InboxCount)
	assert.Equal(t, int32(0), scopedCounts.NewCount)
}
