package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/spf13/cobra"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/database"
	"github.com/tallclair/octodeck/backend/internal/github"
	"github.com/tallclair/octodeck/backend/internal/logic"
)

var (
	debugCmd = &cobra.Command{
		Use:   cmdDebugName,
		Short: "Debugging tools for OctoDeck",
	}
	debugDBPath string

	backfillAll    bool
	backfillDryRun bool
)

const (
	cmdDebugName              = "debug"
	defaultTracesLimit        = 20
	tracesCmdName             = "traces"
	traceTypeNotificationSync = "notification_sync"
)

type itemsFetcher interface {
	FetchItems(ctx context.Context, items []*octodeckv1.Item) ([]*octodeckv1.Item, []string, error)
}

func backfillDescriptions(
	ctx context.Context,
	db *database.DB,
	ghClient itemsFetcher,
	all bool,
	dryRun bool,
) (int, error) {
	items, err := db.GetItems(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("failed to fetch items from database: %w", err)
	}

	var itemsToFetch []*octodeckv1.Item
	for _, item := range items {
		if all || item.GetBody() == "" {
			itemsToFetch = append(itemsToFetch, item)
		}
	}

	if len(itemsToFetch) == 0 {
		fmt.Println("No items need description backfill.")
		return 0, nil
	}

	fmt.Printf("Found %d items needing description backfill. Fetching from GitHub...\n", len(itemsToFetch))

	fetched, missing, err := ghClient.FetchItems(ctx, itemsToFetch)
	if err != nil {
		return 0, fmt.Errorf("failed to fetch items from GitHub: %w", err)
	}

	if len(missing) > 0 {
		fmt.Printf("Warning: %d items were not found on GitHub (404/deleted)\n", len(missing))
	}

	fetchedMap := make(map[string]*octodeckv1.Item, len(fetched))
	for _, f := range fetched {
		fetchedMap[f.GetId()] = f
	}

	var itemsToSave []*octodeckv1.Item
	for _, existing := range itemsToFetch {
		if f, ok := fetchedMap[existing.GetId()]; ok {
			if f.GetBody() != "" || all {
				existing.SetBody(f.GetBody())
				itemsToSave = append(itemsToSave, existing)
			}
		}
	}

	if dryRun {
		fmt.Printf("[Dry Run] Would update %d items in database.\n", len(itemsToSave))
		return len(itemsToSave), nil
	}

	if len(itemsToSave) > 0 {
		if err := db.SaveItems(ctx, itemsToSave); err != nil {
			return 0, fmt.Errorf("failed to save backfilled items: %w", err)
		}
	}

	fmt.Printf("Successfully backfilled descriptions for %d items.\n", len(itemsToSave))
	return len(itemsToSave), nil
}

func backfillItems(
	ctx context.Context,
	db *database.DB,
	ghClient itemsFetcher,
	dryRun bool,
) (int, error) {
	items, err := db.GetItems(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("failed to fetch items from database: %w", err)
	}

	if len(items) == 0 {
		fmt.Println("No items in database to backfill.")
		return 0, nil
	}

	fmt.Printf("Found %d items in database. Fetching latest details from GitHub...\n", len(items))

	fetched, missing, err := ghClient.FetchItems(ctx, items)
	if err != nil {
		return 0, fmt.Errorf("failed to fetch items from GitHub: %w", err)
	}

	if len(missing) > 0 {
		fmt.Printf("Warning: %d items were not found on GitHub (404/deleted)\n", len(missing))
	}

	existingMap := make(map[string]*octodeckv1.Item, len(items))
	for _, item := range items {
		existingMap[item.GetId()] = item
	}

	var itemsToSave []*octodeckv1.Item
	now := time.Now()
	for _, f := range fetched {
		f.SetLastSyncedAt(timestamppb.New(now))
		if existing, ok := existingMap[f.GetId()]; ok {
			f.SetLocal(existing.GetLocal())
		}
		itemsToSave = append(itemsToSave, f)
	}

	if dryRun {
		fmt.Printf("[Dry Run] Would update %d items in database.\n", len(itemsToSave))
		return len(itemsToSave), nil
	}

	if len(itemsToSave) > 0 {
		if err := db.SaveItems(ctx, itemsToSave); err != nil {
			return 0, fmt.Errorf("failed to save backfilled items: %w", err)
		}
	}

	fmt.Printf("Successfully backfilled %d items in database.\n", len(itemsToSave))
	return len(itemsToSave), nil
}

func findItem(items []*octodeckv1.Item, id string) *octodeckv1.Item {
	for _, it := range items {
		if it.GetId() == id || strconv.Itoa(int(it.GetNumber())) == id ||
			fmt.Sprintf("%s#%d", it.GetRepo(), it.GetNumber()) == id {
			return it
		}
	}
	return nil
}

