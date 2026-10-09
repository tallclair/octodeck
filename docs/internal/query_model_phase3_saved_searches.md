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
  - the text state of record and `useDashboardFilters` API (`state.text`, `parsed`, `setText`, `openSavedSearch` placeholder) ([Phase 2 §4](query_model_phase2_query_input.md));
  - the clause splices `insertClause`/`removeClause` and the tab-clause rules ([Phase 2 §5](query_model_phase2_query_input.md));
  - the query input in the list header, where the pin button goes ([Phase 2 §9](query_model_phase2_query_input.md)), and the error-chip style used for invalid saved text ([Phase 2 §6.3](query_model_phase2_query_input.md));
  - `DashboardSidebar` and `SidebarRow` from the Phase 1 extraction ([Phase 1 §7](query_model_phase1_multiselect.md)).
- User decisions that apply here: U4, U6, U10, U12, U13, U14 ([overview](query_model_plan_overview.md#21-decided-by-the-user)).

---

## 2. Goals, non-goals and UI

Goals: replace the "Pinned" sidebar section with saved searches (#14): a pin button next to the query input, a naming modal, a sidebar section with badges, and an edit mode with reorder handles, rename and delete. Convert existing `pinned_repos`.

Non-goals:
- Editing a saved search's query in place (deferred, U10).
- Evaluating saved searches in the daemon on its own (per-search notifications, a CLI). The daemon stores text and never parses it (U13); a Go parser is added if a Go-side text consumer ever appears (parent §3.3).
- Import/export beyond what `config.json` already gives (it is the export).

### 2.1 Pin button

- Lucide `Pin` icon button at the right end of the query input row; `aria-label="Save search"`.
- **Outline** when the current query matches no saved search; **filled/blue** when it matches one (`aria-label="Edit saved search <name>"`). Matching compares `canonicalQuery(text)` (sort ignored); saved searches whose text has parse issues never match.
- Disabled, with a tooltip, when the text is empty ("The Inbox is always in the sidebar") or the query has issues ("Fix the highlighted parts of the query first").
- Outline click → naming modal in create mode. Filled click → naming modal in edit mode for the matched search.

### 2.2 Naming modal (`SaveSearchModal`)

- Title "Save search" (create) or "Saved search" (edit). Styling and focus handling follow [`KeyboardShortcutsModal.tsx`](../../frontend/src/components/KeyboardShortcutsModal.tsx) (focus trap, Escape closes, backdrop click closes).
- **Name** input, autofocused and fully selected. Suggested name in create mode: the repo name if the query is exactly one non-negated single-value `repo:` clause, otherwise the query text truncated to 40 characters with an ellipsis.
- Read-only preview of the query text (monospace) and of the sort ("Latest activity, newest first").
- Create mode buttons: Cancel, **Save** (Enter). Saves the name, the query text of record (exactly as in the input), sort and order.
- Edit mode buttons: Delete (left, with inline confirm), Cancel, **Save** (renames and updates the stored sort to the current one: mask `name,sort`). The query itself is not changed (U10).
- Errors inline under the name field: empty or too long name, name taken (`AlreadyExists`), limit reached (`ResourceExhausted`).

### 2.3 Sidebar

Order: Workflows (Inbox, New, Acked) → **Saved searches** → Repositories.
- Header "SAVED SEARCHES" with a pin icon and a pencil button (`aria-label="Edit saved searches"`) that toggles edit mode ("Done" while editing).
- Rows use `SidebarRow`: name, a badge styled by the saved query's triage scope (§6.1), and the active highlight.
- **Invalid text** (parse issues, e.g. after a hand edit of `config.json`, or a server `CountResult.error`): the row shows an error badge instead of a count: lucide `AlertTriangle` (12 px, `text-red-600`) with the first issue message as `title`, and the row gets `aria-description="Error: <message>"`. The row still opens the search on click, so the user sees the error chips in the input. It never throws or hides the row.
- Empty state: one muted line, "Pin a search with the pin button next to the query".
- The "Repositories" section lists every repo (there is no pinned subset any more), keeping the 30-day "More" split from `buildSidebar`.

Click behaviour: §7.

### 2.4 Edit mode

- Each row shows: a drag handle button (lucide `GripVertical`, `aria-label="Reorder <name>"`), the name as a text input, and a delete button (lucide `Trash2`).
- **Rename:** Enter or blur saves when changed and valid; Escape reverts; invalid (empty, too long, duplicate) shows a red border with the message as `title` and is not saved.
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
- **The wire format does not change:** the frontend parses the stored text and sends the resulting structured `Expr` to `GetItems`/`GetFacets`/`CountItems`, exactly as for typed queries (parent §3.2).
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

Hand edits are read when the daemon loads the config (startup). As for every other config field today, a hand edit made while the daemon runs is overwritten by the daemon's next config write; the user guide says to stop the daemon before editing.

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
  // Match counts for several queries in one evaluation pass (saved-search badges).
  rpc CountItems(CountItemsRequest) returns (CountItemsResponse);

// Appended at the end of the list. id is ignored.
message CreateSavedSearchRequest { SavedSearch saved_search = 1; }
message CreateSavedSearchResponse {
  SavedSearch saved_search = 1;            // as stored, with its id
  repeated SavedSearch saved_searches = 2; // the full list after the change
}

message UpdateSavedSearchRequest {
  // id selects the entry; other fields per update_mask.
  SavedSearch saved_search = 1;
  // Paths: "name", "sort". Empty means both. ("query" is not updatable yet, U10.)
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

message CountItemsRequest {
  // At most 100 queries.
  repeated Expr queries = 1;
}
message CountItemsResponse {
  // One result per query, in request order.
  repeated CountResult results = 1;
}
```

`api/octodeck/v1/query.proto`:

```proto
// Result of one CountItems query.
message CountResult {
  // Items matching the query (with the implicit triage scope, exactly as GetItems).
  int32 count = 1;
  // Of those, items matching new:any. These are always inbox items (acked items have no flags).
  int32 new_count = 2;
  // Of those, items in the inbox (computed status is not ACKED).
  int32 inbox_count = 3;
  // Set when the query is invalid; the counts are then 0.
  ExprError error = 4;
}
```

The handler (`octoDeckHandler` in [`handler.go`](../../backend/internal/server/handler.go)) does not embed the generated `Unimplemented…Handler`, so the proto commit adds stub methods returning `connect.CodeUnimplemented` for every new RPC.

---

## 5. Server: config storage, RPCs and concurrency

### 5.1 Why dedicated RPCs with server-side read-modify-write (P22)

Two writers can touch the config concurrently: the Settings modal (which holds a possibly stale copy of the whole config) and the sidebar edit mode (possibly in several tabs).
- The Settings modal already sends `UpdateConfig` with an explicit update mask of the fields it edits (`DASHBOARD_CONFIG_FIELDS` in [`Settings.tsx`](../../frontend/src/Settings.tsx)), so it never writes `saved_searches`. The server enforces this: `UpdateConfig` returns `InvalidArgument` if the mask contains `saved_searches`, and on a full (unmasked) update it keeps the current `saved_searches` and ignores the request's.
- Replacing the whole list through `UpdateConfig` from the sidebar would lose concurrent edits from another tab unless an etag were added. Instead, each saved-search RPC changes one entry **by id** inside a read-modify-write under `Config.mu`, so concurrent creates/renames/deletes all survive without a version check. The only order-sensitive operation, reorder, must name exactly the current set of ids, otherwise it fails with `FailedPrecondition` and the client refetches.

### 5.2 Config API ([`config.go`](../../backend/internal/config/config.go), new `saved_searches.go` in the same package)

```go
// GetSavedSearches returns a deep copy of the saved searches, in display order.
func (c *Config) GetSavedSearches() []*octodeckv1.SavedSearch

// UpdateSavedSearches runs fn on a deep copy of the list under c.mu. If fn succeeds, the result is
// validated (ValidateSavedSearches), stored and written to disk. If the write fails, the previous
// list is restored and the error returned.
func (c *Config) UpdateSavedSearches(
    fn func([]*octodeckv1.SavedSearch) ([]*octodeckv1.SavedSearch, error),
) ([]*octodeckv1.SavedSearch, error)

// ValidateSavedSearchName / ValidateSavedSearchQuery enforce the limits below.
// NormalizeSavedSearches repairs a loaded list (missing/duplicate ids, empty queries); see §5.4.
// MigratePinnedRepos converts pinned_repos into saved searches; see §8.
```

Also in this phase, make `saveLocked` write atomically (write a temp file in the same directory, `fsync`, then `os.Rename`): the file now holds user data that is not recoverable from GitHub.

### 5.3 Validation and errors

Limits (validated server-side on every mutation): at most **50** saved searches; names trimmed, **1–80 characters**, no control characters, unique under `strings.EqualFold`; query non-empty after trimming, at most 1000 characters, no `\r` or `\n`. The query is stored exactly as sent (not trimmed or normalised) and never parsed.

| Condition | Code |
|---|---|
| Name empty, too long, or with control characters | `InvalidArgument` |
| Query empty, too long, or containing a line break | `InvalidArgument` |
| Name already used (case-insensitive) | `AlreadyExists` |
| Creating the 51st search | `ResourceExhausted` |
| Unknown id (update, delete) | `NotFound` |
| Unknown update-mask path (including `query`) | `InvalidArgument` |
| Reorder ids not a permutation of the current ids | `FailedPrecondition` |
| `UpdateConfig` mask containing `saved_searches` | `InvalidArgument` |
| Writing `config.json` fails | `Internal` (in-memory list unchanged) |

IDs: `crypto/rand`, 16 bytes, hex-encoded. No new dependency.

### 5.4 Loading hand-edited files

`config.Load` must never fail because of saved-search content. `NormalizeSavedSearches` runs on load and on `UpdateProto`:
- missing or duplicate ids → new ids;
- entries whose query is empty after trimming → dropped (logged with `slog.Warn`);
- names that are empty → the query truncated to 80 characters; names longer than 80 → truncated;
- duplicate names and more than 50 entries are **kept** (logged); the RPCs only prevent creating new violations;
- query text is not checked for syntax (the browser does that and shows an error row, §2.3).

If normalisation changed anything during `Load`, the config is written back once (same path as the migration, §8).

---

## 6. `CountItems` and badges (P13, P24)

Server:

```go
func (h *octoDeckHandler) CountItems(ctx context.Context,
    req *connect.Request[octodeckv1.CountItemsRequest]) (*connect.Response[octodeckv1.CountItemsResponse], error)
```
- More than 100 queries: `InvalidArgument`. No queries: empty response without touching the database.
- Load every item once (`h.db.GetItems(ctx, nil)`) and build views once (`h.queryViews`), exactly as `GetFacets` does in [`items.go`](../../backend/internal/server/items.go).
- For each query: `h.compileQuery` semantics but **per-query errors** (put `ValidationError.Proto()` in `CountResult.error` rather than failing the request), so one stale saved search cannot blank every badge.
- New `query.Count(q *Query, views []*View) (count, newCount, inboxCount int32)` in `backend/internal/query/count.go`: one pass, `q.Match(v)`, then `matchNew(valueAny, v)` and `matchTriage(valueInbox, v)` from [`eval.go`](../../backend/internal/query/eval.go).

Client (`useSavedSearches`, §9.1): for each saved search, `parseQuery(search.query)`; searches whose text has issues are **left out of the request** and shown in the error state (§2.3). The request contains `toExpr(parsed)` for the rest, in list order, with an index map back to the rows. No derived queries are sent: `count`, `new_count` and `inbox_count` cover every badge (P24). Polled with the existing `POLL` (3 s, `staleTime` 1 s), `placeholderData: keepPreviousData`, disabled when no valid search exists, and included in `refreshAll` so it refreshes after syncs and mutations.

Cost: one full item load and one view build per poll, the same as one `GetFacets` call (the dashboard already makes three `GetFacets` calls and one `GetItems` per poll), plus `O(queries × items)` in-memory evaluations. With the 50-search cap and a few thousand items this is a few milliseconds. If it ever matters, cache views per sync generation for all list/facet/count handlers (out of scope).

### 6.1 Badge semantics by triage scope (U12, U14, P21)

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

Rendering (in `SidebarRow`; nothing is shown when the relevant number is 0):

| Scope | Badge | Classes |
|---|---|---|
| inbox | `count` in a bubble; **orange** when `new_count > 0`, slate otherwise (today's repo-row badge) | orange: `bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300`; slate: `bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300`; both `text-[10px] px-1.5 rounded-full font-mono` |
| new | `count` in an **always orange** bubble | orange classes above |
| acked | `count` as **faded text, no bubble** | `text-[10px] font-mono text-slate-400 dark:text-slate-500` |
| all (U14) | if `inbox_count > 0`: exactly the inbox badge, using `inbox_count` (orange when `new_count > 0`, slate otherwise). If `inbox_count = 0`: the acked style showing `count` (all matching items, which are then all acked) | as inbox / acked above |
| error | `AlertTriangle` icon instead of a count (§2.3) | `text-red-600` |

Each badge has an `aria-label`: "N items" (with ", some with new activity" for an orange bubble) or "N items with new activity" for new searches, and "N acked items" for the faded style. `data-scope` on the row carries the scope for tests.

---

## 7. Opening a saved search and the triage tabs (P16)

Parent §4.6: "A saved search that omits `triage:` runs within whichever triage tab is active."

Opening first parses the saved text. Text with issues is still opened (the input shows the error chips, [Phase 2 §7](query_model_phase2_query_input.md)).

- **Saved query has a triage predicate** (any `triage` clause): opening it replaces the text with the saved text and applies its sort/order (`pushState`).
- **No triage predicate:** opening it keeps the active tab's clauses (every `triage` clause, and the `new:any` clause when it is the New tab's) and replaces everything else with the saved text: `insertClause` the tab clauses at rank 0 into the saved text. Example: on the Acked tab, opening "k8s" (`repo:kubernetes/kubernetes`) gives `triage:acked repo:kubernetes/kubernetes`. This preserves the current pinned-repo behaviour (clicking a pinned repo keeps the tab, because `toggleRepo` only changes repo/org).
- **Active highlight:** a row is active when `canonicalQuery(current text minus tab clauses) === canonicalQuery(saved text)` (for searches without a triage predicate) or `canonicalQuery(current) === canonicalQuery(saved)` (with one). Sort is ignored. Rows with parse issues are never highlighted.
- **Clicking the active row** returns to the current tab's workflow (text = tab clauses only), mirroring how clicking the selected pinned repo cleared it.
- **Badges** count the saved query with its own meaning, independent of the active tab, and are styled by its own triage scope (§6.1). Opening a search on another tab does not change its badge.
- **Pin matching** (§2.1) compares the full canonical text, tab clauses included, so pinning on the Acked tab saves `triage:acked …` explicitly.

---

## 8. Converting `pinned_repos` (P23)

Server-side, in the config package, on **load and update** (the same normalisation step as `SanitizeTrackedQueries` today):

`MigratePinnedRepos(cfg *octodeckv1.Config) (changed bool)`:
1. For each `pinned_repos` entry, trimmed, de-duplicated case-insensitively, in order: if it matches `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`, append `{id: new, name: repo, query: "repo:" + repo}` unless a saved search with that name already exists (`strings.EqualFold`). Otherwise drop it with a `slog.Warn`. `repo:owner/name` is the only query text Go ever writes; GitHub repo names cannot contain spaces, quotes or commas, so no quoting is needed.
2. Clear `pinned_repos`.
3. The 50-entry limit is not applied here (existing pins are never lost); creating new searches is blocked until the user is under the limit.

In `config.Load`, if migration or normalisation changed anything: copy the original file to `config.json.bak-pinned-repos` (only if that backup does not exist yet), then write the converted config with the atomic `saveLocked`.

Properties:
- **Idempotent without a marker:** the conversion is a function of the file content and runs in a single file write. After a successful write `pinned_repos` is empty, so it never runs again; if the write fails, the file still has `pinned_repos` and no new saved searches, so the next load redoes exactly the same conversion. A user who deletes a converted search does not get it back.
- **Old clients:** if an older frontend sends `pinned_repos` through `UpdateConfig`, `UpdateProto` converts it again (appending only names not already present).
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
  hasTriage: boolean;
  scope: BadgeScope;     // badgeScope(parsed), §6.1
  sort: SortOption;
  order: SortOrder;
  count: number | null;  // null until counts arrive (or when invalid)
  newCount: number;
  inboxCount: number;
  error: string | null;  // first parse issue, or the server CountResult.error message
}

export function useSavedSearches(): {
  searches: SavedSearchView[];
  isLoading: boolean;
  create(input: { name: string; text: string; sort: SortOption; order: SortOrder }): Promise<SavedSearchView>;
  update(id: string, patch: { name?: string; sort?: SortOption; order?: SortOrder }): Promise<void>;
  remove(id: string): Promise<void>;
  reorder(ids: string[]): Promise<void>; // optimistic, rolls back on error
  refetchCounts(): Promise<unknown>;
};
```
- The list comes from the existing `GetConfig` query (`config.savedSearches`); mutations write the returned list into that query's cache and invalidate it.
- `create` refuses (throws) if `parseQuery(text)` has issues (the pin button is disabled in that case anyway).
- Pure helpers in `frontend/src/logic/savedSearches.ts` (unit-tested): `toView`, `badgeScope`, `buildCountRequest(views)` (returns the Exprs plus the index map), `matchesExactly(state, view)`, `isActive(parsed, view)`, `openSavedSearchText(currentParsed, view)`, `suggestName(parsed)`, `moveItem(ids, from, to)`.
- `useDashboardFilters.openSavedSearch(view)` applies `openSavedSearchText` (§7).

### 9.2 Components (`frontend/src/components/savedSearches/`)

- `PinButton.tsx`, `SaveSearchModal.tsx`, `SavedSearchList.tsx` (normal and edit mode), `SavedSearchEditRow.tsx`.
- `DashboardSidebar` renders `SavedSearchList` in place of the pinned section; `SidebarRow` gains the badge variants of §6.1.

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
| P13 | Badges use a generic `CountItems(Expr[])` RPC with per-query errors; the client builds the Exprs from the stored text. | One evaluation pass for all badges; one stale search cannot blank the others; reusable beyond saved searches. | §6 |
| P16 | Opening a saved search without a triage predicate keeps the active tab's predicate (parent §4.6). | Preserves today's pinned-repo behaviour. | §7 |
| P17 | At most 50 saved searches; names 1–80 characters, unique case-insensitively; queries up to 1000 characters on one line. All validated server-side. | Bounds `CountItems` cost and keeps the sidebar unambiguous. | §5.3 |
| P18 | Reorder uses native HTML5 drag and drop on a handle plus ArrowUp/ArrowDown on the focused handle. | No new dependency; accessible. | §9.4 |
| P21 | Badge scope is classified from top-level predicates only; anything ambiguous uses inbox behaviour; `new:noise` alone is not new activity. | Deterministic and cheap; noise is never "worth looking at" (parent §4.4). | §6.1 |
| P22 | Dedicated saved-search RPCs doing a by-id read-modify-write under the config lock; reads go through `GetConfig`; `UpdateConfig` never changes the list. | No lost updates between tabs or with the Settings modal, without an etag. | §5.1 |
| P23 | `pinned_repos` is converted server-side on config load/update, then cleared; a one-time backup of the original file is written. | Atomic and idempotent in one file write, no marker; follows the existing load-normalisation pattern. | §8 |
| P24 | `CountResult` gains `inbox_count` instead of the client sending derived inbox-scoped queries. | All-items badges (U14) need it; computing it in the same pass is cheaper and keeps the client from rewriting Exprs. | §6 |

---

## 11. Commit plan

Each commit must leave `./verify.sh` green (never `--force`). Commit subjects follow Conventional Commits with no backticks. Generated code is regenerated by the existing tooling when a proto changes.

**3.1 `feat(api): add saved searches to the config and a CountItems RPC`**
- Files: `api/octodeck/v1/service.proto` (`SavedSearch`, `Config.saved_searches`, the four saved-search RPCs, `CountItems`, `pinned_repos` comment), `api/octodeck/v1/query.proto` (`CountResult`), regenerated Go/TS, `backend/internal/server/saved_searches.go` with `CodeUnimplemented` stubs, `CountItems` stub in `items.go`.
- Tests: none beyond build and lint (stubs).
- AC: `./verify.sh` green; no behaviour change.

**3.2 `feat(backend): store saved searches in the config file`**
- Files: `backend/internal/config/saved_searches.go` (`GetSavedSearches`, `UpdateSavedSearches`, `ValidateSavedSearchName`, `ValidateSavedSearchQuery`, `NormalizeSavedSearches`), `backend/internal/config/config.go` (normalise on `Load`/`UpdateProto`; `UpdateProto` preserves `saved_searches` on full updates; atomic `saveLocked`), `backend/internal/server/handler.go` (`UpdateConfig` rejects masks with `saved_searches`).
- Tests (`config_test.go`, `saved_searches_test.go`, `handler_test.go`): protojson round trip of `savedSearches`; normalisation table (missing/duplicate ids, empty query dropped, empty/long names, duplicates and >50 kept); `Load` of a hand-edited file never fails; `UpdateProto` with an empty mask keeps the list; `UpdateConfig` with `saved_searches` in the mask → `InvalidArgument`; `UpdateSavedSearches` restores the previous list when the write fails; atomic write leaves no partial file.
- AC: saved searches persist across daemon restarts.

**3.3 `feat(backend): serve the saved search RPCs`**
- Files: `backend/internal/server/saved_searches.go`.
- Tests (`server/saved_searches_test.go`, through the real Connect client as in `items_test.go`): every row of the §5.3 table; the query is stored and returned byte-for-byte (including odd spacing and characters the daemon cannot interpret); list order after create/delete/reorder; concurrent creates from several goroutines all persist; reorder with a stale id set → `FailedPrecondition`; results visible through `GetConfig`.
- AC: CRUD and reorder usable via the Connect client.

**3.4 `feat(backend): count items for several queries in one call`**
- Files: `backend/internal/query/count.go`, `backend/internal/server/items.go`.
- Tests: `query/count_test.go` using the fixtures in `fixtures_test.go` (`count` equals `len(q.Filter(views))`, `newCount` equals the `new:any` subset, `inboxCount` equals the `triage:inbox` subset, for every conformance vector); `server/items_test.go` (`CountItems` with valid, invalid and `@me` queries; implicit inbox; 100-query limit; empty request).
- AC: per-query errors never fail the request.

**3.5 `feat(backend): add the pinned repository conversion`**
- Files: `backend/internal/config/migrate.go` (`MigratePinnedRepos`, backup helper). **Not wired into `Load`/`UpdateProto` yet**, so existing pins keep showing in the old sidebar until 3.8.
- Tests (`migrate_test.go`): converts valid repos to `repo:owner/name`; skips invalid entries and names that already exist; de-duplicates case-insensitively; clears `pinned_repos`; running it twice is a no-op; no limit applied; backup written once and never overwritten.
- AC: pure, tested conversion available.

**3.6 `feat(frontend): add the saved searches hook`**
- Files: `frontend/src/logic/savedSearches.ts`, `frontend/src/hooks/useSavedSearches.ts`, `frontend/src/hooks/useDashboardData.ts` (`refreshAll` includes counts), `Dashboard.test.tsx` `useQuery` stubs (empty `CountItems` responses, `savedSearches` in `GetConfig`).
- Tests: `savedSearches.test.ts` (`toView` for valid and invalid text; `badgeScope` table covering every example in §6.1; `buildCountRequest` skips invalid searches and maps results back; all-items badge picks inbox vs. acked style from `inbox_count`; `isActive` with and without triage; `openSavedSearchText` tab preservation; `suggestName`; `moveItem`); `useSavedSearches` RPC-level tests (`CountItems` request contains the parsed Exprs of valid searches in list order; invalid text yields an error view and no request entry; polling; optimistic reorder and rollback on `FailedPrecondition`).
- AC: no UI yet.

**3.7 `feat(dashboard): save the current query with a pin button`**
- Files: `components/savedSearches/{PinButton,SaveSearchModal}.tsx`, `Dashboard.tsx` (pin next to the input).
- Tests: component tests (suggested names, validation messages, Enter/Escape, focus); RPC tests: pin → modal → `CreateSavedSearch` with name, the exact query text and sort; pin is filled for a matching query and opens edit mode (`UpdateSavedSearch` mask `name,sort`, Delete); disabled for empty or invalid queries; `AlreadyExists` and `ResourceExhausted` shown inline.
- AC: searches can be created, renamed and deleted via the modal.

**3.8 `feat!: replace pinned repositories with saved searches`**
- Files: `backend/internal/config/config.go` (wire `MigratePinnedRepos` and the backup into `Load`/`UpdateProto`; remove `GetPinnedRepos`), `components/savedSearches/SavedSearchList.tsx`, `components/dashboard/DashboardSidebar.tsx`, `components/dashboard/SidebarRow.tsx` (badge variants), `logic/query/facets.ts` (drop pinned parameters), `hooks/useDashboardData.ts`, `Dashboard.tsx`, `Settings.tsx` (remove Pinned repositories), and tests that reference `pinnedRepos` (`config_test.go`, `notifications_test.go` field lists, `Settings.test.tsx`, `Dashboard.rpc.test.tsx` "lists pinned repos first…", `DataBrowser.test.tsx` fixtures, `rpcTestUtils.tsx`).
- Body must explain the breaking change: pinned repositories are converted into saved searches on first start (backup at `config.json.bak-pinned-repos`); the Settings field is gone; downgrading drops saved searches from the config.
- Tests: Go: loading a config with `pinnedRepos` writes `savedSearches`, clears `pinnedRepos` and creates the backup; a second load changes nothing. RPC tests: badges per scope from `CountItems` (inbox: slate bubble, orange when `new_count > 0`; new: always orange; acked: faded count without a bubble; all: inbox badge from `inbox_count` when > 0, otherwise faded `count`; zero hidden; `data-scope` and `aria-label` per §6.1); an invalid saved text shows the error badge and still opens; the badge does not change when the active tab changes; clicking a search without triage on the Acked tab sends `triage:acked repo:…`; clicking a search with triage replaces the query and applies its sort; clicking the active row returns to the tab; empty state hint; repositories section lists every repo. `facets.test.ts` updated.
- AC: issue #14 sidebar behaviour except edit mode; existing pins appear as saved searches.

**3.9 `feat(dashboard): edit, reorder and delete saved searches in the sidebar`**
- Files: `components/savedSearches/{SavedSearchList,SavedSearchEditRow}.tsx`, `spec.md` (saved searches in `config.json`, `CountItems`, the pinned-repo conversion; replace `pinned_repos` with `saved_searches` in the Configuration Model list), `docs/user_guide.md` (saved searches, hand-editing `config.json` with the daemon stopped).
- Tests: edit-mode component tests: rename (Enter, blur, Escape, duplicate, too long), delete with confirm, drag reorder with `fireEvent` drag events, keyboard reorder, live-region text; RPC tests for `UpdateSavedSearch` (mask `name`), `DeleteSavedSearch`, `ReorderSavedSearches` and rollback on `FailedPrecondition`.
- AC: issue #14 complete; `spec.md` updated (Phase 3 milestone).

---

## 12. Risks and edge cases

| Risk / edge case | Handling |
|---|---|
| Hand-edited text that does not parse, or uses a value the daemon rejects. | Error badge and description on the row (§2.3); left out of `CountItems`; still opens, showing error chips. Server-side rejections arrive as `CountResult.error`. |
| Hand-edited file with missing ids, duplicates or too many entries. | `NormalizeSavedSearches` repairs ids and keeps the rest; `Load` never fails (§5.4). |
| A hand edit made while the daemon runs. | Overwritten by the daemon's next config write, as for every config field; documented in the user guide. |
| Concurrent edits from several tabs and the Settings modal. | By-id read-modify-write under `Config.mu`; Settings never writes `saved_searches`; reorder checks the id set (§5.1). |
| `config.json` write fails. | `Internal`; the in-memory list is restored; atomic `saveLocked` never leaves a truncated file. |
| A future grammar change makes previously valid saved text invalid or change meaning. | The grammar must stay backward compatible for valid text; otherwise rows show errors. Add parser golden tests for any saved-search examples in the user guide. |
| Downgrade to a pre-Phase-3 daemon. | Pins gone (already converted) and `savedSearches` dropped on its next write; one-time backup file; release notes (§8). |
| `golangci-lint` SA1019 on `pinned_repos`. | Do not mark it deprecated (§4). |
| Pinned repos that are not valid `owner/name`. | Dropped with a warning; kept in the backup file. |
| The daemon cannot evaluate saved searches (future notifications, CLI). | Accepted cost of U13; add a Go parser when such a consumer appears (parent §3.3). |
| Unicode names: `strings.EqualFold` uses simple Unicode case folding. | Accepted; "Straße" and "STRASSE" are different names. |
| `Dashboard.test.tsx` stubs `useQuery` per RPC; `CountItems` returns undefined there. | Components tolerate `undefined`; stubs updated in commit 3.6. |
