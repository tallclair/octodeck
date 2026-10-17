# Query Model Phase 3: Saved Searches

**Status:** Ready to implement after Phase 2.
**Overview:** [query_model_plan_overview.md](query_model_plan_overview.md) (ground rules, user decisions U1–U14, scope, module map, testing strategy).
**Parent design:** [query_model_design.md](query_model_design.md) (§4.6 triage scope, §5 API).
**Tracking:** [#14 Saved searches](https://github.com/tallclair/octodeck/issues/14)

This document is self-contained for the agent implementing Phase 3. Read the [overview's ground rules](query_model_plan_overview.md#1-ground-rules-for-the-implementer) first.

---

## 1. Prerequisites

- **Phase 2 merged** ([query_model_phase2_query_input.md](query_model_phase2_query_input.md)), and therefore Phase 1. Phase 3 relies on:
  - `parseQuery`, `canonicalQuery` and `toExpr(parsed)` from `frontend/src/logic/query/syntax/` and [`expr.ts`](../../frontend/src/logic/query/expr.ts): saved searches are stored as text and parsed in the browser ([Phase 2 §3](query_model_phase2_query_input.md));
  - the text state of record and `useDashboardFilters` API (`state.text`, `parsed`, `setText`, edit kinds and updater-based setters) ([Phase 2 §4](query_model_phase2_query_input.md#4-state-model-p6)); this phase adds `openSavedSearch` to it (commit 3.9);
  - the clause splices `insertClause`/`removeClause` ([Phase 2 §5](query_model_phase2_query_input.md#5-keeping-input-dropdowns-and-tabs-in-sync-p7)) and the two tab entry points (title menu = in-place tab switch; sidebar Workflow rows = reset text and sort to the tab alone), stated once in [Phase 1 §3.4](query_model_phase1_multiselect.md#34-activity-menu-and-the-new-tab-p4);
  - the query input in the list header, where the pin button goes ([Phase 2 §9](query_model_phase2_query_input.md)), and the error-chip style used for invalid saved text ([Phase 2 §6.3](query_model_phase2_query_input.md));
  - `DashboardSidebar` and `SidebarRow` from the Phase 1 extraction ([Phase 1 §7](query_model_phase1_multiselect.md)).
- User decisions that apply here: U4, U6, U10, U12, U13, U14 ([overview](query_model_plan_overview.md#21-decided-by-the-user)).

---

## 2. Goals, non-goals and UI

Goals: replace pinned repositories in the "Pinned" sidebar section with saved searches (#14): an inset pin button inside the query input, a pin/edit modal, a sidebar section with badges, and an edit mode with reorder handles, edit button and delete. Convert existing `pinned_repos`.

Non-goals:
- Evaluating saved searches in the daemon on its own (per-search notifications, a CLI). The daemon stores text and never parses it (U13); a Go parser is added if a Go-side text consumer ever appears (parent §3.3).
- Reducing polling (change-driven refresh, caching item views per sync generation). Deferred by the user; see the [overview](query_model_plan_overview.md#3-scope-and-ordering). The sidebar keeps the fixed 3 s poll, now as one `GetFacets` call (§6.2).
- Import/export beyond what `config.json` already gives (it is the export).

### 2.1 Pin button

- Lucide `Pin` icon button inset inside the right side of the `QueryInput` frame (to the left of the `×` clear button); `data-testid="pin-search-button"`.
- Three visual states:
  1. **Active match** (`data-active="true"`, `aria-label="Edit pinned search <name>"`, filled blue `Pin`): when some sidebar row is **active** by the §7 rule and unmodified. Using the same rule as the row highlight means that opening an unscoped search on the Acked tab (text `triage:acked repo:k/k`) shows a filled pin for that row instead of inviting a second, scoped save. Saved searches whose text has parse issues never match.
  2. **Modified origin search** (`data-active="modified"`, `aria-label="Update pinned search <name>"`, blue outline `Pin`): when the user selected a pinned search and then modified the query or sort (and the new query does not match a different pinned search).
  3. **Default** (`data-active="false"`, `aria-label="Pin search"`, slate outline `Pin`): when no pinned search is active or modified.
- Disabled, with a tooltip, when the text is empty ("The Inbox is always in the sidebar") or the query has issues ("Fix the highlighted parts of the query first").
- Default click → modal in create mode. Active click → modal in edit mode for the matched search. Modified click → modal in modified mode for the origin search.

### 2.2 Pin / Edit modal (`SaveSearchModal`)

- Title "Pin search" (create) or "Edit pinned search" (edit / modified), with a `Pin` icon. Styling and focus handling follow [`KeyboardShortcutsModal.tsx`](../../frontend/src/components/KeyboardShortcutsModal.tsx) (focus trap including `textarea`, Escape closes when no suggestion popup or sort menu is open, backdrop click closes).
- **Name** input, autofocused and fully selected. Suggested name in create mode: the repo name if the query, **after removing tab clauses** (§7), is exactly one non-negated single-value `repo:` clause, otherwise the query text truncated to 40 characters with an ellipsis. In edit/modified mode, starts with the active/origin search's current name.
- Editable **Query** using the highlighted `QueryInput` component (tokenized chips and autocomplete, `textareaTestId="saved-search-query-input"`, no pin button).
- **Live preview & `SortMenu`** (`data-testid="saved-search-preview"`): bordered section at the bottom of the modal content showing the matching item count (`data-testid="saved-search-preview-count"`), `SortMenu` dropdown on the right, and a 1-line summary (`owner/repo#number` and title, `data-testid="saved-search-preview-item"`) for the top 3 matching items from a debounced `GetItems` query. Create mode defaults to the dashboard's current query and sort; edit mode defaults to the stored query and sort of the search being edited; modified mode defaults to the modified query (stripping tab clauses when updating an unscoped origin search) and current sort.
- Create mode buttons: Cancel, **Save** (Enter). Saves the name, query text, sort and order, and applies the saved search to the dashboard if the query or sort was changed in the modal.
- Edit / modified mode buttons: Delete (left, with inline confirm), Cancel, **Save as new** (`data-testid="save-as-new-button"`), and **Update** (`data-testid="update-saved-search-button"`, Enter). **Update** calls `UpdateSavedSearch` with `name` plus `query` and/or `sort` in the mask when changed (if only the name was changed, the mask contains only `name`). **Save as new** requires a distinct name (focusing and selecting the Name field with `"Give the new pinned search a different name"` if unchanged) and creates a new saved search via `CreateSavedSearch`.
- Errors inline under the name field (empty or too long name, name taken `AlreadyExists`, limit reached `ResourceExhausted`, or unchanged name on `Save as new`) and under the query field (`data-testid="saved-search-query-error"` or `QueryInput`'s `invalid-query` summary).

### 2.3 Sidebar

Order: Workflows (Inbox, New, Acked) → **Pinned** → Repositories.
- Header "Pinned" with a pencil button (`aria-label="Edit pinned searches"`) that toggles edit mode ("Done" while editing).
- Rows use `SidebarRow`: name, a badge styled by the saved query's triage scope (§6.3), and the active highlight.
- **Invalid text** (parse issues, e.g. after a hand edit of `config.json`, or a server `CountResult.error` from `GetFacets`): the row shows an error badge instead of a count: lucide `AlertTriangle` (12 px, `text-red-600`) with the first issue message as `title`, and the row gets `aria-description="Error: <message>"`. The row still opens the search on click, so the user sees the error chips in the input. It never throws or hides the row.
- Empty state: one muted line, "Pin a search with the pin button in the search box".
- The "Repositories" section lists every repo (there is no pinned subset any more), keeping the 30-day "More" split from `buildSidebar`.

Click behaviour: §7.

### 2.4 Edit mode

- Each row shows: a drag handle button (lucide `GripVertical`, `aria-label="Reorder <name>"`), the search name text, a muted one-line preview of the stored sort when it is not the default (e.g. "Last acked, newest first"), an edit button (lucide `Pencil`, `aria-label="Edit <name>"`, `data-testid="edit-saved-search-<name>"`), and a delete button (lucide `Trash2`).
- **Edit:** clicking the row's edit button opens `SaveSearchModal` in `edit` mode for that search, allowing the user to edit its name, query text, and sort order.
- **Reorder:** drag by the handle (native HTML5 DnD; the row is `draggable` only while the pointer is down on the handle); a drop indicator line shows the target slot. With the handle focused, ArrowUp/ArrowDown move the row by one. Each move is applied optimistically and persisted with `ReorderSavedSearches`; on failure the order is rolled back and an error toast shown. A live region announces "Moved <name> to position 2 of 5".
- **Delete:** the row turns into "Delete “name”? [Delete] [Cancel]"; Delete calls `DeleteSavedSearch`.
- Rows do not navigate while editing.

---

## 3. Storage: `config.json`, with the query text as the source of truth (U13)

Saved searches are a repeated field on the `Config` proto, persisted in `~/.octodeck/config.json` by the existing protojson marshalling in [`config.go`](../../backend/internal/config/config.go). Each entry stores the **query text exactly as the user typed it**; there is no stored `Expr` and no SQLite table. List order is display order.

Reasons (recorded for future readers):
- Every consumer of saved searches is in the browser (sidebar, badges, opening a search), and the browser already parses text locally with `parseQuery`.
- Text keeps exactly what the user typed, which option 1 chips need (they render raw clauses).
- It is human-readable and hand-editable, and backup/export come free with `config.json`.
- **The wire format does not change:** the frontend parses the stored text and sends the resulting structured `Expr` to `GetItems`/`GetFacets`, exactly as for typed queries (parent §3.2).
- Cost, accepted: the daemon cannot evaluate a saved search by itself (e.g. future per-search notifications or a CLI). Parent §3.3 already says to add a Go parser if a Go-side text consumer appears.

This supersedes the parent design's earlier statement (§3.3) that saved searches are stored as `Expr` and evaluated by Go without parsing.

Example `config.json` excerpt (protojson field names):

```json
"savedSearches": [
  { "id": "9f2c4e1a7b3d4c55a1e0f6b2d8c9e7a4", "name": "k8s bugs", "query": "repo:kubernetes/kubernetes label:kind/bug is:open" },
  { "id": "0b7d5a3e9c1f4e22b6a8d4c0e2f1a9b3", "name": "Acked PRs", "query": "triage:acked type:pr",
    "sort": { "key": "SORT_KEY_ACKED", "order": "SORT_ORDER_DESC" } }
]
```

Hand edits are read when the daemon loads the config (startup). As for every other config field today, a hand edit made while the daemon runs is lost: the saved-search RPCs operate on the in-memory copy, so the next write overwrites the file. The user guide says to stop the daemon before editing, and that the file must stay well-formed protojson (§5.4).

`SavedSearch` deliberately has no created/updated timestamps; the sidebar does not need them, so do not add them ad hoc. With no saved searches, `GetConfig` omits `savedSearches` from JSON and protobuf-es yields `[]`.

---

## 4. Proto changes

`api/octodeck/v1/service.proto` (next to `Config`; `Sort` and `Expr` come from the already-imported `query.proto`):

```proto
// A named dashboard query shown in the sidebar. Stored in config.json; list order is display order.
message SavedSearch {
  // Server-assigned, stable and opaque (16 random bytes, hex). Assigned on load if missing.
  string id = 1;
  // Display name: trimmed, 1-80 characters, no control characters, unique (case-insensitive).
  string name = 2;
  // The query exactly as the user wrote it, in the dashboard's text syntax: non-empty after
  // trimming, at most 1000 characters, no line breaks. The daemon stores it and never parses it.
  string query = 3;
  // Sort applied when the search is opened. Unset means the default sort.
  Sort sort = 4;
}

message Config {
  // ... existing fields 1-14 ...
  // Legacy: converted into saved_searches when the config is loaded or updated, and always empty
  // afterwards. Kept so old config files can still be read.
  repeated string pinned_repos = 2;
  // Saved searches, in display order. Changed only through the saved search RPCs; UpdateConfig
  // rejects masks that include this field and preserves it on a full update.
  repeated SavedSearch saved_searches = 15;
}
```

Do **not** add `[deprecated = true]` to `pinned_repos` or start its comment with "Deprecated:": both make the generated Go getter deprecated, and `golangci-lint` (staticcheck SA1019) then fails on the migration code that reads it.

RPCs (`OctoDeckService`). Saved searches are **read** through `GetConfig` (`config.saved_searches`); every mutation returns the full updated list:

```proto
  // Saved searches. Each call is a read-modify-write of the stored list under the config lock.
  rpc CreateSavedSearch(CreateSavedSearchRequest) returns (CreateSavedSearchResponse);
  rpc UpdateSavedSearch(UpdateSavedSearchRequest) returns (UpdateSavedSearchResponse);
  rpc DeleteSavedSearch(DeleteSavedSearchRequest) returns (DeleteSavedSearchResponse);
  rpc ReorderSavedSearches(ReorderSavedSearchesRequest) returns (ReorderSavedSearchesResponse);

// Appended at the end of the list. id is ignored.
message CreateSavedSearchRequest { SavedSearch saved_search = 1; }
message CreateSavedSearchResponse {
  SavedSearch saved_search = 1;            // as stored, with its id
  repeated SavedSearch saved_searches = 2; // the full list after the change (includes saved_search)
}

message UpdateSavedSearchRequest {
  // id selects the entry; other fields per update_mask.
  SavedSearch saved_search = 1;
  // Paths: "name", "query", "sort" (sort carries both key and order). Empty means all three. A path
  // in the mask whose field is unset in saved_search clears it (an unset sort resets to the default),
  // mirroring applyFieldMask. "id" and unknown paths are InvalidArgument.
  google.protobuf.FieldMask update_mask = 2;
}
message UpdateSavedSearchResponse { repeated SavedSearch saved_searches = 1; }

message DeleteSavedSearchRequest { string id = 1; }
message DeleteSavedSearchResponse { repeated SavedSearch saved_searches = 1; }

message ReorderSavedSearchesRequest {
  // Every saved search id, exactly once, in the new order.
  repeated string ids = 1;
}
message ReorderSavedSearchesResponse { repeated SavedSearch saved_searches = 1; }
```

There is **no separate count RPC**. Saved-search badge counts are an extension of `GetFacets` (P13), so every sidebar number comes from one call (§6). `GetFacetsRequest`/`GetFacetsResponse` in `service.proto` gain:

```proto
message GetFacetsRequest {
  Expr query = 1;                 // unchanged
  repeated Field fields = 2;      // unchanged; may be empty when only queries are wanted
  // Additional independent queries to count (saved-search badges), each validated and scoped
  // exactly like GetItemsRequest.query (an unset entry is the empty query: an inbox count).
  // At most 100. Not affected by `query`.
  repeated Expr queries = 3;
}

message GetFacetsResponse {
  repeated Facet facets = 1;      // unchanged
  // One result per entry of GetFacetsRequest.queries, in request order.
  repeated CountResult counts = 2;
}
```

`api/octodeck/v1/query.proto`. Facet values and query results carry the same three numbers under the same field names (P24). `FacetValue` keeps `count = 2` (existing clients rely on it), so a shared sub-message would be a breaking rename; identical field names plus one shared Go struct (`query.Counts`, §6) give the same uniformity without breaking anything:

```proto
message FacetValue {
  string value = 1;                                  // unchanged
  // Number of matching items with this value. May be 0. (Unchanged meaning.)
  int32 count = 2;
  string color = 3;                                  // unchanged
  google.protobuf.Timestamp latest_activity_at = 4;  // unchanged
  // Of those, items matching new:any (always inbox items: acked items have no flags). Computed
  // from each item's activity flags, independent of any new: predicate in the request.
  int32 new_count = 5;
  // Of those, items in the inbox (computed status is not ACKED).
  int32 inbox_count = 6;
}

// Counts for one GetFacetsRequest.queries entry. Same numbers as FacetValue.
message CountResult {
  // Items matching the query (with the implicit triage scope, exactly as GetItems).
  int32 count = 1;
  // Of those, items matching new:any.
  int32 new_count = 2;
  // Of those, items in the inbox.
  int32 inbox_count = 3;
  // Set when the query is invalid; the counts are then 0. error.path is relative to the
  // queries[i] Expr (not prefixed with "queries[i].").
  ExprError error = 4;
}
```

Compatibility facts (so they need not be re-derived): every new field number is free (`Config` uses 1–14, `FacetValue` 1–4, `GetFacetsRequest` 1–2, `GetFacetsResponse` 1); `api/verify.sh` runs `buf lint` only (no `buf breaking`), and all changes are additive anyway. connect-es ignores unknown JSON fields, so an old frontend or extension tolerates the new fields; an old daemon omits them and protobuf-es reads 0 / `[]`. Edition 2023 uses explicit presence, so build `new_count`/`inbox_count` with pointers in Go (as `Count: &fv.count` is today) so 0 is emitted consistently.

The handler (`octoDeckHandler` in [`handler.go`](../../backend/internal/server/handler.go)) does not embed the generated `Unimplemented…Handler`, so the proto commit adds stub methods returning `connect.CodeUnimplemented` for the four saved-search RPCs. Until `queries` is implemented, `GetFacets` returns `Unimplemented` when `queries` is non-empty (an empty list behaves as today).

---

## 5. Server: config storage, RPCs and concurrency

### 5.1 Why dedicated RPCs with server-side read-modify-write (P22)

Two writers can touch the config concurrently: the Settings modal (which holds a possibly stale copy of the whole config) and the sidebar edit mode (possibly in several tabs).
- The Settings modal already sends `UpdateConfig` with an explicit update mask of the fields it edits (`DASHBOARD_CONFIG_FIELDS` in [`Settings.tsx`](../../frontend/src/Settings.tsx)), so it never writes `saved_searches`. The server enforces this: `UpdateConfig` returns `InvalidArgument` if any mask path is `saved_searches` **or** `savedSearches` (`applyFieldMask` resolves JSON names first and the extension already sends camelCase paths such as `knownBots`). On a full (unmasked) update, which today replaces the whole config (`proto.Clone(newCfg)`), `UpdateProto` captures `prev := current.GetSavedSearches()` before building the target and restores a deep copy of it on the target **before** `MigratePinnedRepos` runs, so a legacy `pinned_repos` in the request appends to the preserved list rather than to an empty one.
- `UpdateConfig` therefore never writes `saved_searches` **from the request**; the only way it can change the list is the `pinned_repos` conversion (§8), which appends.
- Replacing the whole list through `UpdateConfig` from the sidebar would lose concurrent edits from another tab unless an etag were added. Instead, each saved-search RPC changes one entry **by id** inside a read-modify-write under `Config.mu`, so concurrent creates/renames/deletes all survive without a version check. The only order-sensitive operation, reorder, must name exactly the current set of ids, otherwise it fails with `FailedPrecondition` and the client refetches.

### 5.2 Config API ([`config.go`](../../backend/internal/config/config.go), new `saved_searches.go` in the same package)

Recommended internal Go API (exact helper/sentinel names are up to the implementer, provided `errname` lint rules and the §5.3 Connect error codes are respected):

```go
// GetSavedSearches returns a deep copy (proto.Clone of each entry) of the saved searches, in display
// order. Readers are lock-free (atomic.Pointer), so returning shared messages would race.
func (c *Config) GetSavedSearches() []*octodeckv1.SavedSearch

// UpdateSavedSearches runs fn on a deep copy of the list under c.mu, stores the result and writes it
// to disk. fn performs the per-operation validation (§5.3); there is no whole-list validation. If
// the write fails, the previous config pointer is restored and the error returned (unlike
// AddKnownBots, which does not roll back; this difference is deliberate).
func (c *Config) UpdateSavedSearches(
    fn func([]*octodeckv1.SavedSearch) ([]*octodeckv1.SavedSearch, error),
) ([]*octodeckv1.SavedSearch, error)

// Sentinel errors (the errname linter requires the Err prefix), returned wrapped by the per-operation
// helpers used inside fn. The handler maps them with errors.Is; anything else (e.g. the disk write)
// is Internal.
var (
    ErrSavedSearchNotFound   = errors.New("saved search not found")          // NotFound
    ErrSavedSearchNameTaken  = errors.New("saved search name already used")  // AlreadyExists
    ErrSavedSearchLimit      = errors.New("too many saved searches")         // ResourceExhausted
    ErrSavedSearchInvalid    = errors.New("invalid saved search")            // InvalidArgument
    ErrSavedSearchStaleOrder = errors.New("saved search ids changed")        // FailedPrecondition
)

// ValidateSavedSearchName / ValidateSavedSearchQuery enforce the field limits below.
// NormalizeSavedSearches repairs a loaded list (ids, empty queries, names); see §5.4.
// MigratePinnedRepos converts pinned_repos into saved searches; see §8.
```

Also in this phase, make `saveLocked` write atomically: create a temp file **in the same directory** as the config, write, `fsync`, close, then `os.Rename` over the config; remove the temp file on any failure. The file now holds user data that is not recoverable from GitHub.

**Test harness (blocker otherwise):** `config.NewForTest` uses the path `/dev/null`, which `os.WriteFile` tolerates but a same-directory temp file plus rename does not (every server test harness uses `NewForTest`, and several call `UpdateConfig`). In the same commit, change `NewForTest` so it does not persist: an empty path (or an explicit no-persist flag) makes `saveLocked` a no-op, and tests that need a real file pass a `t.TempDir()` path.

### 5.3 Validation and errors

Field limits: names trimmed, **1–80 characters**, no control characters, unique under `strings.EqualFold`; query non-empty after trimming, at most 1000 characters, no `\r` or `\n`. The query is stored exactly as sent (not trimmed or normalised) and never parsed.

Validation is **per operation**, never over the whole list, so a hand-edited file with duplicate names or more than 50 entries (kept on load, §5.4) never locks the user out of fixing it:
- **Create:** field limits; the current list has fewer than **50** entries; the name is not used by any entry.
- **Update:** the id exists; for `name`, field limits and uniqueness excluding the entry's own id.
- **Delete:** the id exists. Nothing else.
- **Reorder:** `len(ids) == len(current)` and the id sets are equal (so duplicates are rejected). Nothing about names or the limit. Two tabs reordering concurrently both succeed; last writer wins.

| Condition | Code |
|---|---|
| Name empty, too long, or with control characters | `InvalidArgument` |
| Query empty, too long, or containing a line break | `InvalidArgument` |
| Name already used (case-insensitive) | `AlreadyExists` |
| Creating the 51st search | `ResourceExhausted` |
| Unknown id (update, delete) | `NotFound` |
| Unknown update-mask path (including `id`) | `InvalidArgument` |
| Reorder ids not a permutation of the current ids | `FailedPrecondition` |
| `UpdateConfig` mask containing `saved_searches` or `savedSearches` | `InvalidArgument` |
| Writing `config.json` fails | `Internal` (in-memory list unchanged) |

IDs: `crypto/rand`, 16 bytes, hex-encoded. No new dependency.

### 5.4 Loading hand-edited files

For **well-formed protojson**, `config.Load` must never fail because of saved-search *values*. Normalisation repairs values, not JSON shape: protojson `Unmarshal` runs first, so a wrong type (`"query": 5`), an unknown enum string (`"key": "SORT_KEY_LATEST"`) or invalid UTF-8 still fails `Load`, as for any other config field. The user guide's hand-editing note says so. `NormalizeSavedSearches` runs on load and on `UpdateProto`:
- missing ids → new ids; duplicate ids → the **first** occurrence keeps its id (a browser may hold it), later ones get new ids;
- entries whose query is empty after trimming → dropped (logged with `slog.Warn`);
- control characters in names are replaced by spaces, then names are trimmed; names that are then empty → the query truncated to 80 characters; names longer than 80 → truncated. Truncation is rune-safe (`utf8`), never splitting a character. A derived name may collide with another; that is kept, like any duplicate;
- duplicate names and more than 50 entries are **kept** (logged); the RPCs only prevent creating new violations (§5.3);
- query text is not checked for syntax (the browser does that and shows an error row, §2.3).

If normalisation or the `pinned_repos` conversion changed anything during `Load`, the config is written back once (§8).

---

## 6. Sidebar counts: one `GetFacets` call (P13, P24)

### 6.1 Server

`GetFacets` ([`items.go`](../../backend/internal/server/items.go), [`facets.go`](../../backend/internal/query/facets.go)) gains two things, all computed over the **one** item load (`h.db.GetItems(ctx, nil)`) and **one** view build (`h.queryViews`) it already does:
- **Per facet value**, besides `count`: `new_count` (matching items with `new:any`) and `inbox_count` (matching items whose computed status is not ACKED). The accumulation loop in `query.Facets` increments all three per matched view (`matchNew(valueAny, v)`, `matchTriage(valueInbox, v)` from [`eval.go`](../../backend/internal/query/eval.go)). The flags are computed once per view, so the extra cost is two boolean checks per (view, value).
- **`queries`**: check the 100-query limit **before** `h.db.GetItems`, so an oversized request never loads items. Then for each entry (an unset entry is the empty query, i.e. an inbox count), compile with the same `query.Options{CurrentUser}` as `compileQuery`, but with **per-query errors** (put `ValidationError.Proto()` in `CountResult.error` rather than failing the request), so one stale saved search cannot blank every badge; then `query.Count(q, views) Counts`. More than 100 queries → `InvalidArgument`. Errors in the main `query` or `fields` still fail the whole request, as today.
- Recommended shared Go type (e.g. in `backend/internal/query/count.go`): `type Counts struct{ Count, NewCount, InboxCount int32 }` with `func (c *Counts) add(v *View)` (`c.Count++`; `NewCount++` if `v.Activity.Any()`; `InboxCount++` unless the item is acked: exactly what `matchNew(valueAny)` / `matchTriage(valueInbox)` reduce to), used by both the facet accumulation (an embedded `Counts` replaces `facetValue.count`; the `baseMatched` caching is unaffected) and `Count` (`for v := range views { if q.Match(v) { c.add(v) } }`; `Match` applies the implicit inbox, so an unscoped saved search has `inbox_count == count`), so the three numbers have one definition.
- For the sidebar request (`{}`, `[REPO, TRIAGE]`): REPO uses the implicit-inbox base, so `inbox_count == count`; TRIAGE strips the implicit scope, so value `inbox` has `new_count` = the old `GetFacets(new:any, [triage])` inbox count and value `acked` has `new_count == inbox_count == 0`. For the NEW facet with a `new:` predicate in the main query, own-field exclusion removes that predicate, so value `noise`'s `new_count` counts noise items that also have other new activity; this matches the definition above.

### 6.2 Client: one sidebar call per poll

The sidebar makes **one** `GetFacets` call per poll (in `useDashboardData`, replacing `SIDEBAR_REQUEST` and `UNREAD_REQUEST` in [`useDashboardData.ts`](../../frontend/src/hooks/useDashboardData.ts)):

```ts
{ query: {} /* implicit inbox */, fields: [Field.REPO, Field.TRIAGE], queries: savedSearchExprs }
```

| Sidebar number | Source |
|---|---|
| Per-repo inbox count | repo facet value `count` |
| Per-repo orange dot | repo facet value `new_count > 0` |
| Inbox / Acked totals | triage facet values `inbox` / `acked` `count` (own-field exclusion turns the implicit scope into `triage:all`) |
| New total | triage facet value `inbox` → `new_count` (acked items have no `new:` flags) |
| Saved-search badges | `counts[i]` (§6.3) |

`savedSearchExprs` comes from `useSavedSearches` (§9.1): each saved search's text is parsed with `parseQuery`; searches with issues are **left out** and shown in the error state (§2.3); the rest are sent as `toExpr(parsed)` in list order, with an index map back to the rows. No derived queries are sent: `count`, `new_count` and `inbox_count` cover every badge (P24). The call uses the existing `POLL` (3 s, `staleTime` 1 s) and `placeholderData: keepPreviousData` (so editing saved searches, which changes the request, does not flash the numbers), and it stays in `refreshAll`.

The **selector** `GetFacets` (dropdown options for the current query, `SELECTOR_FIELDS`) stays a separate call: it is keyed on the current filter and refetches on every filter change; merging it would refetch the sidebar numbers too.

Cost per poll after Phase 3: `GetItems` + selector `GetFacets` + sidebar `GetFacets` (+ the `GetItem` fallback when the selected item is outside the result). Before this change it would have been `GetItems` + three `GetFacets` (selector, sidebar, unread) + `CountItems`: two fewer full item loads and view builds per poll. Saved-search evaluation adds `O(queries × items)` in-memory predicate checks (a few milliseconds with the 50-search cap and a few thousand items). Further reductions (change-driven refresh instead of fixed polling, caching views per sync generation) are a deferred enhancement ([overview §3](query_model_plan_overview.md#3-scope-and-ordering)).

The `GetFacets` change for facet-value counts and the single sidebar call are useful without saved searches, so they land first, as a prep commit (§11, commit 3.1).

### 6.3 Badge semantics by triage scope (U12, U14, P21)

The badge depends on the saved query's **triage scope**, classified client-side by a pure function in `frontend/src/logic/savedSearches.ts`:

```ts
export type BadgeScope = 'inbox' | 'new' | 'acked' | 'all';
/** Classifies a parsed saved query from its top-level predicates (rules below). */
export function badgeScope(parsed: ParsedQuery): BadgeScope;
```

Classification uses **top-level predicates only**, i.e. `parsed.predicates` (the Phase 2 grammar has no grouping, so every predicate is top-level today; if grouping is added later, a `triage` predicate below the top level makes the scope ambiguous → `'inbox'`).

1. Start with `allowed = {inbox, acked}`. For each `triage` predicate (with `all` expanded to `inbox, acked`): a positive predicate intersects `allowed` with its values; a negated one removes its values. If there is no `triage` predicate, `allowed = {inbox}` (the implicit scope).
2. `allowed = {inbox}`: `'new'` if there is a non-negated `new:` predicate with at least one value other than `noise`; otherwise `'inbox'`. (`new:noise` alone is not "new activity", parent §4.4.)
3. `allowed = {acked}` → `'acked'` (any `new:` predicate is irrelevant: acked items have no flags).
4. `allowed = {inbox, acked}` → `'all'`.
5. `allowed` empty (e.g. `triage:inbox triage:acked`) → `'inbox'` (the count is 0 and hidden anyway).

Examples: `repo:k/k` → inbox; `triage:inbox label:bug` → inbox; `new:mention repo:k/k` → new; `is:new` → new; `-triage:inbox` → acked; `triage:acked new:any` → acked; `triage:all` → all; `is:inbox,acked` → all; `-new:noise` → inbox; `new:noise` → inbox.

Rendering (in `SidebarRow`):

| Scope | Badge | Hidden when | Classes |
|---|---|---|---|
| inbox | `count` in a bubble; **orange** when `new_count > 0`, slate otherwise (today's repo-row badge) | `count = 0` | orange: `bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300`; slate: `bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300`; both `text-[10px] px-1.5 rounded-full font-mono` |
| new | `count` in an **always orange** bubble | `count = 0` | orange classes above |
| acked | `count` as **faded text, no bubble** | `count = 0` | `text-[10px] font-mono text-slate-400 dark:text-slate-500` |
| all (U14) | if `inbox_count > 0`: exactly the inbox badge, using `inbox_count` (orange when `new_count > 0`, slate otherwise). If `inbox_count = 0`: the acked style showing `count` (all matching items, which are then all acked) | `count = 0` | as inbox / acked above |
| error | `AlertTriangle` icon instead of a count (§2.3) | never | `text-red-600` |

Each badge has an `aria-label`: "N items" (with ", some with new activity" for an orange bubble) or "N items with new activity" for new searches, and "N acked items" for the faded style. `data-scope` on the row carries the scope for tests.

---

## 7. Opening a saved search and the triage tabs (P16)

Parent §4.6: "A saved search that omits `triage:` runs within whichever triage tab is active."

**Tab clauses** of a text are every `triage` clause, plus the first `new:any` clause when there is no `triage` clause (the New-tab derivation, [Phase 1 §3.4](query_model_phase1_multiselect.md#34-activity-menu-and-the-new-tab-p4)). A saved search is **scoped** (`SavedSearchView.hasScope`) when its own text has any tab clause.

Opening first parses the saved text. Text with issues is still opened (the input shows the error chips, [Phase 2 §7](query_model_phase2_query_input.md#7-error-reporting)). Opening is an `edit` (`pushState`) and computes from the latest state inside the updater ([Phase 2 §4.1](query_model_phase2_query_input.md#41-usedashboardfilters-api-rewritten)).

- **Scoped search:** opening replaces the whole text with the saved text.
- **Unscoped search:** opening keeps the active tab's clauses and replaces everything else with the saved text: `insertClause` the current text's tab clauses at rank 0 into the saved text.
- **Sort:** opening applies the saved sort/order in **both** cases.

Examples (current text → after opening):

| Saved text | On Inbox (`''`) | On New (`new:any`) | On Acked (`triage:acked`) |
|---|---|---|---|
| `repo:k/k` (unscoped) | `repo:k/k` | `new:any repo:k/k` | `triage:acked repo:k/k` |
| `new:any repo:k/k` (scoped, pinned on New) | `new:any repo:k/k` | `new:any repo:k/k` | `new:any repo:k/k` |
| `triage:acked type:pr` (scoped) | `triage:acked type:pr` | `triage:acked type:pr` | `triage:acked type:pr` |

This preserves the current pinned-repo behaviour for unscoped searches (clicking a pinned repo keeps the tab, because `toggleRepo` only changes repo/org) without duplicating `new:any` or producing an always-empty `triage:acked new:any`.

- **Active highlight:** requires **both** the current query and the saved search to have no parse issues (`currentParsed.issues.length === 0 && view.parsed.issues.length === 0`, since `canonicalQuery` strips error clauses). Then an unscoped row is active when `canonicalQuery(current text minus its tab clauses) === canonicalQuery(saved text)`; a scoped row when `canonicalQuery(current) === canonicalQuery(saved)`. Sort is ignored. The pin button uses the same rule (§2.1).
- **Clicking the active row** resets the text to the current tab clauses only and sort/order to the defaults (the same reset as a sidebar Workflow row, [Phase 1 §3.4](query_model_phase1_multiselect.md#34-activity-menu-and-the-new-tab-p4)), mirroring how clicking the selected pinned repo cleared it.
- **Badges** count the saved query with its own meaning, independent of the active tab, and are styled by its own triage scope (§6.3). Opening a search on another tab does not change its badge.
- **Saving** stores the full current text, tab clauses included, so pinning on the Acked tab while no row is active saves `triage:acked …` as a scoped search.

---

## 8. Converting `pinned_repos` (P23)

Server-side, in the config package, on **load and update** (the same normalisation step as `SanitizeTrackedQueries` today):

`MigratePinnedRepos(cfg *octodeckv1.Config) (changed bool)`:
1. For each `pinned_repos` entry, trimmed, de-duplicated case-insensitively, in order: if it matches `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`, append `{id: new, name: repo, query: "repo:" + repo}` unless a saved search already has that name **or** that query text (both compared with `strings.EqualFold`; the query check stops a stale old tab that resends `pinned_repos` after the user renamed the converted search from recreating it). Otherwise drop it with a `slog.Warn`. `repo:owner/name` is the only query text Go ever writes; GitHub repo names cannot contain spaces, quotes or commas, so no quoting is needed.
2. Clear `pinned_repos`.
3. The 50-entry limit is not applied here (existing pins are never lost); creating new searches is blocked until the user is under the limit.

In `config.Load` (which never writes today):
- If `pinned_repos` was **non-empty** before conversion, first copy the original file to `config.json.bak-pinned-repos` (only if that backup does not exist yet). Normalisation-only changes write back without a backup.
- If the conversion or normalisation changed anything, write the converted config with the atomic `saveLocked`. If the backup or the write fails, log with `slog.Warn` and continue: `Load` returns the converted in-memory config and the daemon starts.
- **Debug commands (accepted, temporary version skew):** `backend/cmd/debug.go` calls `config.Load` in several places, so the first `octodeck debug …` run after an upgrade also performs the conversion and writes `config.json` (and the backup). This is accepted as temporary upgrade behaviour; there is no read-only `Load` option.

Properties:
- **Idempotent without a marker:** the conversion is a function of the file content and runs in a single file write. After a successful write `pinned_repos` is empty, so it never runs again; if the write fails, the file still has `pinned_repos` and no new saved searches, so the next load redoes exactly the same conversion. A user who deletes a converted search does not get it back.
- **Old clients:** if an older frontend sends `pinned_repos` through `UpdateConfig`, `UpdateProto` converts it again (appending only entries whose name and query are not already present). Because `GetConfig` returns `pinned_repos` empty after conversion, an old tab's Pinned repositories textarea empties on reload; the release notes mention it.
- **Downgrade:** an older daemon finds `pinned_repos` empty (no pins shown) and discards `savedSearches` as an unknown field (`DiscardUnknown: true`), dropping it from the file on its next config write. Downgrades are not supported in general; the one-time backup file preserves the original pins, and the release notes say so.
- **Afterwards:** `pinned_repos` stays in the proto only so old files can be read (§4); it is always empty in memory and on disk. `Config.GetPinnedRepos` (the hand-written getter in `config.go`) is removed. The Settings modal stops showing and saving "Pinned repositories" (remove `pinnedRepos` from `DASHBOARD_CONFIG_FIELDS`, the textarea and its dirty-checking), and the dashboard stops reading `config.pinnedRepos`.

Alternative rejected: converting in the frontend on first load. It needs the dashboard to be opened, races between tabs, splits the migration across two components and leaves `pinned_repos` writable from the browser; the server conversion is atomic in one file write and follows the existing load-normalisation pattern.

---

## 9. Frontend architecture

### 9.1 `hooks/useSavedSearches.ts`

```ts
export interface SavedSearchView {
  id: string;
  name: string;
  text: string;          // the stored query, exactly as saved
  parsed: ParsedQuery;   // parseQuery(text)
  canonical: string;     // canonicalQuery(text); '' when the text has issues
  hasScope: boolean;     // the text has a tab clause (§7)
  scope: BadgeScope;     // badgeScope(parsed), §6.3
  sort: SortOption;
  order: SortOrder;
  count: number | null;  // null until counts arrive (or when invalid)
  newCount: number;
  inboxCount: number;
  error: string | null;  // first parse issue, or the server CountResult.error message
}

export function useSavedSearches(): {
  searches: SavedSearchView[];   // counts not yet attached (count: null)
  countRequest: { queries: ExprInit[]; rowIndex: number[] }; // buildCountRequest(searches)
  isLoading: boolean;
  create(input: { name: string; text: string; sort: SortOption; order: SortOrder }): Promise<SavedSearchView>;
  update(id: string, patch: { name?: string; text?: string; sort?: SortOption; order?: SortOrder }): Promise<void>; // sort and order both go under mask path "sort"; text goes under "query"
  remove(id: string): Promise<void>;
  reorder(ids: string[]): Promise<void>; // optimistic, rolls back on error
};
```
- The list comes from the existing `GetConfig` query (`config.savedSearches`); mutations write the returned list into that query's cache and invalidate it. The hook makes **no count call of its own**.
- `Dashboard` passes `countRequest.queries` to `useDashboardData({ ..., savedSearchQueries })`, which puts them in the single sidebar `GetFacets` request (§6.2) and returns `savedSearchCounts` (the response's `counts`). `attachCounts(searches, countRequest.rowIndex, savedSearchCounts)` (pure) produces the views the sidebar renders.
- `create` refuses (throws) if `parseQuery(text)` has issues (the pin button is disabled in that case anyway).
- Pure helpers in `frontend/src/logic/savedSearches.ts` (unit-tested): `toView`, `tabClauses(parsed)`, `badgeScope`, `buildCountRequest(views)` (the Exprs of valid searches plus the index map), `attachCounts`, `isActive(parsed, view)` (used by both the row highlight and the pin button), `openSavedSearchText(currentParsed, view)`, `suggestName(parsed)`, `moveItem(ids, from, to)`.
- This phase adds `openSavedSearch(view)` to `useDashboardFilters` (commit 3.9): an `edit` that sets text via `openSavedSearchText(parseQuery(prev.text), view)` inside the state updater and applies the saved sort/order (§7).

### 9.2 Components (`frontend/src/components/savedSearches/`)

- `PinButton.tsx`, `SaveSearchModal.tsx`, `SavedSearchList.tsx` (normal and edit mode), `SavedSearchEditRow.tsx`.
- `DashboardSidebar` renders `SavedSearchList` in place of the pinned section; `SidebarRow` gains the badge variants of §6.3.

### 9.3 Removals

- `pinnedRepos` from `useDashboardData` options, `buildSidebar(repoValues, nowMs)` (no pinned list; returns `repoList`, `activeList`, `hiddenList`), and `buildRepoDropdown` (no pinned parameter; "Show all" adds only zero-count values) in [`facets.ts`](../../frontend/src/logic/query/facets.ts).
- The "Pinned repositories" setting (§8).

### 9.4 Reorder implementation notes (P18)

- `draggable` is set on the row only between `pointerdown` on the handle and `dragend`, so text selection in the name input still works.
- `dragover` computes the target slot from the pointer's vertical position relative to row midpoints; render a 2 px drop line.
- Keep the reorder as the pure `moveItem(ids, from, to)`.
- jsdom tests drive it with `fireEvent.dragStart/dragOver/drop` and a stub `dataTransfer`, and the keyboard path with ArrowUp/ArrowDown on the handle.

---

## 10. Decisions made for this phase (reviewable)

User decisions (U*) are listed in the [overview](query_model_plan_overview.md#21-decided-by-the-user). Phase 3 owns these plan decisions:

| # | Decision | Short reason | Where |
|---|---|---|---|
| P13 | There is no separate count RPC: `GetFacets` gains `queries` (saved searches, per-query errors) and per-value `new_count`/`inbox_count`, and the sidebar makes **one** `GetFacets` call per poll for every number it shows. The selector `GetFacets` stays separate. The client builds the Exprs from the stored text. | One item load and view build for all sidebar numbers; replaces two sidebar calls plus a would-be count RPC; the selector call changes with the filter and must not drag the sidebar along. | §6 |
| P16 | Opening an **unscoped** saved search (no tab clause: no `triage` clause and no `new:any` standing in for the New tab) keeps the active tab's clauses (parent §4.6); a scoped one opens wholesale. The saved sort is always applied. | Preserves today's pinned-repo behaviour without duplicating `new:any` or producing an always-empty `triage:acked new:any`. | §7 |
| P17 | At most 50 saved searches (at most 100 `queries` per `GetFacets`); names 1–80 characters, unique case-insensitively; queries up to 1000 characters on one line. All validated server-side. | Bounds the sidebar call's cost and keeps the sidebar unambiguous. | §5.3 |
| P18 | Reorder uses native HTML5 drag and drop on a handle plus ArrowUp/ArrowDown on the focused handle. | No new dependency; accessible. | §9.4 |
| P21 | Badge scope is classified from top-level predicates only; anything ambiguous uses inbox behaviour; `new:noise` alone is not new activity. | Deterministic and cheap; noise is never "worth looking at" (parent §4.4). | §6.3 |
| P22 | Dedicated saved-search RPCs doing a by-id read-modify-write under the config lock, with per-operation validation; reads go through `GetConfig`; `UpdateConfig` never writes `saved_searches` from the request (both mask spellings rejected; preserved on unmasked updates); the only way it can change the list is the `pinned_repos` conversion (§8), which appends. | No lost updates between tabs or with the Settings modal, without an etag. | §5.1 |
| P23 | `pinned_repos` is converted server-side on config load/update, then cleared; a one-time backup of the original file is written when it had pins; a failed load-time write is logged and ignored; debug commands also convert (accepted). | Atomic and idempotent in one file write, no marker; follows the existing load-normalisation pattern. | §8 |
| P24 | `FacetValue` and `CountResult` both carry `count`, `new_count` and `inbox_count` (same names; one Go `query.Counts` type), instead of the client sending derived inbox- or new-scoped queries. `FacetValue.count` keeps its field number and meaning. | All-items badges (U14), the New total and the repo dots need them; computing them in the same pass is cheaper and keeps the client from rewriting Exprs; a shared proto sub-message would break `FacetValue.count`. | §4, §6.1 |

---

## 11. Commit plan

Each commit must leave `./verify.sh` green (never `--force`). Commit subjects follow Conventional Commits with no backticks. Generated code is regenerated by the existing tooling when a proto changes.

**3.1 `perf(dashboard): get every sidebar count from one GetFacets call`** (prep commit; useful without saved searches)
- Files: `api/octodeck/v1/query.proto` (`FacetValue.new_count`, `FacetValue.inbox_count`), regenerated Go/TS, `backend/internal/query/count.go` (`Counts` type and `add`), `backend/internal/query/facets.go` (accumulate all three per value), `frontend/src/hooks/useDashboardData.ts` (one `SIDEBAR_REQUEST` with `fields: [REPO, TRIAGE]`; `repoHasUnread` from repo `new_count > 0`; `totals.new` from the triage `inbox` value's `new_count`; remove `UNREAD_REQUEST` and the unread query from `refreshAll`), `frontend/src/logic/query/expr.ts` (drop `NEW_ANY_EXPR` if unused) and `frontend/src/logic/query/__tests__/expr.test.ts` (its `NEW_ANY_EXPR` cases), `frontend/src/logic/query/facets.ts` (helpers reading `newCount`).
- Tests: Go `facets_test.go`: for every conformance vector in `fixtures_test.go` and every facetable field, each value's `new_count` equals the count of its matches that match `new:any`, and `inbox_count` the count that match `triage:inbox`; the triage facet's `inbox` value `new_count` equals the old `GetFacets(new:any, [triage])` inbox count. Frontend `Dashboard.rpc.test.tsx`: the sidebar issues exactly **one** `GetFacets` per poll without a `query` (plus the selector call), and no `new:any` request; Inbox/New/Acked totals, repo counts and orange dots are unchanged for the existing fixtures (update the "sidebar counts come from GetFacets" tests, which currently stub two calls).
- AC: identical sidebar rendering with one fewer RPC per poll.

**3.2 `feat(api): add saved searches to the config and saved-search counts to GetFacets`**
- Files: `api/octodeck/v1/service.proto` (`SavedSearch`, `Config.saved_searches`, `pinned_repos` comment, the four saved-search RPCs, `GetFacetsRequest.queries`, `GetFacetsResponse.counts`), `api/octodeck/v1/query.proto` (`CountResult`), regenerated Go/TS, `backend/internal/server/saved_searches.go` with `CodeUnimplemented` stubs, `items.go` (`GetFacets` returns `Unimplemented` for non-empty `queries`).
- Tests: a server test that non-empty `queries` returns `Unimplemented` and empty `queries` behaves as before (the `Unimplemented` case is replaced in 3.5).
- AC: `./verify.sh` green; no behaviour change.

**3.3 `feat(backend): store saved searches in the config file`**
- Files: `backend/internal/config/saved_searches.go` (`GetSavedSearches`, `UpdateSavedSearches`, the sentinel errors, per-operation helpers, `ValidateSavedSearchName`, `ValidateSavedSearchQuery`, `NormalizeSavedSearches`), `backend/internal/config/config.go` (normalise on `Load`/`UpdateProto`; `UpdateProto` captures and restores `saved_searches` on unmasked updates; atomic `saveLocked`; **`NewForTest` no longer persists**, §5.2), `backend/internal/server/handler.go` (`UpdateConfig` rejects masks with `saved_searches` or `savedSearches`), and any test that relied on `NewForTest`'s `/dev/null` path.
- Tests (`config_test.go`, `saved_searches_test.go`, `handler_test.go`): protojson round trip of `savedSearches`; normalisation table (missing ids; duplicate ids where the first keeps its id; empty query dropped; control characters in names; empty/long names with rune-safe truncation of non-ASCII; duplicates and >50 kept); `Load` of a hand-edited well-formed file never fails, while malformed protojson still fails as for any field; a full (unmasked) `UpdateProto` whose request lacks `saved_searches` keeps them (update `TestConfig_RepeatedFieldsFullUpdateClearing`, which codifies "full update clears every list"); `UpdateConfig` with `saved_searches` and with `savedSearches` in the mask → `InvalidArgument`; `UpdateSavedSearches` restores the previous list when the write fails; atomic write leaves no partial or temp file; `GetSavedSearches` returns copies (mutating them does not affect the config); the existing server tests using `NewForTest` still pass.
- AC: saved searches persist across daemon restarts.

**3.4 `feat(backend): serve the saved search RPCs`**
- Files: `backend/internal/server/saved_searches.go`.
- Tests (`server/saved_searches_test.go`, through the real Connect client as in `items_test.go`): every row of the §5.3 table, with each sentinel error mapped to its code via `errors.Is`; per-operation validation (starting from a config with 51 entries and two entries named "k8s": delete, reorder and renaming one "k8s" to a free name all succeed, while create fails with `ResourceExhausted`); `UpdateSavedSearch` with `sort` in the mask but unset resets it to the default, and `id`/`query` paths are `InvalidArgument`; reorder with a duplicate id or a missing id → `FailedPrecondition`; the created entry's id appears in the returned list; the query is stored and returned byte-for-byte (including odd spacing and characters the daemon cannot interpret); list order after create/delete/reorder; concurrent creates from several goroutines all persist; reorder with a stale id set → `FailedPrecondition`; results visible through `GetConfig`.
- AC: CRUD and reorder usable via the Connect client.

**3.5 `feat(backend): count saved-search queries in GetFacets`**
- Files: `backend/internal/query/count.go` (`Count(q, views) Counts`), `backend/internal/server/items.go` (compile each `queries` entry with per-query errors; 100-query limit).
- Tests: `query/count_test.go` using the fixtures in `fixtures_test.go` (`Count` equals `len(q.Filter(views))`, with `NewCount`/`InboxCount` equal to the `new:any`/`triage:inbox` subsets, for every conformance vector); `server/items_test.go` (`GetFacets` with valid, invalid and `@me` queries; an unset `queries[i]` counts the inbox; implicit inbox per query; `counts` in request order; an invalid query sets only its own `error`, with a path relative to that query; 101 queries → `InvalidArgument` without loading items; replace the 3.2 `Unimplemented` test; `queries` with empty `fields`; an invalid main `query` still fails the request).
- AC: per-query errors never fail the request; one item load per call.

**3.6 `feat(backend): add the pinned repository conversion`**
- Files: `backend/internal/config/migrate.go` (`MigratePinnedRepos`, backup helper; both exercised by tests in this commit so the `unused` linter is satisfied). **Not wired into `Load`/`UpdateProto` yet**, so existing pins keep showing in the old sidebar until 3.9.
- Tests (`migrate_test.go`): converts valid repos to `repo:owner/name`; skips invalid entries and entries whose name **or** query text already exists (a renamed converted search is not recreated); de-duplicates case-insensitively; clears `pinned_repos`; running it twice is a no-op; no limit applied; backup written once, only when there were pins, and never overwritten.
- AC: pure, tested conversion available.

**3.7 `feat(frontend): add the saved searches hook`**
- Files: `frontend/src/logic/savedSearches.ts`, `frontend/src/hooks/useSavedSearches.ts`, `frontend/src/hooks/useDashboardData.ts` (`savedSearchQueries` option added to the sidebar `GetFacets` request; returns `savedSearchCounts`), `Dashboard.test.tsx` `useQuery` stubs (`counts` in the sidebar `GetFacets` response, `savedSearches` in `GetConfig`).
- Tests: `savedSearches.test.ts` (`toView` for valid and invalid text; `badgeScope` table covering every example in §6.3; `buildCountRequest` skips invalid searches; `attachCounts` maps `counts` back to rows; all-items badge picks inbox vs. acked style from `inbox_count`; `tabClauses` (triage clauses, plus the first `new:any` only when there is no triage clause); `isActive` for scoped and unscoped searches, and false when either the current query or the saved search has parse issues; `openSavedSearchText` for every cell of the §7 example table (no duplicated `new:any`; `new:any repo:k/k` opens wholesale on Acked); `suggestName` ignores tab clauses (`triage:acked repo:k/k` suggests `k/k`); `moveItem`); RPC-level tests (the sidebar still issues exactly one `GetFacets` per poll, now with `queries` = the parsed Exprs of valid searches in list order; invalid text yields an error view and no request entry; optimistic reorder and rollback on `FailedPrecondition`).
- AC: no UI yet.

**3.8 `feat(dashboard): save the current query with a pin button`**
- Files: `components/savedSearches/{PinButton,SaveSearchModal}.tsx`, `Dashboard.tsx` (pin next to the input).
- Tests: component tests (suggested names, validation messages, Enter/Escape, focus; edit mode previews the **stored** sort even when the dashboard's sort differs); RPC tests: pin → modal → `CreateSavedSearch` with name, the exact query text and the current sort; the pin is filled exactly when a row is active (including an unscoped search opened on the Acked tab) and opens edit mode; Save in edit mode sends `UpdateSavedSearch` with mask `name` only and the stored sort is unchanged; Delete; disabled for empty or invalid queries; `AlreadyExists` and `ResourceExhausted` shown inline.
- AC: searches can be created, renamed and deleted via the modal.

**3.9 `feat!: replace pinned repositories with saved searches`**
- Files: `backend/internal/config/config.go` (wire `MigratePinnedRepos` and the backup into `Load`/`UpdateProto`, with `slog.Warn` and continue on a failed write; remove `GetPinnedRepos`), `components/savedSearches/SavedSearchList.tsx`, `components/dashboard/DashboardSidebar.tsx`, `components/dashboard/SidebarRow.tsx` (badge variants), `logic/query/facets.ts` (drop pinned parameters), `hooks/useDashboardData.ts`, `hooks/useDashboardFilters.ts` (`openSavedSearch`), `Dashboard.tsx`, `Settings.tsx` (remove Pinned repositories), and tests that reference `pinnedRepos` (`config_test.go`, `notifications_test.go` field lists, `Settings.test.tsx`, `Dashboard.rpc.test.tsx` "lists pinned repos first…", `DataBrowser.test.tsx` fixtures, `rpcTestUtils.tsx`).
- Body must explain the breaking change: pinned repositories are converted into saved searches on first start, including by `octodeck debug` commands (backup at `config.json.bak-pinned-repos`); the Settings field is gone (an old open tab's field empties on reload); downgrading drops saved searches from the config.
- Tests: Go: loading a config with `pinnedRepos` writes `savedSearches`, clears `pinnedRepos` and creates the backup; a second load changes nothing; a config without pins but with a missing id is written back without a backup; when the write-back fails (read-only directory), `Load` still returns the converted config; an unmasked `UpdateConfig` carrying legacy `pinned_repos` appends to the preserved list. RPC tests: badges per scope from the sidebar `GetFacets` `counts` (inbox: slate bubble, orange when `new_count > 0`; new: always orange; acked: faded count without a bubble; all: inbox badge from `inbox_count` when > 0, otherwise faded `count`; zero hidden; `data-scope` and `aria-label` per §6.3); still exactly one sidebar `GetFacets` per poll; an invalid saved text shows the error badge and still opens; the badge does not change when the active tab changes; clicking an unscoped search on the Acked tab sends `triage:acked repo:…` and applies the saved sort; clicking a scoped search (`triage:acked …`, or `new:any repo:k/k` while on the New or Acked tab) replaces the whole query and applies its sort; clicking the active row resets text to the tab clauses and sort to the default; empty state hint; repositories section lists every repo. `facets.test.ts` updated.
- AC: issue #14 sidebar behaviour except edit mode; existing pins appear as saved searches.

**3.10 `feat(dashboard): edit, reorder and delete saved searches in the sidebar`**
- Files: `components/savedSearches/{SavedSearchList,SavedSearchEditRow}.tsx`, `spec.md` (saved searches in `config.json`, saved-search counts and per-value `new_count`/`inbox_count` in `GetFacets`, the pinned-repo conversion; replace `pinned_repos` with `saved_searches` in the Configuration Model list; the dashboard's polling now makes `GetItems` plus two `GetFacets` calls), `docs/user_guide.md` (saved searches, hand-editing `config.json` with the daemon stopped).
- Tests: edit-mode component tests: rename (Enter, blur, Escape, duplicate, too long; the request uses mask `name` and the stored sort is kept, even when the dashboard's current sort differs; the row previews a non-default stored sort), delete with confirm, drag reorder with `fireEvent` drag events, keyboard reorder, live-region text; RPC tests for `UpdateSavedSearch` (mask `name`), `DeleteSavedSearch`, `ReorderSavedSearches` and rollback on `FailedPrecondition`.
- AC: issue #14 complete; `spec.md` updated (Phase 3 milestone).

---

## 12. Risks and edge cases

| Risk / edge case | Handling |
|---|---|
| Hand-edited text that does not parse, or uses a value the daemon rejects. | Error badge and description on the row (§2.3); left out of the sidebar `GetFacets` `queries`; still opens, showing error chips. Server-side rejections arrive as that query's `CountResult.error`. |
| Hand-edited file with missing ids, duplicates or too many entries. | `NormalizeSavedSearches` repairs ids and keeps the rest; per-operation validation still lets the user delete, rename and reorder (§5.3, §5.4). |
| Hand-edited file that is not well-formed protojson (wrong type, unknown enum string, invalid UTF-8). | `Load` fails as for any config field; documented in the user guide (§5.4). |
| A hand edit made while the daemon runs. | Lost on the next write: the RPCs operate on the in-memory copy, as for every config field; documented in the user guide. |
| Concurrent edits from several tabs and the Settings modal. | By-id read-modify-write under `Config.mu`; Settings never writes `saved_searches`; reorder checks the id set; two concurrent reorders: last writer wins (§5.1, §5.3). |
| Atomic writes break test harnesses that use `/dev/null`. | `NewForTest` no longer persists (§5.2, commit 3.3). |
| `octodeck debug …` run after an upgrade performs the pinned-repo conversion and writes `config.json`. | Accepted, temporary version-skew behaviour (§8). |
| `config.json` write fails. | `Internal`; the in-memory list is restored; atomic `saveLocked` never leaves a truncated file. |
| Editing saved searches changes the sidebar request key. | `placeholderData: keepPreviousData` keeps the old numbers until the new response arrives (§6.2). |
| An invalid main `query` in the sidebar call would blank every sidebar number. | The sidebar's main query is the constant `{}`; only `queries` entries can be invalid, and they fail individually. |
| A future grammar change makes previously valid saved text invalid or change meaning. | The grammar must stay backward compatible for valid text; otherwise rows show errors. Add parser golden tests for any saved-search examples in the user guide. |
| Downgrade to a pre-Phase-3 daemon. | Pins gone (already converted) and `savedSearches` dropped on its next write; one-time backup file; release notes (§8). An old frontend against a new daemon ignores the new `FacetValue` fields. |
| `golangci-lint` SA1019 on `pinned_repos`. | Do not mark it deprecated (§4). |
| Pinned repos that are not valid `owner/name`. | Dropped with a warning; kept in the backup file. |
| The daemon cannot evaluate saved searches (future notifications, CLI). | Accepted cost of U13; add a Go parser when such a consumer appears (parent §3.3). |
| Unicode names: `strings.EqualFold` uses simple Unicode case folding. | Accepted; "Straße" and "STRASSE" are different names. |
| `Dashboard.test.tsx` stubs `useQuery` per RPC and expects two sidebar facet calls today. | Update the stubs in commit 3.1 (one sidebar call) and 3.7 (`counts`); components tolerate missing `counts`. |