var debugItemCmd = &cobra.Command{
	Use:   "item [id]",
	Short: "Inspect a specific item in the database",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) (err error) {
		itemID := args[0]
		asJSON, err := cmd.Flags().GetBool("json")
		if err != nil {
			return fmt.Errorf("failed to read --json flag: %w", err)
		}

		overrides := config.Overrides{
			DBPath: debugDBPath,
		}
		cfg, err := config.Load(configPath, overrides)
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		dbPath, err := cfg.GetDBPath()
		if err != nil {
			return fmt.Errorf("could not determine database path: %w", err)
		}
		db, err := database.Init(cmd.Context(), dbPath)
		if err != nil {
			return fmt.Errorf("failed to initialize database: %w", err)
		}
		defer func() {
			if closeErr := db.Close(); closeErr != nil {
				err = errors.Join(err, closeErr)
			}
		}()

		item, err := db.GetItem(cmd.Context(), itemID)
		if err != nil {
			items, listErr := db.GetItems(cmd.Context(), nil)
			if listErr == nil {
				if match := findItem(items, itemID); match != nil {
					item = match
					err = nil
				}
			}
		}
		if err != nil {
			return fmt.Errorf("failed to get item %s: %w", itemID, err)
		}

		if item.GetLocal() == nil {
			item.SetLocal(octodeckv1.ItemLocalState_builder{}.Build())
		}
		var currentUser string
		if ghClient, err := github.NewClient(); err == nil {
			currentUser, _, _ = ghClient.CheckAuth(cmd.Context())
		}
		statusResult := logic.CalculateStatus(item, currentUser, cfg.GetKnownBots())
		item.GetLocal().SetComputedStatus(statusResult.Status)

		if asJSON {
			marshaller := protojson.MarshalOptions{
				Multiline: true,
				Indent:    "  ",
			}
			jsonStr, err := marshaller.Marshal(item)
			if err != nil {
				return fmt.Errorf("failed to marshal item to JSON: %w", err)
			}
			fmt.Println(string(jsonStr))
		} else {
			fmt.Printf("ID: %s\n", item.GetId())
			fmt.Printf("Repo: %s\n", item.GetRepo())
			fmt.Printf("Title: %s\n", item.GetTitle())
			fmt.Printf("State: %s\n", item.GetState())
			fmt.Printf("Status: %s\n", item.GetLocal().GetComputedStatus())
		}
		return nil
	},
}

var debugRefetchItemCmd = &cobra.Command{
	Use:   "refetch-item [id]",
	Short: "Refetch an item from GitHub and update it in the database",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) (err error) {
		ctx := cmd.Context()
		itemID := args[0]
		overrides := config.Overrides{
			DBPath: debugDBPath,
		}
		cfg, err := config.Load(configPath, overrides)
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		dbPath, err := cfg.GetDBPath()
		if err != nil {
			return fmt.Errorf("could not determine database path: %w", err)
		}
		db, err := database.Init(ctx, dbPath)
		if err != nil {
			return fmt.Errorf("failed to initialize database: %w", err)
		}
		defer func() {
			if closeErr := db.Close(); closeErr != nil {
				err = errors.Join(err, closeErr)
			}
		}()

		item, err := db.GetItem(ctx, itemID)
		if err != nil {
			items, listErr := db.GetItems(ctx, nil)
			if listErr == nil {
				if match := findItem(items, itemID); match != nil {
					item = match
					err = nil
				}
			}
		}
		if err != nil {
			return fmt.Errorf("item %s not found in database: %w", itemID, err)
		}
		itemID = item.GetId()

		ghClient, err := github.NewClient()
		if err != nil {
			return fmt.Errorf("failed to initialize GitHub client: %w", err)
		}

		syncEngine := logic.NewSyncEngine(db, ghClient, cfg)
		updated, err := syncEngine.RefetchItem(ctx, itemID)
		if err != nil {
			return fmt.Errorf("failed to refetch item: %w", err)
		}

		fmt.Printf("Successfully refetched and updated item %s (%s #%d)\n",
			updated.GetId(), updated.GetRepo(), updated.GetNumber())
		return nil
	},
}

