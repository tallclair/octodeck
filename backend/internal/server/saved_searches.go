package server

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

func (h *octoDeckHandler) CreateSavedSearch(
	_ context.Context,
	req *connect.Request[octodeckv1.CreateSavedSearchRequest],
) (*connect.Response[octodeckv1.CreateSavedSearchResponse], error) {
	created, list, err := h.cfg.CreateSavedSearch(req.Msg.GetSavedSearch())
	if err != nil {
		return nil, savedSearchError(err)
	}
	return connect.NewResponse(octodeckv1.CreateSavedSearchResponse_builder{
		SavedSearch:   created,
		SavedSearches: list,
	}.Build()), nil
}

func (h *octoDeckHandler) UpdateSavedSearch(
	_ context.Context,
	req *connect.Request[octodeckv1.UpdateSavedSearchRequest],
) (*connect.Response[octodeckv1.UpdateSavedSearchResponse], error) {
	list, err := h.cfg.UpdateSavedSearch(req.Msg.GetSavedSearch(), req.Msg.GetUpdateMask())
	if err != nil {
		return nil, savedSearchError(err)
	}
	return connect.NewResponse(octodeckv1.UpdateSavedSearchResponse_builder{
		SavedSearches: list,
	}.Build()), nil
}

func (h *octoDeckHandler) DeleteSavedSearch(
	_ context.Context,
	req *connect.Request[octodeckv1.DeleteSavedSearchRequest],
) (*connect.Response[octodeckv1.DeleteSavedSearchResponse], error) {
	list, err := h.cfg.DeleteSavedSearch(req.Msg.GetId())
	if err != nil {
		return nil, savedSearchError(err)
	}
	return connect.NewResponse(octodeckv1.DeleteSavedSearchResponse_builder{
		SavedSearches: list,
	}.Build()), nil
}

func (h *octoDeckHandler) ReorderSavedSearches(
	_ context.Context,
	req *connect.Request[octodeckv1.ReorderSavedSearchesRequest],
) (*connect.Response[octodeckv1.ReorderSavedSearchesResponse], error) {
	list, err := h.cfg.ReorderSavedSearches(req.Msg.GetIds())
	if err != nil {
		return nil, savedSearchError(err)
	}
	return connect.NewResponse(octodeckv1.ReorderSavedSearchesResponse_builder{
		SavedSearches: list,
	}.Build()), nil
}

func savedSearchError(err error) error {
	switch {
	case errors.Is(err, config.ErrSavedSearchInvalid):
		return connect.NewError(connect.CodeInvalidArgument, err)
	case errors.Is(err, config.ErrSavedSearchNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, config.ErrSavedSearchNameTaken):
		return connect.NewError(connect.CodeAlreadyExists, err)
	case errors.Is(err, config.ErrSavedSearchLimit):
		return connect.NewError(connect.CodeResourceExhausted, err)
	case errors.Is(err, config.ErrSavedSearchStaleOrder):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	default:
		return connect.NewError(connect.CodeInternal, err)
	}
}
