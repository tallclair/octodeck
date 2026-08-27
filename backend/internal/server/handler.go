package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/logic"
)

type octoDeckHandler struct {
	db         *database.DB
	syncEngine SyncEngine
	cfg        *config.Config
	ghClient   GitHubClient
}

func (h *octoDeckHandler) GetConfig(ctx context.Context,
	_ *connect.Request[octodeckv1.GetConfigRequest]) (*connect.Response[octodeckv1.GetConfigResponse], error) {
	var currentUser string
	if h.ghClient != nil {
		currentUser, _, _ = h.ghClient.CheckAuth(ctx)
	}
	res := octodeckv1.GetConfigResponse_builder{
		Config: h.cfg.GetProto(),
	}
	if currentUser != "" {
		res.CurrentUserLogin = &currentUser
	}
	return connect.NewResponse(res.Build()), nil
}

func (h *octoDeckHandler) UpdateConfig(_ context.Context,
	req *connect.Request[octodeckv1.UpdateConfigRequest]) (*connect.Response[octodeckv1.UpdateConfigResponse], error) {
	newCfg := req.Msg.GetConfig()
	if newCfg == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("config is required"))
	}

	if err := logic.ValidateRepoPatterns(newCfg.GetWatchedRepos()); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid watched_repos: %w", err))
	}
	if err := logic.ValidateRepoPatterns(newCfg.GetExcludedRepos()); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid excluded_repos: %w", err))
	}
	if err := logic.ValidateLabelPatterns(newCfg.GetIncludedLabels()); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid included_labels: %w", err))
	}
	if err := logic.ValidateLabelPatterns(newCfg.GetExcludedLabels()); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid excluded_labels: %w", err))
	}

	if err := h.cfg.UpdateProto(newCfg, req.Msg.GetUpdateMask()); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to update config: %w", err))
	}

	if h.syncEngine != nil {
		h.syncEngine.ResetTicker()
	}

	return connect.NewResponse(octodeckv1.UpdateConfigResponse_builder{
		Config: h.cfg.GetProto(),
	}.Build()), nil
}

func (h *octoDeckHandler) filterItemRepos(items []*octodeckv1.Item) []*octodeckv1.Item {
	cfgProto := h.cfg.GetProto()
	if cfgProto == nil {
		return items
	}
	watched := cfgProto.GetWatchedRepos()
	excluded := cfgProto.GetExcludedRepos()
	if len(watched) == 0 && len(excluded) == 0 {
		return items
	}
	return logic.FilterItemsByRepo(items, watched, excluded)
}

func (h *octoDeckHandler) filterItemLabels(items ...*octodeckv1.Item) {
	cfgProto := h.cfg.GetProto()
	if cfgProto == nil {
		return
	}
	included := cfgProto.GetIncludedLabels()
	excluded := cfgProto.GetExcludedLabels()
	if len(included) == 0 && len(excluded) == 0 {
		return
	}
	for _, item := range items {
		if item != nil && len(item.GetLabels()) > 0 {
			item.SetLabels(logic.FilterLabels(item.GetLabels(), included, excluded))
		}
	}
}

func (h *octoDeckHandler) populateComputedStatus(ctx context.Context, items ...*octodeckv1.Item) {
	var currentUser string
	if h.ghClient != nil {
		currentUser, _, _ = h.ghClient.CheckAuth(ctx)
	}
	knownBots := h.cfg.GetKnownBots()

	logic.ClassifyComments(knownBots, items...)

	for _, item := range items {
		if item == nil {
			continue
		}
		if item.GetLocal() == nil {
			item.SetLocal(octodeckv1.ItemLocalState_builder{}.Build())
		}
		statusResult := logic.CalculateStatus(item, currentUser, knownBots)
		item.GetLocal().SetComputedStatus(statusResult.Status)
	}
}

