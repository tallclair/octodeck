package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"connectrpc.com/connect"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/query"
)

// GetItems returns the items matching the request's query (with the implicit triage:inbox scope
// when the query has no triage predicate), in the requested order. Invalid queries are rejected
// with InvalidArgument and an ExprError detail.
func (h *octoDeckHandler) GetItems(ctx context.Context,
	req *connect.Request[octodeckv1.GetItemsRequest]) (*connect.Response[octodeckv1.GetItemsResponse], error) {
	q, err := h.compileQuery(req.Msg.GetQuery())
	if err != nil {
		return nil, err
	}
	// The prefilter only narrows the rows loaded; the in-memory evaluation decides.
	items, err := h.loadCandidates(ctx, query.SQLPrefilter(q))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to fetch items: %w", err))
	}
	matched := q.Filter(h.queryViews(items))
	query.SortViews(matched, req.Msg.GetSort())

	return connect.NewResponse(octodeckv1.GetItemsResponse_builder{
		Items: query.Items(matched),
	}.Build()), nil
}

// GetFacets returns the values of each requested field with the number of items matching the
// query once that field's own top-level predicates are removed. Every value present in the stored
// items (after the configured repository and label filters) is listed, including those with no
// matching item.
func (h *octoDeckHandler) GetFacets(ctx context.Context,
	req *connect.Request[octodeckv1.GetFacetsRequest]) (*connect.Response[octodeckv1.GetFacetsResponse], error) {
	q, err := h.compileQuery(req.Msg.GetQuery())
	if err != nil {
		return nil, err
	}
	if err := query.ValidateFacetFields(req.Msg.GetFields()); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	// Zero counts need the whole universe, so there is no prefilter here.
	items, err := h.db.GetItems(ctx, nil)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to fetch items: %w", err))
	}
	facets, err := query.Facets(q, h.queryViews(items), req.Msg.GetFields())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return connect.NewResponse(octodeckv1.GetFacetsResponse_builder{Facets: facets}.Build()), nil
}

// compileQuery validates expr, resolving @me to the current user. Validation failures are
// returned as connect errors.
func (h *octoDeckHandler) compileQuery(expr *octodeckv1.Expr) (*query.Query, error) {
	q, err := query.Compile(expr, query.Options{CurrentUser: h.currentUser()})
	if err != nil {
		return nil, invalidQuery(err)
	}
	return q, nil
}

// loadCandidates loads the rows selected by the prefilter. The prefilter is only an optimisation,
// so if SQLite rejects it (for example because some limit is exceeded) every row is loaded
// instead: a valid query must never fail because of its SQL translation.
func (h *octoDeckHandler) loadCandidates(ctx context.Context, filter *database.ItemFilter) ([]*octodeckv1.Item, error) {
	items, err := h.db.GetItems(ctx, filter)
	if err == nil || filter == nil || ctx.Err() != nil {
		return items, err
	}
	slog.WarnContext(ctx, "Query prefilter failed; scanning all items", "where", filter.Where, "error", err)
	return h.db.GetItems(ctx, nil)
}

// queryViews applies the configured repository and label filters (so hidden repos and labels
// never match or appear in facets) and prepares the items for evaluation, which also sets their
// computed status.
func (h *octoDeckHandler) queryViews(items []*octodeckv1.Item) []*query.View {
	items = h.filterItemRepos(items)
	h.filterItemLabels(items...)
	return query.NewViews(items, query.Env{CurrentUser: h.currentUser(), KnownBots: h.cfg.GetKnownBots()})
}

// invalidQuery converts a query validation error into InvalidArgument, attaching the ExprError
// detail that identifies the offending node.
func invalidQuery(err error) error {
	cerr := connect.NewError(connect.CodeInvalidArgument, err)
	var verr *query.ValidationError
	if errors.As(err, &verr) {
		if detail, derr := connect.NewErrorDetail(verr.Proto()); derr == nil {
			cerr.AddDetail(detail)
		}
	}
	return cerr
}
