# Design: Dashboard Query Model

**Status:** Proposed (Phase 0 not started)
**Tracking:** [#14 Saved searches](https://github.com/tallclair/octodeck/issues/14), [#15 Selector multi-select](https://github.com/tallclair/octodeck/issues/15)

## 1. Motivation

Four dashboard features are planned:

1. **Multi-select** for the repo, author and label selectors (#15).
2. **Saved searches** that replace pinned repos in the sidebar (#14): a pin icon next to the search bar, a naming modal, and an edit mode with reorder handles, rename and delete.
3. **Advanced filter syntax** modelled on GitHub's search, including negative filters (`-assignee:tallclair`), while keeping the current "chips" display.
4. **Activity filters**: filter to new items, new activity, new mentions, etc.

These are not independent. All four put pressure on the same thing: the filter data model.

| Feature | What it needs from the model |
|---|---|
| Multi-select | Values become lists (`repo: string[]`) |
| Negative filters | Each condition can be negated |
| Activity filters | A new dimension over computed item status |
| Saved searches | A stable, serializable form of the whole filter state |

Today [`DashboardFilterState`](../../frontend/src/types/filters.ts) is a flat set of single-value fields. Building the features independently would reshape that model, the URL format and the filter evaluation several times, and saved searches would persist a format that is about to change. Building everything as one overhaul would produce a very large diff in an already 1,900-line `Dashboard.tsx`.

**Decision:** build one shared foundation (the query model) first, then ship the features as separate, small changes on top of it.

### 1.1 Current state of the code

- **All filtering is client-side.** `Dashboard` calls `GetItems({})` every 3 seconds and runs `applyFilters` over the full item list. The extension background worker and the DataBrowser also fetch unfiltered.
- **The backend `Filter` message is partially implemented and unused.** Some fields become SQL in `database.go`; status, milestone and labels are filtered after the query in `handler.go`. It has already drifted from the client: the backend's `query` field only matches the repo name, while the client's free text matches title, body, repo, author, milestone, labels and `#number`.
- **Item status is computed in Go** (`logic.CalculateStatus`) as a single value chosen by priority: ACKED, NEW_MENTION, NEW_ACTIVITY, NEW_CODE, NOISE, IDLE, with NEW for never-viewed items.
- **Selector options and sidebar counts are derived client-side** from the full item list (`extractUnique*`, per-repo inbox counts).

## 2. Phasing

| Phase | Scope |
|---|---|
| **0** | Structured query model in the API, Go validator/evaluator, facets endpoint. Dashboard moves to backend filtering. **The UI is unchanged**: existing dropdowns and chips write predicates instead of separate fields. |
| 1 | Multi-select (repo, author, label) and activity filter UI. |
| 2 | Free-form query input that keeps the chips (TypeScript parser/formatter); `?q=` URLs with conversion of old links. |
| 3 | Saved searches replacing pinned repos (pin icon, naming modal, sidebar edit mode). |

## 3. Data model

### 3.1 Expression tree

The query is a general boolean expression tree:

```proto
message Expr {
  oneof kind {
    Predicate predicate = 1;
    ExprList and = 2;
    ExprList or = 3;
    Expr not = 4;
  }
}
message ExprList { repeated Expr exprs = 1; }

message Predicate {
  Field field = 1;             // enum: TRIAGE, STATE, TYPE, REPO, AUTHOR, LABEL, NEW, TEXT, ...
  repeated string values = 2;  // ORed together
  bool negated = 3;            // -label:bug
}
```

Common queries are an AND of predicates, which is the only shape Phase 0 and the chips UI produce. Grouping and explicit OR are supported by the model and only require parser and UI work later; the wire format and stored saved searches do not change.

**Alternatives considered**

- *Require CNF (an AND of OR-groups).* It matches the chip model exactly (one chip = one OR-group) and the GitHub-style syntax. But CNF is a poor general format: `(repo:a author:x) OR (repo:b author:y)` grows exponentially when converted, and the converted form no longer resembles what the user typed. The tree costs very little extra: evaluation is one small recursive function.
- *Keep the flat `DashboardFilterState`.* Cannot express negation or multiple values without a redesign per feature.

### 3.2 Wire format: structured, not text

`GetItems` and `GetFacets` take an `Expr`, not a query string.

An earlier draft of this design put the query text on the wire with the parser in Go. It was rejected because, in Phase 0, the frontend holds structured dropdown state at one end and the backend evaluates a structured tree at the other; a text round-trip in between would introduce a TypeScript serializer and a Go parser that must agree, which is exactly the drift problem the design is trying to remove. Several operations are also simpler on the tree: removing a field's own predicates for facets, inserting the implicit triage scope, and reporting validation errors. A UI-built query cannot contain syntax errors.

Text is an **input format**, produced where users type (Phase 2 input, pasted GitHub queries, `?q=` URLs), not the API contract.

### 3.3 Ownership of syntax vs. semantics

- **TypeScript owns syntax** (Phase 2): `parseQuery(text) -> Expr` and `formatQuery(Expr) -> text`, including `is:` expansion, quoting, commas and `-`. It runs locally on every keystroke, which the chips and autocomplete need anyway. It is tested as a round-trip property in TypeScript alone.
- **Go owns semantics**: validation of the `Expr` (known field, non-empty values, legal values for closed sets, `triage:all` expansion, the implicit `triage:inbox`), `@me` resolution, and evaluation. The backend never trusts the client's tree.
- **The proto is the single source of truth for the vocabulary**: the `Field` enum plus documented value sets for closed fields. The `is:` shorthand table is syntactic sugar and lives only in the frontend.
- **There is no `ParseQuery` RPC and no Go parser.** Every place that needs text parsing (the Phase 2 input, pasted queries, URLs) is in the browser. Saved searches are stored as `Expr` and evaluated by Go without parsing. A Go parser can be added if a text consumer ever appears in Go (CLI, MCP tool).

**Alternatives considered**

- *Parser in Go with a `ParseQuery(text)` RPC returning tokens with positions.* Rejected: once the wire format is structured, nothing in Go needs to read text, and a per-keystroke round trip is worse than a local parser for the input UI.
- *Parser in both languages with shared test vectors.* Rejected as unnecessary duplication.

### 3.4 Where filtering runs

Filtering, facets and counts run **only in the backend**:

- The daemon is local, so a round trip costs milliseconds; React Query's `keepPreviousData` avoids flicker.
- Item status is already computed in Go, so activity filters belong there.
- Saved-search badge counts, the extension and any future per-search notifications reuse the same engine.
- It stops shipping every item, comments included, to the browser every 3 seconds.

**Alternatives considered for keeping client-side evaluation in sync**, in case it is ever wanted again:

1. Shared language-neutral JSON test vectors (item fixtures + query -> expected IDs) run by both `go test` and Vitest. Cheap, catches most drift. The TypeScript side would also need a copy of `CalculateStatus`.
2. Compile the query to CEL and evaluate against the proto `Item`. cel-go is solid; the JavaScript implementations are less mature, so it would still be two engines.
3. Go compiled to WASM. A single engine, but adds bundle size and needs a `wasm-unsafe-eval` CSP exception in the extension. Too heavy.

The Go evaluation vectors from option 1 are kept as a conformance suite regardless.

## 4. Query language

The text syntax below is what Phase 2 parses and formats. The same rules describe the structured model.

### 4.1 Combining values

- `key:a,b` means a OR b.
- Repeating a qualifier, `key:a key:b`, means AND.
- `-key:a,b` means NOT (a OR b): neither a nor b.
- The rule is the same for every field. `repo:x repo:y` matches nothing, which is consistent if not useful. The multi-select UI always writes the comma form, so one chip is one predicate.
- Values are case-insensitive. Quote values containing spaces: `label:"good first issue"`.

These are GitHub's semantics. The alternative, ORing repeated single-value fields (repo, author) but ANDing multi-value ones (label), was rejected as a special case users would have to learn.

### 4.2 Per-dimension keys, with `is:` as shorthand

Two syntaxes were weighed:

- **GitHub's overloaded `is:`** (`is:open`, `is:pr`, `is:inbox`). Familiar, and queries can be pasted between GitHub and OctoDeck (the config's `tracked_queries` are already GitHub search strings). But one clause can span several dimensions: `is:open,pr` means "open OR PR", which is legal but meaningless; the implicit inbox rule becomes "unless some `is:` clause contains a triage value"; and chips, dropdowns and facets all have to sort values into dimensions before they can act on them.
- **A key per dimension** (`state:open`, `type:pr`, `triage:inbox`). One key is one dimension, so comma-OR always makes sense, the implicit-scope rule is trivial, and each key maps to one dropdown, one chip and one facet. Less familiar, and `triage:` and `tracking:` exist only here.

The problems with `is:` are about meaning; the problems with dimension keys are about familiarity. **Decision: hybrid.**

- The internal model is per-dimension; every predicate has exactly one field.
- The parser accepts `is:` as shorthand and expands it (`is:open` -> `state:open`, `is:inbox` -> `triage:inbox`).
- An `is:` clause mixing dimensions (`is:open,pr`) is a parse error.
- The UI always writes dimension keys. Writing `is:` for single GitHub-known values and dimension keys otherwise was rejected: two writing styles means two code paths and chips that look different depending on how many values are selected.

### 4.3 Vocabulary

| Key | Values | `is:` shorthand |
|---|---|---|
| `triage` | `inbox`, `acked`, `all` (= `inbox,acked`); implicit `inbox` when absent | `is:inbox`, `is:acked` |
| `state` | `open`, `closed` (includes merged, as today), `merged` | `is:open`, `is:closed`, `is:merged` |
| `type` | `pr`, `issue` | `is:pr`, `is:issue` |
| `draft` | `true`, `false` | `is:draft` |
| `tracking` | `true`, `false` | `is:tracked`, `is:untracked` |
| `starred` | `true`, `false` | `is:starred` |
| `new` | `item`, `mention`, `comment`, `code`, `noise`, `any` | `is:new` = `new:any` |
| `repo` / `org` | `owner/name` / `owner` | |
| `author` / `assignee` | login, or `@me` | |
| `milestone`, `label` | name | |
| `no` | `assignee`, `label`, `milestone` | |
| `in` | `title`, `body` (narrows free text) | |
| `text` | a free-text term (the structured form of a bare word or quoted phrase) | |

`starred:` and `no:` are not current filters; they are included because they fall out of the model for free and were not objected to.

### 4.4 Activity: the `new:` dimension

Naming this dimension took several rounds. Rejected options and why:

- `status:new|new-activity|new-code|new-mention|noise`: "status" is too generic.
- `activity:new|comment|mention|code|noise`: `activity:new` reads as "there is new activity", not "this is a new item".
- `new:activity|...` with `triage:new` for new items: `triage:new` would mean something different from `new:*`, and mixes "never seen" into the inbox/acked axis.
- `unseen:`, `reason:` + `is:unread` (GitHub notifications vocabulary): `reason:` on GitHub means *why you are subscribed*, not *what changed*; reusing it would mislead the users who know it best.

The underlying problem is that the current status enum mixes two ideas: *have you ever opened this item* and *what changed since you last looked*. The requested wildcard ("catch all types of new activity") spans both, so any single-status key name clashes with one of them.

**Decision: `new:` computed as independent flags.**

- `new:item` (never viewed), `new:mention`, `new:comment`, `new:code`, `new:noise`, and the wildcard `new:any`. `is:new` is shorthand for `new:any`.
- Flags are independent, not a single priority-ordered status: an item with a new mention and new commits matches both `new:mention` and `new:code`. The card badge continues to show the highest-priority flag, so the display is unchanged.
- An unseen item counts all of its content as new: it matches `new:item` plus whatever it contains.
- `new:any` = item OR mention OR comment OR code. **Noise is never part of the wildcard**, so `-is:new` means "nothing worth looking at" (idle, or noise only). This only works cleanly with flags; under a single status, `-new:noise` would also drop items that have noise *and* real activity.
- `comment` covers comments, reviews and state changes (close/reopen), matching today's NEW_ACTIVITY.
- Acked items have no `new:` flags, because any activity that matters un-acks them.

### 4.5 Free text

Today the whole query is one substring that must appear in any of title, body, repo, author, milestone, labels or `#number`, so `flaky test` only matches that exact phrase. GitHub matches title, body and comments by default, ANDs separate words, and matches `"quoted phrases"` exactly.

**Decision:** follow GitHub, with title + body as the default.

- Separate words are ANDed; each is a case-insensitive substring match.
- `"quoted phrases"` must match exactly.
- A bare `#123` (or `123`) matches the item number.
- `in:title` / `in:body` narrow the fields. `in:comments` may come later; comment data exists but is costly to search.
- No implicit matching on repo, author, label or milestone; those are reached through qualifiers. This is a behaviour change for anyone who types a repo name into the search box today.

### 4.6 Triage scope

The Inbox / Activity / Acked / All tabs are currently a separate `triage` field, but they are filters on computed status (Inbox = not ACKED; Activity = not ACKED, IDLE or NOISE; Acked = ACKED). That overlaps with the activity filters, so triage becomes part of the query.

- **The backend adds `triage:inbox`** when the `Expr` contains no `triage` predicate anywhere in the tree. An empty query means "inbox". The same query therefore means the same thing in the dashboard, the API and saved searches.
- Including acked items requires an explicit `triage:acked`; `triage:all` expands to `triage:inbox,acked`.
- The "Activity" tab becomes inbox + `is:new`.
- A saved search that omits `triage:` runs within whichever triage tab is active.
- **Callers that need every item must send `triage:all`**: the extension background worker (both `GetItems({})` calls) and the DataBrowser. Without this the extension's notifications would quietly skip acked items.

An intermediate decision applied the implicit scope only in the dashboard UI, with an empty API query meaning "everything". It was reverted so that a query has one meaning everywhere.

### 4.7 Sort

Sort is **not** part of the query. It is a separate request field, and saved searches will store it as a separate field. Starred items continue to float to the top. Expressing sort as `sort:updated-desc` in the query was considered and rejected.

## 5. API

- `GetItems(Expr query, Sort sort)`. An invalid `Expr` returns `InvalidArgument` with a structured error (path into the tree, message). The unused `Filter` message is replaced.
- `GetFacets(Expr query, Field[] fields)`. "Facets" are the available values for a filter field, given the current results, with a count for each. For each requested field the response lists every known value with a count of items matching the query **with that field's own top-level predicates removed**. Without that exclusion, picking `repo:a` would shrink the repo dropdown to just `a`, and a second repo could never be added.
  - The default dropdown view shows values with count > 0; the existing "show all" toggle also shows values with count 0.
  - For the `triage` field, removing its own predicates means `triage:all`, not the implicit inbox; otherwise acked would always count 0.
  - Sidebar per-repo inbox counts = `GetFacets({}, [repo])`; the unread dot = `GetFacets(new:any, [repo])`.
- Later: `CountItems(Expr[] queries)` for saved-search badges.

Returning facets inside `GetItems` (one round trip) and splitting dropdown options from badge counts into separate RPCs were both considered; one facets RPC covers both uses.

## 6. Backend evaluation

- Load candidate items, compute the `new:` flags and status, and evaluate the tree in memory with one recursive Go function. This is the only approach that handles flags (which need comments and commits) and title/body text cleanly.
- **Translate the tree to SQL where possible**, as a prefilter on indexed columns (repo, state, type, author). The full tree is always re-evaluated in memory on the result, so SQL may return extra rows but never drops a real match, and correctness never depends on the SQL translation being exact. A subtree is pushed down only if it is entirely SQL-expressible; under `NOT` or `OR`, all children must be.

## 7. Frontend (Phase 0)

- Structured filter state becomes a list of `{field, values[], negated}` predicates, replacing `DashboardFilterState`'s single-value fields, and is sent directly as an `Expr`. No text serialization in Phase 0.
- URLs keep structured params (`repo=`, `author=`, ...), extended with repeated params for multiple values and a `-key=` prefix for negation. Existing links keep working. Switching to `?q=` happens in Phase 2, together with conversion of old links, once the TypeScript parser exists.
- `applyFilters` and the client-side `extractUnique*` helpers are removed in favour of `GetItems` / `GetFacets`.

### 7.1 Phase 2 input (for context)

Two designs keep the chips while allowing free-form editing:

1. **Tokenized input** (Gmail/Linear style): finished `key:value` tokens render as chips; the trailing text is editable; clicking a chip or backspacing into it turns it back into text; typing `key:` opens autocomplete. Closest to today's look.
2. **Highlighted overlay** (GitHub's search bar): a plain text input with a styled layer behind it drawing qualifiers as pills. Fully free-form and much simpler focus/cursor handling, but the chips are only visual.

Option 1 is preferred for familiarity; option 2 is the fallback if cursor handling proves too fiddly. This decision is deferred to Phase 2.

## 8. Testing

- Go: table-driven validator tests, and evaluation vectors (item fixtures + `Expr` -> expected item IDs) that double as a conformance suite for the engine.
- Go: SQL prefilter tests asserting that the prefilter result is a superset of the in-memory result for every vector.
- TypeScript (Phase 2): `parseQuery` / `formatQuery` round-trip tests and golden cases for the `is:` shorthand table.

## 9. Open items

- Exact proto representation of closed-value sets (enums vs. validated strings) in `Predicate.values`.
- Whether saved searches also keep the user's original text for display (Phase 3).
- `in:comments` support for free text.