func filterByComputedStatus(items []*octodeckv1.Item, statusFilter []octodeckv1.ItemStatus) []*octodeckv1.Item {
	if len(statusFilter) == 0 {
		return items
	}
	statusSet := make(map[octodeckv1.ItemStatus]bool, len(statusFilter))
	for _, s := range statusFilter {
		statusSet[s] = true
	}
	filtered := make([]*octodeckv1.Item, 0, len(items))
	for _, item := range items {
		if statusSet[item.GetLocal().GetComputedStatus()] {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func filterByMilestone(items []*octodeckv1.Item, milestoneFilter []string) []*octodeckv1.Item {
	if len(milestoneFilter) == 0 {
		return items
	}
	milestoneSet := make(map[string]bool, len(milestoneFilter))
	for _, m := range milestoneFilter {
		milestoneSet[m] = true
	}
	filtered := make([]*octodeckv1.Item, 0, len(items))
	for _, item := range items {
		if item.GetMilestone() != nil && milestoneSet[item.GetMilestone().GetTitle()] {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func filterByLabels(items []*octodeckv1.Item, labelFilter []string) []*octodeckv1.Item {
	if len(labelFilter) == 0 {
		return items
	}
	labelSet := make(map[string]bool, len(labelFilter))
	for _, l := range labelFilter {
		labelSet[strings.ToLower(l)] = true
	}
	filtered := make([]*octodeckv1.Item, 0, len(items))
	for _, item := range items {
		hasMatch := false
		for _, l := range item.GetLabels() {
			if labelSet[strings.ToLower(l.GetName())] {
				hasMatch = true
				break
			}
		}
		if hasMatch {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func (h *octoDeckHandler) GetItems(ctx context.Context,
	req *connect.Request[octodeckv1.GetItemsRequest]) (*connect.Response[octodeckv1.GetItemsResponse], error) {
	items, err := h.db.GetItems(ctx, req.Msg.GetFilter())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to fetch items: %w", err))
	}

	items = h.filterItemRepos(items)
	h.filterItemLabels(items...)
	h.populateComputedStatus(ctx, items...)

	if filter := req.Msg.GetFilter(); filter != nil {
		items = filterByComputedStatus(items, filter.GetStatus())
		items = filterByMilestone(items, filter.GetMilestones())
		items = filterByLabels(items, filter.GetLabels())
	}

	return connect.NewResponse(octodeckv1.GetItemsResponse_builder{
		Items: items,
	}.Build()), nil
}

func (h *octoDeckHandler) GetItem(ctx context.Context,
	req *connect.Request[octodeckv1.GetItemRequest]) (*connect.Response[octodeckv1.GetItemResponse], error) {
	id := req.Msg.GetItemId()
	if id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("item_id is required"))
	}
	item, err := h.db.GetItem(ctx, id)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("item not found: %w", err))
	}

	h.filterItemLabels(item)
	h.populateComputedStatus(ctx, item)

	return connect.NewResponse(octodeckv1.GetItemResponse_builder{
		Item: item,
	}.Build()), nil
}

func (h *octoDeckHandler) Sync(ctx context.Context,
	_ *connect.Request[octodeckv1.SyncRequest],
	stream *connect.ServerStream[octodeckv1.SyncResponse]) error {
	// Send initial status
	if err := stream.Send(octodeckv1.SyncResponse_builder{
		Stage:   config.Ptr(octodeckv1.SyncResponse_STAGE_FETCHING),
		Message: config.Ptr("Starting sync..."),
	}.Build()); err != nil {
		return err
	}

	// Trigger sync
	// TODO: SyncEngine.ForceSync is currently blocking.
	// ideally we would subscribe to progress updates from SyncEngine.
	if err := h.syncEngine.ForceSync(ctx); err != nil {
		return connect.NewError(connect.CodeInternal, fmt.Errorf("sync failed: %w", err))
	}

	// Send complete status
	if err := stream.Send(octodeckv1.SyncResponse_builder{
		Stage:   config.Ptr(octodeckv1.SyncResponse_STAGE_COMPLETE),
		Message: config.Ptr("Sync complete"),
	}.Build()); err != nil {
		return err
	}

	return nil
}

func (h *octoDeckHandler) mutateItemLocalState(
	ctx context.Context,
	id string,
	actionName string,
	allowImportUntracked bool,
	mutateFn func(*octodeckv1.Item, *octodeckv1.ItemLocalState),
) (*octodeckv1.Item, error) {
	if id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("item_id is required"))
	}

	item, err := h.db.UpdateItem(ctx, id, func(item *octodeckv1.Item) error {
		if item.GetLocal() == nil {
			item.SetLocal(octodeckv1.ItemLocalState_builder{}.Build())
		}
		mutateFn(item, item.GetLocal())
		return nil
	})
	if err != nil && allowImportUntracked && h.syncEngine != nil {
		if imported, refetchErr := h.syncEngine.RefetchItem(ctx, id); refetchErr == nil && imported != nil {
			item, err = h.db.UpdateItem(ctx, imported.GetId(), func(item *octodeckv1.Item) error {
				if item.GetLocal() == nil {
					item.SetLocal(octodeckv1.ItemLocalState_builder{}.Build())
				}
				mutateFn(item, item.GetLocal())
				return nil
			})
		}
	}
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || strings.Contains(err.Error(), "no rows in result set") {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("item not found: %w", err))
		}
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to %s item: %w", actionName, err))
	}

	h.filterItemLabels(item)
	h.populateComputedStatus(ctx, item)

	return item, nil
}