var debugBackfillDescriptionsCmd = &cobra.Command{
	Use:   "backfill-descriptions",
	Short: "Backfill missing PR and Issue descriptions from GitHub",
	RunE: func(cmd *cobra.Command, args []string) (err error) {
		ctx := cmd.Context()
		overrides := config.Overrides{
			DBPath: debugDBPath,
		}
		cfg, err := config.Load(configPath, overrides)
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		dbPath, err := cfg.GetDBPath()
		if err != nil {
			return fmt.Errorf("could not determine database path: %w", err)
		}
		db, err := database.Init(ctx, dbPath)
		if err != nil {
			return fmt.Errorf("failed to initialize database: %w", err)
		}
		defer func() {
			if closeErr := db.Close(); closeErr != nil {
				err = errors.Join(err, closeErr)
			}
		}()

		ghClient, err := github.NewClient()
		if err != nil {
			return fmt.Errorf("failed to initialize GitHub client: %w", err)
		}

		_, err = backfillDescriptions(ctx, db, ghClient, backfillAll, backfillDryRun)
		return err
	},
}

var debugBackfillItemsCmd = &cobra.Command{
	Use:     "backfill-items",
	Aliases: []string{"backfill"},
	Short:   "Backfill all item details from GitHub for items already in the database",
	RunE: func(cmd *cobra.Command, args []string) (err error) {
		ctx := cmd.Context()
		overrides := config.Overrides{
			DBPath: debugDBPath,
		}
		cfg, err := config.Load(configPath, overrides)
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		dbPath, err := cfg.GetDBPath()
		if err != nil {
			return fmt.Errorf("could not determine database path: %w", err)
		}
		db, err := database.Init(ctx, dbPath)
		if err != nil {
			return fmt.Errorf("failed to initialize database: %w", err)
		}
		defer func() {
			if closeErr := db.Close(); closeErr != nil {
				err = errors.Join(err, closeErr)
			}
		}()

		ghClient, err := github.NewClient()
		if err != nil {
			return fmt.Errorf("failed to initialize GitHub client: %w", err)
		}

		dryRun, _ := cmd.Flags().GetBool("dry-run")
		_, err = backfillItems(ctx, db, ghClient, dryRun)
		return err
	},
}

func formatTraceStatus(t *database.SyncTrace) string {
	if t.ErrorMessage != "" {
		return fmt.Sprintf("ERR: %s", t.ErrorMessage)
	}
	if t.TraceType != traceTypeNotificationSync || len(t.RawPayloadCompressed) == 0 {
		return "OK"
	}
	decomp, err := database.DecompressPayload(t.RawPayloadCompressed)
	if err != nil {
		return "OK"
	}
	var p logic.NotificationSyncPayload
	if err := json.Unmarshal(decomp, &p); err != nil {
		return "OK"
	}
	switch p.HTTPStatus {
	case http.StatusNotModified:
		return "304 Not Modified"
	case http.StatusOK:
		return fmt.Sprintf("200 OK (%d notifs)", p.NotificationsCount)
	case 0:
		return "OK"
	default:
		return strconv.Itoa(p.HTTPStatus)
	}
}

func runDebugTraces(
	ctx context.Context,
	db *database.DB,
	limit int,
	traceType string,
	asJSON bool,
	out io.Writer,
) error {
	traces, err := db.GetSyncTraces(ctx, limit, traceType)
	if err != nil {
		return fmt.Errorf("failed to get sync traces: %w", err)
	}

	if asJSON {
		bytes, jsonErr := json.MarshalIndent(traces, "", "  ")
		if jsonErr != nil {
			return fmt.Errorf("failed to marshal traces to JSON: %w", jsonErr)
		}
		fmt.Fprintln(out, string(bytes))
		return nil
	}

	if len(traces) == 0 {
		fmt.Fprintln(out, "No sync traces found.")
		return nil
	}

	fmt.Fprintf(out, "%-32s %-18s %-12s %-20s %-8s %-8s %s\n",
		"TRACE ID", "TYPE", "SOURCE", "CREATED AT", "DUR(ms)", "ITEMS", "STATUS")
	for _, t := range traces {
		status := formatTraceStatus(t)
		fmt.Fprintf(out, "%-32s %-18s %-12s %-20s %-8d %-8d %s\n",
			t.ID, t.TraceType, t.TriggerSource, t.CreatedAt, t.DurationMs, t.ItemsFetched, status)
	}
	return nil
}

var debugTracesCmd = &cobra.Command{
	Use:   tracesCmdName,
	Short: "List recent synchronization and debug traces",
	RunE: func(cmd *cobra.Command, args []string) (err error) {
		ctx := cmd.Context()
		limit, _ := cmd.Flags().GetInt("limit")
		traceType, _ := cmd.Flags().GetString("type")
		asJSON, _ := cmd.Flags().GetBool("json")

		overrides := config.Overrides{DBPath: debugDBPath}
		cfg, err := config.Load(configPath, overrides)
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		dbPath, err := cfg.GetDBPath()
		if err != nil {
			return fmt.Errorf("could not determine database path: %w", err)
		}
		db, err := database.Init(ctx, dbPath)
		if err != nil {
			return fmt.Errorf("failed to initialize database: %w", err)
		}
		defer func() {
			if closeErr := db.Close(); closeErr != nil {
				err = errors.Join(err, closeErr)
			}
		}()

		return runDebugTraces(ctx, db, limit, traceType, asJSON, cmd.OutOrStdout())
	},
}

