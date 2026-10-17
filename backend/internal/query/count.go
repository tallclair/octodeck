package query

// Counts holds the item counts shared by FacetValue and CountResult.
type Counts struct {
	Count      int32
	NewCount   int32
	InboxCount int32
}

// add records a matched view in c.
func (c *Counts) add(v *View) {
	c.Count++
	if matchNew(valueAny, v) {
		c.NewCount++
	}
	if matchTriage(valueInbox, v) {
		c.InboxCount++
	}
}

// Count returns the item counts for views matching q (including the implicit triage:inbox scope).
func Count(q *Query, views []*View) Counts {
	var c Counts
	for _, v := range views {
		if q.Match(v) {
			c.add(v)
		}
	}
	return c
}