func (h *octoDeckHandler) ViewItem(ctx context.Context,
	req *connect.Request[octodeckv1.ViewItemRequest]) (*connect.Response[octodeckv1.ViewItemResponse], error) {
	id := req.Msg.GetItemId()
	item, err := h.mutateItemLocalState(
		ctx, id, "view", false,
		func(_ *octodeckv1.Item, loc *octodeckv1.ItemLocalState) {
			loc.SetLastViewedAt(timestamppb.New(time.Now()))
		},
	)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(octodeckv1.ViewItemResponse_builder{Item: item}.Build()), nil
}

func (h *octoDeckHandler) StarItem(ctx context.Context,
	req *connect.Request[octodeckv1.StarItemRequest]) (*connect.Response[octodeckv1.StarItemResponse], error) {
	id := req.Msg.GetItemId()
	item, err := h.mutateItemLocalState(
		ctx, id, "star", true,
		func(_ *octodeckv1.Item, loc *octodeckv1.ItemLocalState) {
			loc.SetStarred(req.Msg.GetStarred())
		},
	)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(octodeckv1.StarItemResponse_builder{Item: item}.Build()), nil
}

func (h *octoDeckHandler) SetNotes(ctx context.Context,
	req *connect.Request[octodeckv1.SetNotesRequest]) (*connect.Response[octodeckv1.SetNotesResponse], error) {
	id := req.Msg.GetItemId()
	item, err := h.mutateItemLocalState(
		ctx, id, "set notes on", true,
		func(_ *octodeckv1.Item, loc *octodeckv1.ItemLocalState) {
			loc.SetPrivateNotes(req.Msg.GetNotes())
		},
	)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(octodeckv1.SetNotesResponse_builder{Item: item}.Build()), nil
}

func getLatestActivityTimestamp(item *octodeckv1.Item) *timestamppb.Timestamp {
	var maxTime time.Time
	if item.GetUpdatedAt() != nil {
		maxTime = item.GetUpdatedAt().AsTime()
	}
	for _, c := range item.GetComments() {
		if c.GetCreatedAt() != nil && c.GetCreatedAt().AsTime().After(maxTime) {
			maxTime = c.GetCreatedAt().AsTime()
		}
	}
	for _, r := range item.GetReviews() {
		if r.GetSubmittedAt() != nil && r.GetSubmittedAt().AsTime().After(maxTime) {
			maxTime = r.GetSubmittedAt().AsTime()
		}
	}
	for _, e := range item.GetStateEvents() {
		if e.GetCreatedAt() != nil && e.GetCreatedAt().AsTime().After(maxTime) {
			maxTime = e.GetCreatedAt().AsTime()
		}
	}
	if maxTime.IsZero() {
		maxTime = time.Now()
	}
	return timestamppb.New(maxTime)
}

func (h *octoDeckHandler) AckItem(ctx context.Context,
	req *connect.Request[octodeckv1.AckItemRequest]) (*connect.Response[octodeckv1.AckItemResponse], error) {
	acked := true
	if req.Msg.HasAcked() {
		acked = req.Msg.GetAcked()
	}
	id := req.Msg.GetItemId()
	item, err := h.mutateItemLocalState(
		ctx, id, "ack", true,
		func(item *octodeckv1.Item, loc *octodeckv1.ItemLocalState) {
			if acked {
				loc.SetAckedAt(getLatestActivityTimestamp(item))
			} else {
				loc.ClearAckedAt()
			}
		},
	)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(octodeckv1.AckItemResponse_builder{Item: item}.Build()), nil
}