func printTraceMetadata(out io.Writer, trace *database.SyncTrace) {
	fmt.Fprintf(out, "ID:             %s\n", trace.ID)
	fmt.Fprintf(out, "Type:           %s\n", trace.TraceType)
	fmt.Fprintf(out, "Trigger Source: %s\n", trace.TriggerSource)
	fmt.Fprintf(out, "Created At:     %s\n", trace.CreatedAt)
	fmt.Fprintf(out, "Duration:       %d ms\n", trace.DurationMs)
	if trace.QueryString != "" {
		fmt.Fprintf(out, "Query:          %s\n", trace.QueryString)
	}
	if trace.ReposEvaluated != "" {
		fmt.Fprintf(out, "Repos:          %s\n", trace.ReposEvaluated)
	}
	if trace.SinceTimestamp != "" {
		fmt.Fprintf(out, "Since:          %s\n", trace.SinceTimestamp)
	}
	fmt.Fprintf(out, "Items Fetched:  %d\n", trace.ItemsFetched)
	fmt.Fprintf(out, "Items Saved:    %d\n", trace.ItemsPersisted)
	if trace.RateLimitRemaining != nil {
		fmt.Fprintf(out, "Rate Limit Rem: %d\n", *trace.RateLimitRemaining)
	}
	if trace.ErrorMessage != "" {
		fmt.Fprintf(out, "Error:          %s\n", trace.ErrorMessage)
	}
}

func printTraceNotificationMetrics(out io.Writer, trace *database.SyncTrace) {
	if trace.TraceType != traceTypeNotificationSync || len(trace.RawPayloadCompressed) == 0 {
		return
	}
	decompressed, decompErr := database.DecompressPayload(trace.RawPayloadCompressed)
	if decompErr != nil {
		return
	}
	var payload logic.NotificationSyncPayload
	if jsonErr := json.Unmarshal(decompressed, &payload); jsonErr == nil {
		printNotificationSyncDetails(out, payload)
	}
}

func printRawPayloadIfRequested(out io.Writer, compressed []byte, show bool) {
	if !show || len(compressed) == 0 {
		return
	}
	decompressed, decompErr := database.DecompressPayload(compressed)
	if decompErr != nil {
		fmt.Fprintf(out, "Payload Decompress Error: %v\n", decompErr)
		return
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, decompressed, "", "  "); err == nil {
		fmt.Fprintf(out, "\n--- Raw Payload ---\n%s\n", pretty.String())
	} else {
		fmt.Fprintf(out, "\n--- Raw Payload ---\n%s\n", string(decompressed))
	}
}

func runDebugTrace(
	ctx context.Context,
	db *database.DB,
	traceID string,
	asJSON bool,
	showPayload bool,
	out io.Writer,
) error {
	trace, err := db.GetSyncTrace(ctx, traceID)
	if err != nil {
		return fmt.Errorf("failed to get sync trace %s: %w", traceID, err)
	}

	if asJSON {
		if showPayload && len(trace.RawPayloadCompressed) > 0 {
			return printNotificationSyncTraceJSON(out, trace)
		}
		bytes, jsonErr := json.MarshalIndent(trace, "", "  ")
		if jsonErr != nil {
			return fmt.Errorf("failed to marshal trace to JSON: %w", jsonErr)
		}
		fmt.Fprintln(out, string(bytes))
		return nil
	}

	printTraceMetadata(out, trace)
	printTraceNotificationMetrics(out, trace)
	printRawPayloadIfRequested(out, trace.RawPayloadCompressed, showPayload)
	return nil
}

var debugTraceCmd = &cobra.Command{
	Use:   "trace [id]",
	Short: "Inspect a specific sync trace by ID",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) (err error) {
		ctx := cmd.Context()
		traceID := args[0]
		asJSON, _ := cmd.Flags().GetBool("json")
		showPayload, _ := cmd.Flags().GetBool("payload")

		overrides := config.Overrides{DBPath: debugDBPath}
		cfg, err := config.Load(configPath, overrides)
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		dbPath, err := cfg.GetDBPath()
		if err != nil {
			return fmt.Errorf("could not determine database path: %w", err)
		}
		db, err := database.Init(ctx, dbPath)
		if err != nil {
			return fmt.Errorf("failed to initialize database: %w", err)
		}
		defer func() {
			if closeErr := db.Close(); closeErr != nil {
				err = errors.Join(err, closeErr)
			}
		}()

		return runDebugTrace(ctx, db, traceID, asJSON, showPayload, cmd.OutOrStdout())
	},
}

