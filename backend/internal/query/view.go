package query

import (
	"strings"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/logic"
)

// Env is the per-request context for building views.
type Env struct {
	CurrentUser string
	KnownBots   []string
}

// View is an item prepared for evaluation: its activity flags are computed once and text fields
// are lowered lazily when a free-text predicate inspects them.
type View struct {
	Item     *octodeckv1.Item
	Activity logic.Activity

	titleLower   string
	bodyLower    string
	titleLowered bool
	bodyLowered  bool
}

func (v *View) lowerTitle() string {
	if !v.titleLowered {
		v.titleLower = strings.ToLower(v.Item.GetTitle())
		v.titleLowered = true
	}
	return v.titleLower
}

func (v *View) lowerBody() string {
	if !v.bodyLowered {
		v.bodyLower = strings.ToLower(v.Item.GetBody())
		v.bodyLowered = true
	}
	return v.bodyLower
}

// NewViews prepares items for evaluation. It classifies comment noise for the current user,
// attaches local state if missing, computes the activity flags once per item, and stores the
// derived computed_status and computed_last_viewed_at on each item. Items must already have been
// narrowed by the configured repository and label filters, so hidden labels never match.
func NewViews(items []*octodeckv1.Item, env Env) []*View {
	logic.ClassifyCommentsForUser(env.KnownBots, env.CurrentUser, items...)
	views := make([]*View, 0, len(items))
	for _, item := range items {
		if item == nil {
			continue
		}
		if item.GetLocal() == nil {
			item.SetLocal(octodeckv1.ItemLocalState_builder{}.Build())
		}
		act := logic.ComputeActivity(item, env.CurrentUser, env.KnownBots)
		item.GetLocal().SetComputedStatus(act.Status())
		logic.SetComputedLastViewedAt(item, env.CurrentUser)
		views = append(views, &View{
			Item:     item,
			Activity: act,
		})
	}
	return views
}

// Items returns the items of views, in order.
func Items(views []*View) []*octodeckv1.Item {
	items := make([]*octodeckv1.Item, len(views))
	for i, v := range views {
		items[i] = v.Item
	}
	return items
}