func (h *octoDeckHandler) RefetchItem(ctx context.Context,
	req *connect.Request[octodeckv1.RefetchItemRequest]) (*connect.Response[octodeckv1.RefetchItemResponse], error) {
	id := req.Msg.GetItemId()
	if id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("item_id is required"))
	}
	item, err := h.syncEngine.RefetchItem(ctx, id)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to refetch item: %w", err))
	}

	h.filterItemLabels(item)
	h.populateComputedStatus(ctx, item)

	return connect.NewResponse(octodeckv1.RefetchItemResponse_builder{
		Item: item,
	}.Build()), nil
}

func (h *octoDeckHandler) DeleteItem(ctx context.Context,
	req *connect.Request[octodeckv1.DeleteItemRequest]) (*connect.Response[octodeckv1.DeleteItemResponse], error) {
	id := req.Msg.GetItemId()
	if id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("item_id is required"))
	}
	if err := h.db.DeleteItems(ctx, []string{id}); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to delete item: %w", err))
	}
	return connect.NewResponse(octodeckv1.DeleteItemResponse_builder{}.Build()), nil
}

func (h *octoDeckHandler) GetSyncStatus(_ context.Context,
	_ *connect.Request[octodeckv1.GetSyncStatusRequest]) (*connect.Response[octodeckv1.GetSyncStatusResponse], error) {
	status := h.syncEngine.GetStatus()
	return connect.NewResponse(octodeckv1.GetSyncStatusResponse_builder{
		Status: status,
	}.Build()), nil
}

func (h *octoDeckHandler) GetSyncTraces(
	ctx context.Context,
	req *connect.Request[octodeckv1.GetSyncTracesRequest],
) (*connect.Response[octodeckv1.GetSyncTracesResponse], error) {
	limit := int(req.Msg.GetLimit())
	if limit <= 0 {
		limit = 50
	}
	traceType := req.Msg.GetTraceType()
	includePayload := req.Msg.GetIncludePayload()

	dbTraces, err := h.db.GetSyncTraces(ctx, limit, traceType)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get sync traces: %w", err))
	}

	var protoTraces []*octodeckv1.SyncTrace
	for _, t := range dbTraces {
		var repos []string
		if t.ReposEvaluated != "" {
			_ = json.Unmarshal([]byte(t.ReposEvaluated), &repos)
		}

		var payloadStr string
		if includePayload && len(t.RawPayloadCompressed) > 0 {
			if decomp, err := database.DecompressPayload(t.RawPayloadCompressed); err == nil {
				payloadStr = string(decomp)
			}
		}

		createdAtTime, _ := time.Parse(time.RFC3339, t.CreatedAt)
		var createdAtProto *timestamppb.Timestamp
		if !createdAtTime.IsZero() {
			createdAtProto = timestamppb.New(createdAtTime)
		}

		var rateLimitVal int32
		if t.RateLimitRemaining != nil {
			rateLimitVal = *t.RateLimitRemaining
		}

		protoTraces = append(protoTraces, octodeckv1.SyncTrace_builder{
			Id:                 &t.ID,
			TraceType:          &t.TraceType,
			TriggerSource:      &t.TriggerSource,
			QueryString:        &t.QueryString,
			ReposEvaluated:     repos,
			SinceTimestamp:     &t.SinceTimestamp,
			DurationMs:         &t.DurationMs,
			PagesCount:         &t.PagesCount,
			ItemsFetched:       &t.ItemsFetched,
			ItemsPersisted:     &t.ItemsPersisted,
			RateLimitRemaining: &rateLimitVal,
			ErrorMessage:       &t.ErrorMessage,
			RawPayload:         &payloadStr,
			CreatedAt:          createdAtProto,
		}.Build())
	}

	return connect.NewResponse(octodeckv1.GetSyncTracesResponse_builder{
		Traces: protoTraces,
	}.Build()), nil
}

func (h *octoDeckHandler) GetDatabaseStats(
	ctx context.Context,
	_ *connect.Request[octodeckv1.GetDatabaseStatsRequest],
) (*connect.Response[octodeckv1.GetDatabaseStatsResponse], error) {
	dbPath, _ := h.cfg.GetDBPath()
	stats, err := h.db.GetDatabaseStats(ctx, dbPath)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get database stats: %w", err))
	}
	return connect.NewResponse(octodeckv1.GetDatabaseStatsResponse_builder{
		Stats: stats,
	}.Build()), nil
}