const (
	maxDebugTitleLength  = 60
	maxDebugTitleDisplay = 57
)

type notificationsFetcher interface {
	FetchNotifications(
		ctx context.Context,
		since time.Time,
		lastModified string,
	) ([]github.NotificationThread, string, int, error)
}

func parseSince(sinceStr string) (time.Time, error) {
	if sinceStr == "" {
		return time.Time{}, nil
	}
	if dur, err := time.ParseDuration(sinceStr); err == nil {
		return time.Now().Add(-dur), nil
	}
	if t, err := time.Parse(time.RFC3339, sinceStr); err == nil {
		return t, nil
	}
	if t, err := time.Parse("2006-01-02T15:04:05Z0700", sinceStr); err == nil {
		return t, nil
	}
	if t, err := time.Parse("2006-01-02", sinceStr); err == nil {
		return t, nil
	}
	return time.Time{}, fmt.Errorf(
		"invalid timestamp/duration format %q (expected duration like '24h' or RFC3339 timestamp)",
		sinceStr,
	)
}

func runDebugNotifications(
	ctx context.Context,
	fetcher notificationsFetcher,
	sinceStr string,
	lastModifiedHeader string,
	asJSON bool,
	out io.Writer,
) error {
	var since time.Time
	if sinceStr != "" {
		var err error
		since, err = parseSince(sinceStr)
		if err != nil {
			return err
		}
	}

	threads, lastModified, status, err := fetcher.FetchNotifications(ctx, since, lastModifiedHeader)
	if err != nil {
		return fmt.Errorf("failed to fetch notifications: %w", err)
	}

	if asJSON {
		output := struct {
			HTTPStatus   int                         `json:"http_status"`
			LastModified string                      `json:"last_modified"`
			Count        int                         `json:"count"`
			Threads      []github.NotificationThread `json:"threads"`
		}{
			HTTPStatus:   status,
			LastModified: lastModified,
			Count:        len(threads),
			Threads:      threads,
		}
		bytes, jsonErr := json.MarshalIndent(output, "", "  ")
		if jsonErr != nil {
			return fmt.Errorf("failed to marshal notifications to JSON: %w", jsonErr)
		}
		fmt.Fprintln(out, string(bytes))
		return nil
	}

	fmt.Fprintf(out, "HTTP Status:   %d\n", status)
	fmt.Fprintf(out, "Last-Modified: %s\n", lastModified)
	fmt.Fprintf(out, "Count:         %d\n\n", len(threads))

	if len(threads) == 0 {
		if status == http.StatusNotModified {
			fmt.Fprintln(out, "No new notifications (304 Not Modified).")
		} else {
			fmt.Fprintln(out, "No notifications returned.")
		}
		return nil
	}

	fmt.Fprintf(out, "%-14s %-12s %-18s %-7s %-35s %s\n",
		"THREAD ID", "TYPE", "REASON", "UNREAD", "REPO", "TITLE")
	for _, t := range threads {
		title := t.Subject.Title
		if len(title) > maxDebugTitleLength {
			title = title[:maxDebugTitleDisplay] + "..."
		}
		fmt.Fprintf(out, "%-14s %-12s %-18s %-7t %-35s %s\n",
			t.ID, t.Subject.Type, t.Reason, t.Unread, t.Repository.FullName, title)
	}
	return nil
}

var debugNotificationsCmd = &cobra.Command{
	Use:   "notifications",
	Short: "Fetch and inspect GitHub notifications directly via REST API",
	RunE: func(cmd *cobra.Command, _ []string) error {
		ctx := cmd.Context()
		sinceStr, _ := cmd.Flags().GetString("since")
		lastModifiedHeader, _ := cmd.Flags().GetString("last-modified")
		asJSON, _ := cmd.Flags().GetBool("json")

		ghClient, err := github.NewClient()
		if err != nil {
			return fmt.Errorf("failed to initialize GitHub client: %w", err)
		}

		return runDebugNotifications(ctx, ghClient, sinceStr, lastModifiedHeader, asJSON, cmd.OutOrStdout())
	},
}

type nodeIDResolver interface {
	ResolveNodeIDs(ctx context.Context, targets []github.ItemTarget) (map[github.ItemTarget]string, error)
}

type itemHydrator interface {
	FetchItemsByIDs(ctx context.Context, ids []string) ([]*octodeckv1.Item, []string, error)
}

func runDebugResolveIDs(
	ctx context.Context,
	resolver nodeIDResolver,
	targetStrs []string,
	asJSON bool,
	out io.Writer,
) error {
	if len(targetStrs) == 0 {
		return errors.New("at least one target (owner/repo#number) is required")
	}

	targets := make([]github.ItemTarget, 0, len(targetStrs))
	for _, s := range targetStrs {
		target, err := github.ParseItemTarget(s)
		if err != nil {
			return fmt.Errorf("invalid target %q: %w", s, err)
		}
		targets = append(targets, target)
	}

	resolved, err := resolver.ResolveNodeIDs(ctx, targets)
	if err != nil {
		return fmt.Errorf("failed to resolve node IDs: %w", err)
	}

	if asJSON {
		result := make(map[string]*string, len(targets))
		for _, target := range targets {
			if id, ok := resolved[target]; ok {
				idCopy := id
				result[target.Key()] = &idCopy
			} else {
				result[target.Key()] = nil
			}
		}
		bytes, jsonErr := json.MarshalIndent(result, "", "  ")
		if jsonErr != nil {
			return fmt.Errorf("failed to marshal results to JSON: %w", jsonErr)
		}
		fmt.Fprintln(out, string(bytes))
		return nil
	}

	fmt.Fprintf(out, "%-40s %s\n", "TARGET", "NODE ID")
	for _, target := range targets {
		if id, ok := resolved[target]; ok {
			fmt.Fprintf(out, "%-40s %s\n", target.Key(), id)
		} else {
			fmt.Fprintf(out, "%-40s %s\n", target.Key(), "<not found>")
		}
	}
	return nil
}

var debugResolveIDsCmd = &cobra.Command{
	Use:   "resolve-ids [target...]",
	Short: "Resolve GitHub owner/repo#number targets to GraphQL node IDs",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		asJSON, _ := cmd.Flags().GetBool("json")
		ghClient, err := github.NewClient()
		if err != nil {
			return fmt.Errorf("failed to initialize GitHub client: %w", err)
		}
		return runDebugResolveIDs(cmd.Context(), ghClient, args, asJSON, cmd.OutOrStdout())
	},
}

func runDebugHydrateItems(
	ctx context.Context,
	hydrator itemHydrator,
	ids []string,
	asJSON bool,
	out io.Writer,
) error {
	if len(ids) == 0 {
		return errors.New("at least one node ID is required")
	}

	items, missing, err := hydrator.FetchItemsByIDs(ctx, ids)
	if err != nil {
		return fmt.Errorf("failed to hydrate items: %w", err)
	}

	if asJSON {
		marshaller := protojson.MarshalOptions{
			Multiline: true,
			Indent:    "  ",
		}
		type hydrateJSONOutput struct {
			Items   []json.RawMessage `json:"items"`
			Missing []string          `json:"missing"`
		}
		var rawItems []json.RawMessage
		for _, item := range items {
			itemJSON, mErr := marshaller.Marshal(item)
			if mErr != nil {
				return fmt.Errorf("failed to marshal item to JSON: %w", mErr)
			}
			rawItems = append(rawItems, itemJSON)
		}
		output := hydrateJSONOutput{
			Items:   rawItems,
			Missing: missing,
		}
		bytes, jsonErr := json.MarshalIndent(output, "", "  ")
		if jsonErr != nil {
			return fmt.Errorf("failed to marshal hydrate output to JSON: %w", jsonErr)
		}
		fmt.Fprintln(out, string(bytes))
		return nil
	}

	if len(items) == 0 {
		fmt.Fprintln(out, "No items found.")
	} else {
		fmt.Fprintf(out, "%-32s %-8s %-30s %-8s %-15s %s\n",
			"NODE ID", "TYPE", "REPO", "NUMBER", "SUBSCRIPTION", "TITLE")
		for _, it := range items {
			typeStr := "ISSUE"
			if it.GetType() == octodeckv1.ItemType_ITEM_TYPE_PR {
				typeStr = "PR"
			}
			subStr := it.GetViewerSubscription().String()
			fmt.Fprintf(out, "%-32s %-8s %-30s %-8d %-15s %s\n",
				it.GetId(), typeStr, it.GetRepo(), it.GetNumber(), subStr, it.GetTitle())
		}
	}

	if len(missing) > 0 {
		fmt.Fprintf(out, "\nMissing / Not Found IDs (%d):\n", len(missing))
		for _, m := range missing {
			fmt.Fprintf(out, "  - %s\n", m)
		}
	}
	return nil
}

var debugHydrateItemsCmd = &cobra.Command{
	Use:   "hydrate-items [node-id...]",
	Short: "Hydrate and inspect items directly from GitHub via GraphQL node IDs",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		asJSON, _ := cmd.Flags().GetBool("json")
		ghClient, err := github.NewClient()
		if err != nil {
			return fmt.Errorf("failed to initialize GitHub client: %w", err)
		}
		return runDebugHydrateItems(cmd.Context(), ghClient, args, asJSON, cmd.OutOrStdout())
	},
}

type syncEngineRunner interface {
	RunIncrementalSync(ctx context.Context) error
	ForceSync(ctx context.Context) error
}

func printNotificationSyncTraceJSON(out io.Writer, trace *database.SyncTrace) error {
	if len(trace.RawPayloadCompressed) > 0 {
		decompressed, decompErr := database.DecompressPayload(trace.RawPayloadCompressed)
		if decompErr == nil {
			var prettyJSON bytes.Buffer
			if err := json.Indent(&prettyJSON, decompressed, "", "  "); err == nil {
				fmt.Fprintln(out, prettyJSON.String())
				return nil
			}
			fmt.Fprintln(out, string(decompressed))
			return nil
		}
	}
	bytes, jsonErr := json.MarshalIndent(trace, "", "  ")
	if jsonErr != nil {
		return fmt.Errorf("failed to marshal trace to JSON: %w", jsonErr)
	}
	fmt.Fprintln(out, string(bytes))
	return nil
}

func printNotificationSyncDetails(out io.Writer, payload logic.NotificationSyncPayload) {
	fmt.Fprintf(out, "HTTP Status:    %d\n", payload.HTTPStatus)
	if payload.LastModified != "" {
		fmt.Fprintf(out, "Last-Modified:  %s\n", payload.LastModified)
	}
	fmt.Fprintf(out, "Notifications:  %d\n", payload.NotificationsCount)
	if payload.FilteredByRepoCount > 0 {
		fmt.Fprintf(out, "Filtered Repos: %d\n", payload.FilteredByRepoCount)
	}
	if len(payload.ReasonsBreakdown) > 0 {
		fmt.Fprintln(out, "Reasons:")
		for r, count := range payload.ReasonsBreakdown {
			fmt.Fprintf(out, "  - %s: %d\n", r, count)
		}
	}
	if len(payload.UnsupportedTypes) > 0 {
		fmt.Fprintln(out, "Unsupported Types:")
		for u, count := range payload.UnsupportedTypes {
			fmt.Fprintf(out, "  - %s: %d\n", u, count)
		}
	}
	if len(payload.HydratedItems) > 0 {
		fmt.Fprintf(out, "Hydrated Items: %d\n", len(payload.HydratedItems))
		for _, itemID := range payload.HydratedItems {
			fmt.Fprintf(out, "  - %s\n", itemID)
		}
	}
	if len(payload.HydrationErrors) > 0 {
		fmt.Fprintln(out, "Hydration Errors:")
		for k, v := range payload.HydrationErrors {
			fmt.Fprintf(out, "  - %s: %s\n", k, v)
		}
	}
}

func printNotificationSyncTraceText(out io.Writer, trace *database.SyncTrace) {
	fmt.Fprintf(out, "Trace ID:       %s\n", trace.ID)
	fmt.Fprintf(out, "Trigger Source: %s\n", trace.TriggerSource)
	fmt.Fprintf(out, "Duration:       %d ms\n", trace.DurationMs)
	fmt.Fprintf(out, "Items Fetched:  %d\n", trace.ItemsFetched)
	fmt.Fprintf(out, "Items Saved:    %d\n", trace.ItemsPersisted)
	if trace.ErrorMessage != "" {
		fmt.Fprintf(out, "Error:          %s\n", trace.ErrorMessage)
	}

	if len(trace.RawPayloadCompressed) == 0 {
		return
	}
	decompressed, decompErr := database.DecompressPayload(trace.RawPayloadCompressed)
	if decompErr != nil {
		return
	}
	var payload logic.NotificationSyncPayload
	if jsonErr := json.Unmarshal(decompressed, &payload); jsonErr == nil {
		printNotificationSyncDetails(out, payload)
	}
}

func runDebugSyncNotifications(
	ctx context.Context,
	db *database.DB,
	engine syncEngineRunner,
	force bool,
	asJSON bool,
	out io.Writer,
) error {
	var syncErr error
	if force {
		syncErr = engine.ForceSync(ctx)
	} else {
		syncErr = engine.RunIncrementalSync(ctx)
	}
	if syncErr != nil {
		return fmt.Errorf("sync failed: %w", syncErr)
	}

	if db == nil {
		fmt.Fprintln(out, "Sync completed successfully.")
		return nil
	}

	traces, err := db.GetSyncTraces(ctx, 1, "notification_sync")
	if err != nil {
		return fmt.Errorf("failed to retrieve sync trace: %w", err)
	}
	if len(traces) == 0 {
		fmt.Fprintln(out, "Sync completed successfully (no trace recorded).")
		return nil
	}

	latestTrace := traces[0]
	if asJSON {
		return printNotificationSyncTraceJSON(out, latestTrace)
	}

	printNotificationSyncTraceText(out, latestTrace)
	return nil
}

var debugSyncNotificationsCmd = &cobra.Command{
	Use:     "sync-notifications",
	Aliases: []string{"sync"},
	Short:   "Run incremental notification synchronization against GitHub and update local database",
	RunE: func(cmd *cobra.Command, _ []string) (err error) {
		ctx := cmd.Context()
		force, _ := cmd.Flags().GetBool("force")
		asJSON, _ := cmd.Flags().GetBool("json")

		overrides := config.Overrides{DBPath: debugDBPath}
		cfg, err := config.Load(configPath, overrides)
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		dbPath, err := cfg.GetDBPath()
		if err != nil {
			return fmt.Errorf("could not determine database path: %w", err)
		}
		db, err := database.Init(ctx, dbPath)
		if err != nil {
			return fmt.Errorf("failed to initialize database: %w", err)
		}
		defer func() {
			if closeErr := db.Close(); closeErr != nil {
				err = errors.Join(err, closeErr)
			}
		}()

		ghClient, err := github.NewClient()
		if err != nil {
			return fmt.Errorf("failed to initialize GitHub client: %w", err)
		}

		syncEngine := logic.NewSyncEngine(db, ghClient, cfg)
		return runDebugSyncNotifications(ctx, db, syncEngine, force, asJSON, cmd.OutOrStdout())
	},
}

func init() {
	rootCmd.AddCommand(debugCmd)
	debugCmd.PersistentFlags().StringVar(&debugDBPath, "db-path", "",
		"Path to SQLite database (default ~/.octodeck/octodeck.db)")

	debugCmd.AddCommand(debugItemCmd)
	debugItemCmd.Flags().Bool("json", false, "Output full item as JSON")

	debugCmd.AddCommand(debugRefetchItemCmd)

	debugCmd.AddCommand(debugBackfillDescriptionsCmd)
	debugBackfillDescriptionsCmd.Flags().BoolVar(&backfillAll, "all", false,
		"Re-fetch and overwrite descriptions for all items")
	debugBackfillDescriptionsCmd.Flags().BoolVar(&backfillDryRun, "dry-run", false,
		"Fetch and preview updates without saving to database")

	debugCmd.AddCommand(debugBackfillItemsCmd)
	debugBackfillItemsCmd.Flags().BoolVar(&backfillDryRun, "dry-run", false,
		"Fetch and preview updates without saving to database")

	debugCmd.AddCommand(debugTracesCmd)
	debugTracesCmd.Flags().Int("limit", defaultTracesLimit, "Maximum number of traces to list")
	debugTracesCmd.Flags().String("type", "", "Filter traces by type (e.g. heartbeat, inventory, refetch)")
	debugTracesCmd.Flags().Bool("json", false, "Output traces as JSON")

	debugCmd.AddCommand(debugTraceCmd)
	debugTraceCmd.Flags().Bool("json", false, "Output trace as JSON")
	debugTraceCmd.Flags().Bool("payload", false, "Decompress and display raw payload")

	debugCmd.AddCommand(debugNotificationsCmd)
	debugNotificationsCmd.Flags().String("since", "",
		"Filter notifications since duration (e.g. 24h, 15m) or RFC3339 timestamp")
	debugNotificationsCmd.Flags().Bool("all", true, "Include read notifications")
	debugNotificationsCmd.Flags().String("last-modified", "", "HTTP If-Modified-Since header string")
	debugNotificationsCmd.Flags().Bool("json", false, "Output notifications as JSON")

	debugCmd.AddCommand(debugResolveIDsCmd)
	debugResolveIDsCmd.Flags().Bool("json", false, "Output resolved IDs as JSON")

	debugCmd.AddCommand(debugHydrateItemsCmd)
	debugHydrateItemsCmd.Flags().Bool("json", false, "Output hydrated items as JSON")

	debugCmd.AddCommand(debugSyncNotificationsCmd)
	debugSyncNotificationsCmd.Flags().Bool("force", false, "Force sync bypassing HTTP 304 conditional caching")
	debugSyncNotificationsCmd.Flags().Bool("json", false, "Output sync trace diagnostics as JSON")
}
