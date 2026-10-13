# Query Model Phase 2: Text Query Input, Parser/Formatter, `?q=` URLs

**Status:** Ready to implement after Phase 1.
**Overview:** [query_model_plan_overview.md](query_model_plan_overview.md) (ground rules, user decisions U1–U14, scope, module map, testing strategy).
**Parent design:** [query_model_design.md](query_model_design.md) (§4 query language, §7.1 input decision, §7.2 URL decision).

This document is self-contained for the agent implementing Phase 2. Read the [overview's ground rules](query_model_plan_overview.md#1-ground-rules-for-the-implementer) first.

---

## 1. Prerequisites

- **Phase 1 merged** ([query_model_phase1_multiselect.md](query_model_phase1_multiselect.md)). Phase 2 relies on:
  - the extracted components in `frontend/src/components/dashboard/` (`FilterToolbar`, `StateMenu`, `RepoOrgMenu`, `OverflowFilterMenu`, `TriageTitleMenu`, `SortMenu`, `DashboardSidebar`, `ActiveFilterChips`), the new `MultiSelectMenu` (which owns its `showAll` and builds options from raw facet values), and `useMenuGroup` (instantiated once in `Dashboard`);
  - `FilterControls` with array values (`repo`, `org`, `author`, `assignee`, `milestone`, `label`, `activity`) and the single-select `state` with `merged`;
  - `projectControls` returning **owner indices** and controls that edit only the predicate they display (Phase 1 P2). Phase 2 reuses the same algorithm over parsed clauses;
  - the Activity/New-tab rules and the **two tab entry points** (title menu = in-place tab switch; sidebar Workflow rows = reset text and sort to the tab alone), stated once in [Phase 1 §3.4](query_model_phase1_multiselect.md#34-activity-menu-and-the-new-tab-p4), and the org/repo rule (Phase 1 P3);
  - `Field.ASSIGNEE` and `Field.NEW` in `SELECTOR_FIELDS` (autocomplete reuses those facets);
  - the muted "NOT" marker style for negated chips ([Phase 1 §3.5](query_model_phase1_multiselect.md)).
- The throwaway prototype was recorded in git history by Phase 1 commit 1.0 and deleted in commit 1.1 (U2). Read it there (`git show <commit 1.0>:frontend/src/prototypes/queryInput/TokenizedInput.tsx`, likewise `useSuggestions.ts` and `parser.ts`) as a behavioural reference only (§11).
- User decisions that apply here: U1, U2, U4, U5, U7, U8, U9 ([overview](query_model_plan_overview.md#21-decided-by-the-user)).

## 2. Goals and non-goals

Goals:
- `parseQuery(text)` and `formatQuery(expr)` in TypeScript implementing parent §4.1–4.5, with source spans for every clause and every error.
- The **query text becomes the state of record** (P6). Everything else is derived.
- A tokenized chip input (U1) that replaces the search box and the Phase 1 chips row.
- Dropdowns, tabs and sidebar shortcuts keep working, as editors of clauses in the text (P7).
- `?q=` URLs (U5) with permanent reading of legacy parameters.
- Autocomplete for keys and values.

Non-goals: grouping/OR/NOT syntax; sort in text; `in:comments`; server-side parsing.

## 3. Syntax specification

Module: `frontend/src/logic/query/syntax/` (`scan.ts`, `parse.ts`, `format.ts`, `types.ts`, `index.ts`). Pure functions, no React.

### 3.1 Grammar

Offsets are UTF-16 code-unit indices into the text (JavaScript string indices). Whitespace is `/\s/`.

```
query      = ws* ( clause ( ws+ clause )* )? ws*
clause     = [ "-" ] body              ; "-" negates; a lone "-" is an incomplete clause
body       = qualifier | term
qualifier  = key ":" valuelist         ; key must be followed immediately by ":"
key        = [A-Za-z_]+                ; case-insensitive; must start the body (before any quote)
valuelist  = value ( "," value )*      ; commas are OR
value      = quoted | bare
bare       = 1*( any char except whitespace, "," and '"' )
quoted     = '"' *( qchar | escape ) '"'
qchar      = any char except '"' and "\"
escape     = "\" any-char             ; consumed as a pair; see the scanning rule
term       = quoted | word
word       = 1*( any char except whitespace and '"' )   ; may contain ":" and "," if it does not start with key ":"
```

Scanning rule for clause boundaries (this is what makes chips stable while typing): a clause runs from a non-whitespace character to the next whitespace character **that is outside a quoted string**. Outside quotes, a `"` opens a quoted string. **Inside quotes, the scanner consumes `\` together with the next character as one unit** (so `\\` is one escaped backslash and a following `"` closes the string; never decide by looking at the previous character only), and an unescaped `"` closes the string. `\"` means `"`, `\\` means `\`, and `\` followed by any other character `x` means the two characters `\x` literally (total and forgiving). An unterminated quote runs to the end of the text. Backslashes outside quotes are ordinary characters.

Interpretation of one clause:
1. Negation: the clause is negated if it starts with `-` and is longer than one character. A lone `-` is `incomplete`.
2. Qualifier: if the body (after `-`) matches `^[A-Za-z_]+:` the clause is a qualifier with that key (lower-cased). Otherwise it is a term.
3. Values: the text after `:` is split on commas outside quotes. Each part is a value. Quoted values are unescaped as above. A quoted value must be the whole part (`label:"a"b` is an error); a bare value must not contain `"`. A quoted empty value (`label:""`) is an `empty-value` clause, exactly like `label:a,,b` (the daemon rejects empty values).
4. Terms: a quoted term is a phrase (unescaped); a word is taken verbatim. A word containing `"` is an error ("Quotes must surround the whole term").

### 3.2 Keys and values

Keys come from one table (see §10, vocabulary consolidation). Closed sets mirror the `Field` enum comments in `query.proto`; keep them in sync by the existing convention (the proto is the source of truth; `backend/internal/query/vocabulary.go` `ClosedValues` is the Go mirror).

| Key | Field | Values |
|---|---|---|
| `triage` | `TRIAGE` | `inbox`, `acked`, `all` |
| `state` | `STATE` | `open`, `closed`, `merged` |
| `type` | `TYPE` | `pr`, `issue` |
| `draft` | `DRAFT` | `true`, `false` |
| `tracking` | `TRACKING` | `true`, `false` |
| `starred` | `STARRED` | `true`, `false` |
| `new` | `NEW` | `item`, `mention`, `comment`, `code`, `noise`, `any` |
| `repo` | `REPO` | open (`owner/name`) |
| `org` | `ORG` | open |
| `author` | `AUTHOR` | open (login, `@login`, or `@me`; one leading `@` is stripped except for `@me`) |
| `assignee` | `ASSIGNEE` | open (login, `@login`, or `@me`; one leading `@` is stripped except for `@me`) |
| `milestone` | `MILESTONE` | open |
| `label` | `LABEL` | open |
| `no` | `NO` | `assignee`, `label`, `milestone` |
| `in` | `IN` | `title`, `body` (must not be negated) |
| *(term)* | `TEXT` | one value per term |

Closed values are matched case-insensitively and **stored lower-cased** in the predicate. Open values are stored exactly as written (after unquoting); the daemon trims and case-folds. The one exception: for `author` and `assignee` the parser strips **one** leading `@` from every value other than `@me` (case-insensitive), so `author:@alice` and `author:alice` produce the same predicate `author:alice`; `formatValue` never writes `@` except for `@me`. (Users see `@alice` in the Author menu rows and will type it.)

### 3.3 `is:` shorthand

`is:` is syntax only; it never appears in the predicate list and the formatter never writes it.

| Shorthand | Expands to |
|---|---|
| `is:open` | `state:open` |
| `is:closed` | `state:closed` |
| `is:merged` | `state:merged` |
| `is:pr` | `type:pr` |
| `is:issue` | `type:issue` |
| `is:draft` | `draft:true` |
| `is:tracked` | `tracking:true` |
| `is:untracked` | `tracking:false` |
| `is:starred` | `starred:true` |
| `is:new` | `new:any` |
| `is:inbox` | `triage:inbox` |
| `is:acked` | `triage:acked` |

- `is:a,b` is valid when every value expands to the same field: `is:open,merged` → `state:open,merged`; `is:tracked,untracked` → `tracking:true,false`.
- Mixed dimensions (`is:open,pr`) are an error (`mixed-is`), as parent §4.2 requires.
- Negation carries over: `-is:draft` → `-draft:true`; `-is:new` → `-new:any`.
- Any other `is:` value (`is:locked`, `is:unmerged`) is an error listing the known values.

### 3.4 Validation and issue codes

Each clause gets a `status`: `ok`, `incomplete`, or `error`. Only `ok` clauses produce a predicate.

| Code | Status | Example | Span |
|---|---|---|---|
| `missing-value` | incomplete | `label:` | after the colon (zero-width at end) |
| `empty-value` | incomplete | `label:a,` / `label:a,,b` / `label:""` | the empty value position |
| `unterminated-quote` | incomplete | `label:"good first` | from the opening quote to the end |
| `lone-dash` | incomplete | `-` | the clause |
| `unknown-key` | error | `lable:bug` | the key |
| `invalid-value` | error | `state:opened` | each offending value (`ValueNode.invalid`) |
| `mixed-is` | error | `is:open,pr` | the values |
| `negated-in` | error | `-in:title` | the `-` |
| `bad-quote` | error | `label:"a"b`, `fla"ky` | the clause |
| `empty-term` | error | `""`, `-""` | the clause |

Messages are human-readable and name the allowed values for closed fields ("state must be open, closed or merged"). The `unknown-key` message suggests quoting: "*key* is not a filter. Quote it to search for the text: \"…\"". Any word of the shape `[A-Za-z_]+:…` is a qualifier, so free text such as a pasted URL (`https://github.com/…`) or `TODO:` becomes an `unknown-key` error (U9); the user guide documents the quoting workaround. `- "x"` (with a space) is two clauses: a `lone-dash` and a term. `triage:all` is `ok` with an informational note "= inbox,acked"; `#123`/`123` terms get the note "Also matches item number 123".

The parser does **not** check semantics owned by Go beyond the closed sets and `in` negation (e.g. it does not know whether a repo exists). Server validation still runs (§7).

### 3.5 Types and API

```ts
export interface Span { readonly start: number; readonly end: number } // [start, end)

export type ClauseStatus = 'ok' | 'incomplete' | 'error';
export type IssueCode = 'missing-value' | 'empty-value' | 'unterminated-quote' | 'lone-dash'
  | 'unknown-key' | 'invalid-value' | 'mixed-is' | 'negated-in' | 'bad-quote' | 'empty-term';

export interface QueryIssue extends Span { readonly code: IssueCode; readonly message: string }

export interface ValueNode extends Span {
  readonly text: string;      // unquoted, unescaped
  readonly quoted: boolean;
  readonly invalid: boolean;
}

export interface Clause extends Span {
  readonly raw: string;                   // text.slice(start, end)
  readonly negated: boolean;
  readonly kind: 'qualifier' | 'term';
  readonly key?: Span & { readonly text: string }; // text is the key lower-cased, e.g. 'is', 'label'; the original spelling is in raw
  readonly values: readonly ValueNode[];  // terms have exactly one
  readonly status: ClauseStatus;
  readonly predicate: FilterPredicate | null; // set iff status === 'ok'
  readonly issue?: QueryIssue;
  readonly note?: string;
}

export interface ParsedQuery {
  readonly text: string;
  readonly clauses: readonly Clause[];
  /** Predicates of the ok clauses, in text order. */
  readonly predicates: readonly FilterPredicate[];
  /** exprIndex -> clause index: predicates[i] came from clauses[clauseOfPredicate[i]]. */
  readonly clauseOfPredicate: readonly number[];
  readonly issues: readonly QueryIssue[];
}

export function parseQuery(text: string): ParsedQuery;
export function parseClause(raw: string): Clause;        // one clause at offset 0 (chips render with it)
export function formatPredicate(p: FilterPredicate): string;
export function formatPredicates(ps: readonly FilterPredicate[]): string;
export function formatQuery(expr: ExprInit | Expr | undefined): string; // throws QueryFormatError
export function canonicalQuery(text: string): string;    // formatPredicates(parseQuery(text).predicates)
export function segmentClause(clause: Clause): Segment[]; // for chip rendering (see §6.3)
```

`toExpr` in [`expr.ts`](../../frontend/src/logic/query/expr.ts) becomes `toExpr(parsed: ParsedQuery): ExprInit` = `andExpr(parsed.predicates)`. One predicate per ok clause, in text order, so a server `ExprError.path` of `and.exprs[i]…` maps to `clauses[clauseOfPredicate[i]]`.

### 3.6 Formatter

- `formatPredicate`: `(negated ? '-' : '') + key + ':' + values.map(formatValue).join(',')`, key from the vocabulary table. `TEXT` predicates: `(negated ? '-' : '') + formatTerm(value)`.
- Formatter domain: non-empty values only; `author`/`assignee` values never start with `@` except `@me` (the parser strips it, §3.2); a negated `in` predicate cannot occur (the parser flags it and the legacy reader drops it), and `formatQuery` throws `QueryFormatError` if given one.
- `formatValue(v)`: bare if `/^[^\s,"]+$/.test(v)`, otherwise `"` + `v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')` + `"`. Closed values are always bare.
- `formatTerm(v)`: bare if `/^[^\s"]+$/.test(v)` and `v` does not start with `-` and does not match `/^[A-Za-z_]+:/`; otherwise quoted as above.
- `formatPredicates`: predicates joined by single spaces, in order.
- `formatQuery(expr)`: accepts an unset `Expr`, an `Expr` with no kind, an empty `and`, a single predicate, or an `and` whose children are all predicates. Each `TEXT` predicate must have exactly one value. Anything else (`or`, `not`, nested `and`, multi-value `TEXT`) throws `QueryFormatError` with the offending path. Its only production caller is the legacy-URL converter (§8.2), which always passes a flat AND; saved searches are stored as text (U13), so no Expr ever comes back from the daemon to be formatted.

### 3.7 Round-trip properties (tests)

- **P-struct:** for every predicate list `L` in the formatter's domain, `parseQuery(formatPredicates(L)).predicates` deep-equals `L` with closed values lower-cased, and `issues` is empty.
- **P-canon:** for every text `t` with no issues, `c = canonicalQuery(t)` satisfies `parseQuery(c).predicates` deep-equals `parseQuery(t).predicates` and `canonicalQuery(c) === c` (idempotent).
- **P-spans:** for every text, `clauses` are ascending and non-overlapping, `text.slice(c.start, c.end) === c.raw`, every non-whitespace character lies in exactly one clause, and every issue span lies within its clause (zero-width allowed at the clause end).
- **P-edit:** every text edit operation (§5) leaves the text outside the edited clause and its separating whitespace byte-identical.

Text is **not** preserved by `canonicalQuery` (`is:open` becomes `state:open`, spacing collapses); chips preserve text because they render raw clauses, not canonical ones.

Generate cases with a small seeded PRNG in the test file (e.g. mulberry32, ~500 cases) over every field, with adversarial values: spaces, commas, quotes, backslashes, leading `-`, `key:`-looking text, `@me`, `#123`, non-ASCII, emoji (surrogate pairs). Plus golden tables for every `is:` row, every issue code, and the legacy-URL conversions (§8).

## 4. State model (P6)

```ts
// types/filters.ts
export interface DashboardQueryState {
  readonly text: string;   // the query text of record (written to ?q=)
  readonly sort: SortOption;
  readonly order: SortOrder;
  readonly item: string | null;
}
```

`predicates` and `q` are removed. `FilterControls.q` is removed. Derived values (memoised in `useDashboardFilters`):

```
text ──parseQuery──▶ ParsedQuery ──projectControls──▶ { controls, owners (clause indices), extras }
                         │
                         └──toExpr──▶ Expr (only ok clauses) ──▶ GetItems / GetFacets
```

`projectClauses(parsed)` (added in commit 2.3, next to the Phase 1 `projectControls`, which 2.4 then deletes) runs the Phase 1 algorithm over the ok clauses' predicates and returns **clause indices** in `owners`. The New tab is derived exactly as in Phase 1.

**Invariant:** `state.text` always has single-space separators between clauses and no leading or trailing whitespace (`toText(fromText(text)) === text`). Every writer of `state.text` maintains it: `parseDashboardUrl` normalises with `scan(text).map(c => c.raw).join(' ')` (§8.2), the input emits `toText(...)` (§6.1), and the splices in §5 keep single spaces.

### 4.1 `useDashboardFilters` API (rewritten)

```ts
export function useDashboardFilters(): {
  state: DashboardQueryState;
  parsed: ParsedQuery;
  controls: FilterControls;
  /** Text used for requests: debounced while typing, immediate for other edits. */
  requestText: string;
  setText(text: string, kind: 'typing' | 'edit'): void;  // typing -> replaceState + 200 ms debounce
  setControl<K extends ControlKey>(key: K, value: FilterControls[K]): void; // splices text, pushState
  setTriageTab(tab: TriageFilter): void;
  setSort(sort: SortOption): void;
  setOrder(order: SortOrder): void;
  selectItem(id: string | null): void;
  applyWorkflowShortcut(tab: TriageFilter): void; // text -> '' / 'new:any' / 'triage:acked' / 'triage:all'; sort, order default; item cleared
  toggleRepo(repo: string): void;
  clearQuery(): void;                              // text -> ''; sort, order, item unchanged (U8)
  isDefault: boolean;
  activeCount: number;                              // clauses + non-default sort
};
```

`requestText` replaces the current `useDebouncedValue(query.q, SEARCH_DEBOUNCE_MS)` in `useDashboardData`. The state keeps the kind of the last edit, and every entry point has a fixed kind:

| Entry point | Kind | History |
|---|---|---|
| Keystrokes, paste, cut in the input; draft commits by space, Enter, Escape or blur | `typing` | `replaceState` |
| Dropdown/control edits, title-menu tab switch, sidebar Workflow rows, sidebar repo rows, saved-search open (Phase 3), chip ×, clear button, undo/redo in the input | `edit` | `pushState` |
| Initial load, `popstate` | `edit` | none (URL already current; legacy URLs rewritten with `replaceState`, §8.2) |

The request text is derived by one effect keyed on `(text, kind)`, so a dropdown click arriving while a typing debounce is pending is applied immediately and the stale timer cannot overwrite it:

```ts
useEffect(() => {
  if (kind === 'edit') { setRequestText(text); return; }
  const t = setTimeout(() => setRequestText(text), SEARCH_DEBOUNCE_MS);
  return () => clearTimeout(t);
}, [text, kind]);
```

All text-editing setters (`setControl`, `setTriageTab`, `toggleRepo`, `clearQuery`, and Phase 3's saved-search open) compute from the **latest** state inside the updater: `setState(prev => ({ ...prev, text: setControlInText(prev.text, parseQuery(prev.text), key, value), kind: 'edit' }))`. Owners and spans are never taken from render scope: a pointer-down on a dropdown first blurs the input (committing the draft) and then clicks, which are two state updates in one tick.

`openSavedSearch` is not part of Phase 2; Phase 3 adds it ([Phase 3 §7](query_model_phase3_saved_searches.md#7-opening-a-saved-search-and-the-triage-tabs-p16)).

## 5. Keeping input, dropdowns and tabs in sync (P7)

Module: `frontend/src/logic/query/textEdit.ts` (pure). Every non-typing edit is one of three splices on the text:

| Operation | Effect |
|---|---|
| `replaceClause(text, clause, raw)` | `text.slice(0, clause.start) + raw + text.slice(clause.end)` |
| `removeClause(text, clause)` | removes the clause and **one** adjacent whitespace run (the following one; the preceding one if the clause is last), so no double spaces remain |
| `insertClause(text, parsed, raw, rank)` | inserts before the first ok qualifier clause whose rank (`rankOf`) is greater than `rank`; free-text terms rank after every qualifier; a single space separates; empty text becomes `raw` |

Built on these:
- `setControlInText(text, parsed, key, value)`: computes `projectClauses(parsed)` itself; the control's displayed clause (by `owners[key]`) is replaced with `formatPredicate(next)`, removed when `next` is empty, or a new clause is inserted at its canonical rank. Preserves Phase 1's control rules: P3 (`org`/`repo` mutual exclusion: selecting a non-empty `org` removes `owners.repo`, and vice versa), P4 (`activity` `any` vs specific flags), and P19 (`assignedToMe` toggle on `owners.assignee`). This is the Phase 2 `setControl`.
- `setTriageTabInText`: follows the same rules as Phase 1 `setTriageTab` ([Phase 1 §3.4](query_model_phase1_multiselect.md#34-activity-menu-and-the-new-tab-p4)): removes every clause whose predicate is `triage` (negated ones included, the explicit exception to P2). When switching to **New** (`activity`), replaces the `activity` control's owned clause (whatever `new:` values it holds, or inserts at rank 0 if none) with `new:any`. When switching to **Inbox / Acked / All**, removes the `activity` clause *only if it is `new:any`*, and for Acked/All inserts `triage:acked` / `triage:all` at rank 0.
- `toggleRepoInText`: the Phase 1 `toggleRepo` rules ([Phase 1 §3.6](query_model_phase1_multiselect.md)) applied to the repo/org clauses. There is no text version of `clearSecondary`: the clear button empties the text (§5.3), and `clearSecondary`, `clearSecondaryFilters` and the chips row's "Clear filters" button are deleted in commit 2.6.
- **Multi-clause splice ordering:** whenever a single operation touches more than one clause (`setTriageTabInText`, `toggleRepoInText`, or `org`/`repo` mutual exclusion), either remove clauses in **reverse span order** (highest `start` first) or re-run `parseQuery` between single-clause splices so character offsets never go stale.

Consequences the implementer must preserve:
- A dropdown change rewrites **only** its clause: `is:open label:"good first issue" flaky` + tick `bug` in Label → `is:open label:"good first issue",bug flaky`. `is:open` is not canonicalised. The edited clause itself is reformatted from its new predicate (`label:"Bug"` + tick `ui` → `label:Bug,ui`).
- A clause written with `is:` is a normal predicate for projection: `is:open` displays as State = Open; choosing "Closed" in the State menu replaces it with `state:closed`.
- Error and incomplete clauses are invisible to controls (they have no predicate) and are never touched by control edits.
- `owners` are clause indices into the **current** parse; recompute after every edit, inside the state updater (§4.1).

### 5.1 Triage tabs in text

Triage tabs are now visible as chips: the New tab is a `new:any` chip and the Acked tab is a `triage:acked` chip. The two entry points keep their Phase 1 meaning ([Phase 1 §3.4](query_model_phase1_multiselect.md#34-activity-menu-and-the-new-tab-p4)): the **title menu** edits those chips in place (`setTriageTabInText`); the **sidebar Workflow rows** reset the query to the tab alone (`applyWorkflowShortcut`: text `''` / `new:any` / `triage:acked` / `triage:all`, sort and order back to defaults, selected item cleared, `pushState`). The title ("Inbox"/"New"/"Acked"/"All Items") is derived as in Phase 1.

### 5.2 Free text

Bare words and quoted phrases are clauses like any other; there is no separate search field. They render as plain text inside the input (not pills).

### 5.3 Clearing

The input's clear (×) button sets the text to `''`, including tab chips such as `triage:acked` and `new:any` (U8); sort, order and the selected item are unchanged. It is the only clear control (the Phase 1 "Clear filters" button and `clearSecondary` are removed). It is undoable with Ctrl/Cmd+Z while the input has focus (§6.5). Browser Back also restores the previous URL.

### 5.4 `@me`

The author menu's "you" row writes `author:@me` from Phase 2 on (structured URLs are no longer written, so the legacy `author=@me` quirk does not apply). The row is ticked when the author clause contains `@me` or the current login.

## 6. Tokenized input (U1)

Files:
- `frontend/src/logic/query/editor.ts`: pure editor state and transitions (no DOM), unit-tested exhaustively.
- `frontend/src/components/query/QueryInput.tsx`: the component.
- `frontend/src/components/query/QueryChip.tsx`: one clause rendered with segments.
- `frontend/src/components/query/SuggestionList.tsx`: the autocomplete listbox.
- `frontend/src/hooks/useQuerySuggestions.ts`: suggestion state (§6.7).

Use the prototype (`frontend/src/prototypes/queryInput/TokenizedInput.tsx`, `useSuggestions.ts`, `parser.ts`, read from git history at Phase 1 commit 1.0, §11) as a behavioural reference only. Do not copy its parser (it uses string field names and has no escapes, spans for issues or `Field` enums).

### 6.1 Editor model

```ts
export interface EditorState {
  readonly chips: readonly string[]; // raw clause text, exactly as typed
  readonly index: number;            // draft position: rendered before chips[index]
  readonly draft: string;            // the one editable clause (may be empty)
  readonly caret: number;            // caret offset within draft
  readonly allSelected: boolean;     // select-all mode (§6.4)
}
export const toText = (s: EditorState): string; // chips with the trimmed draft at index, joined by ' '
```

Transitions (pure functions returning a new state):
- `fromText(text)`: `chips = scan(text)` raws, `index = chips.length`, `draft = ''`.
- `edit(state, draft, caret)`: after any change to the draft, **normalise**: clauses entirely before the caret become chips before `index`, clauses entirely after it become chips after `index`, and only the clause under the caret stays in the draft. This is what makes a space (outside quotes) finish a token and what turns a pasted query into chips, while a comma does **not** finish a token (it is part of the value list), and a space inside quotes does not either.
- `commitDraft(state)`: the whole draft becomes chips at `index`; draft empty.
- `openChip(state, i, caret | 'end')`: commits the current draft first (an unfinished draft is never lost when a chip is opened), then removes chip `i` and makes its raw text the draft.
- `removeChip(state, i)`.
- `moveDraftToEnd(state)`.

Text of record: `toText(state)`. Whitespace between clauses is normalised to single spaces; the raw text of each clause is preserved exactly.

Controlled component contract: `QueryInput` receives `value` (the text of record, which always satisfies the §4 invariant, so `toText(fromText(value)) === value` from the first render) and calls `onChange(text, kind)`. It keeps `EditorState` locally. **The external value always wins:** whenever `value` changes and differs from `toText(local)` (a dropdown edit, a sidebar click, Back/Forward), it re-initialises with `fromText(value)` and resets the undo history (§6.5), even while focused and even if a draft was open. The only concession to focus: if the input is focused, it keeps focus and puts the caret in an empty draft at the end. (Keeping the old draft would make the next keystroke emit the old text and silently undo the navigation.) In practice a pointer-down on a dropdown blurs the input first, so the draft has already been committed.

### 6.2 Keyboard

| Key | Condition | Behaviour |
|---|---|---|
| printable / paste | | edits the draft, then normalises (§6.1); newlines in pasted text become spaces |
| `,` | | a literal comma: adds a value to the current qualifier |
| Space | outside quotes | finishes the token (via normalisation) |
| Enter | suggestions open | accept the suggestion; accepting a **value** also finishes the token |
| Enter | otherwise | `commitDraft`; caret to the trailing draft |
| Tab | suggestions open | accept without finishing (so `,` can follow) |
| Tab | otherwise | default focus movement; blur commits the draft |
| Backspace / ArrowLeft | caret at draft start, collapsed, chip before | `openChip(index - 1, 'end')` (turns the chip back into text; does not delete a character) |
| Delete / ArrowRight | caret at draft end, collapsed, chip after | `openChip(index, 0)` |
| Home | chips before the draft | `openChip(0, 0)` |
| End | chips after the draft | `commitDraft` + `moveDraftToEnd` |
| ArrowDown / ArrowUp | | open / move within suggestions |
| Escape | suggestions open | close suggestions |
| Escape | otherwise | `commitDraft`, keep focus |
| Ctrl/Cmd+A | | select-all (§6.4) |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y | | undo / redo (§6.5) |
| `/` | focus is not in a text field | `preventDefault()` (Firefox quick-find) and focus the query input (added to [`useKeyboardNavigation.ts`](../../frontend/src/hooks/useKeyboardNavigation.ts), which already returns early when an input is focused, and to the shortcuts modal) |

Modifier combinations other than those listed fall through to the browser. Shift+Arrow selection is limited to the draft (no cross-chip selection); select-all covers the common "select everything" case.

### 6.3 Chips and click-to-caret

- Each chip renders its **exact raw text**, split into segments by `segmentClause` (`neg`, `key`, `colon`, `value`, `badvalue`, `badkey`, `comma`, `text`). Every segment span carries `data-off={segment.start}`.
- Pointer-down on a chip calls `preventDefault()` (so the input does not blur), maps the pointer to a character offset with `document.caretPositionFromPoint` (Firefox, Chrome 128+) or `document.caretRangeFromPoint` (Safari, older Chrome), adds the segment's `data-off`, and calls `openChip(i, offset)`. If neither API returns a text node inside the chip, the caret goes to the end of the chip. jsdom implements neither API: tests stub `document.caretPositionFromPoint` to return the **real rendered** segment text node (so `parentElement.dataset.off` is exercised) and also test the fallback; jsdom does not move focus on mousedown, so tests assert `event.defaultPrevented` rather than an absent blur (real-browser behaviour is a manual check). This only works because chips show raw text; never render a canonical or prettified form.
- Styles: see the chip style table below. Terms render as plain text with a hover background (negated terms get the same minus marker as negated qualifiers; error terms get the error style).

Chip style table (U9: error and negated chips must be distinguishable, and **neither uses strikethrough**; the prototype struck through illegal values, which read like negation):

| Chip | Container classes | Leading marker | Offending part | Attributes | Tooltip / announcement |
|---|---|---|---|---|---|
| ok qualifier | `rounded-full bg-blue-50 border border-blue-200 text-blue-800 dark:bg-blue-950/60 dark:border-blue-700/50 dark:text-blue-300` | none | none | `data-status="ok"` | none |
| **negated** ok qualifier | same as ok (normal chip colours) | the typed `-` rendered as a muted marker: `rounded bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300 font-semibold px-1 mr-0.5` | none | `data-status="ok" data-negated="true"`, `aria-description="Excludes items matching <key>:<values>"` | none |
| **error** | `rounded-full bg-red-50 border border-red-500 text-red-800 dark:bg-red-950/50 dark:border-red-500/70 dark:text-red-200` | lucide `AlertTriangle` (12 px, `text-red-600`, `aria-hidden`, `data-testid="chip-error-icon"`) before the text | bad key/value segment: `font-semibold underline decoration-dotted decoration-red-500 underline-offset-2` | `data-status="error" aria-invalid="true"`, `aria-description="Error: <message>"` | `title` = message; the live region announces the message when the error first appears |
| incomplete (after blur, e.g. `label:`) | `rounded-full border border-dashed border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200` | none | none | `data-status="incomplete"`, `aria-description="Incomplete: <message>"` | `title` = message |

- A negated clause with an error (`-lable:x`) uses the error style; the minus marker keeps its muted style inside it.
- The minus marker is the real `-` character (one code unit, inside the `neg` segment with `data-off`), so click-to-caret offsets stay exact. Phase 1's chips row shows the word "NOT" in the same muted badge ([Phase 1 §3.5](query_model_phase1_multiselect.md)) because those chips do not show raw text.
- No chip style uses `line-through` (asserted in tests, §13 commit 2.5).
- Qualifier chips have a remove × (`tabIndex={-1}`, pointer-down prevented) that calls `removeChip`.
- Pointer-down on empty space inside the box commits the draft and moves it to the end.

### 6.4 Selection and clipboard

Native selection cannot span chips, so:
- **Select-all:** the first Ctrl/Cmd+A selects the draft text natively if the draft is non-empty and not already fully selected. Otherwise it enters `allSelected` mode: every chip gets the selected style via `data-selected="true"` (chips have no ARIA role, so `aria-selected` would be invalid) and the live region announces "All selected". In this mode Backspace/Delete clears the query, a printable key replaces the query with that character, paste replaces the query, and Escape, arrows or a click leave the mode.
- **Copy/cut:** an `onCopy`/`onCut` handler on the container writes `toText(state)` to `clipboardData` (`text/plain`) when in `allSelected` mode; cut then clears. Within the draft the browser's native copy applies.
- **Paste:** handled by the draft's change event plus normalisation; in `allSelected` mode paste replaces everything.

### 6.5 Undo/redo

The draft's value is controlled by React, so native undo is unreliable; intercept Ctrl/Cmd+Z (always `preventDefault`) and keep an explicit stack in the component:
- Snapshots of `EditorState`. A snapshot is pushed before every transition except consecutive character edits within the same draft, which are coalesced until a token boundary, a caret jump, or 500 ms without typing.
- Redo stack cleared on any new edit. Limit 100 entries.
- External value changes (§6.1) reset both stacks. Navigation history is the browser's job (Back/Forward).
- Undo/redo call `onChange(toText(state), 'edit')`.

### 6.6 IME and accessibility

- **IME:** between `compositionstart` and `compositionend` do not normalise, do not treat Space/Enter as token boundaries, and ignore `keydown` with `event.nativeEvent.isComposing` (or `keyCode === 229`). Normalise once on `compositionend`.
- **Combobox:** the draft `<input>` has `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls` (the listbox id) and `aria-activedescendant` (active option). Options are `role="option"` in a `role="listbox"`.
- **Labels:** the container is `role="group"` with `aria-label="Query"`. The input has `aria-describedby` pointing at a visually hidden element containing "Current query: <text>" and the issue summary.
- **Live region:** a polite `aria-live` region announces "Added label:bug", "Editing label:bug", "Removed label:bug", "Query cleared" and newly appearing issues ("lable is not a known filter").
- Chips are not in the tab order; keyboard users reach them with Backspace/arrows (§6.2). The Phase 1 menus remain a fully keyboard-accessible alternative for every field they cover.

### 6.7 Autocomplete (`useQuerySuggestions`)

- **Key context** (caret in a clause with no `key:` yet): keys from the vocabulary table with a one-line description, plus `is:` shorthands once at least two characters are typed. On an empty draft only after ArrowDown.
- **Value context** (caret after `key:` or after a comma): closed fields offer their closed values (for `is:` the shorthand values, with the expansion as detail). Open fields offer facet values: `repo`, `org`, `author`, `assignee`, `milestone`, `label` all come from the selector `GetFacets` response already fetched by `useDashboardData` (Phase 1 added `ASSIGNEE` to `SELECTOR_FIELDS`; own-field excluded, so the list is relevant). `author`/`assignee` also offer `@me`.
- Ranking: prefix matches before substring matches, then alphabetical; values already in the clause are excluded; at most 8 items. Inserted text uses `formatValue` (quotes as needed). The list hides when the only item equals what is typed.
- Suggestion state is keyed by `(draft, caret)` so it resets whenever either changes (prototype behaviour).

## 7. Error reporting

Two sources, one presentation:
1. **Parse issues** (`parsed.issues`): the clause is excluded from the `Expr` (P9) and its chip gets the **error** or **incomplete** style from the chip style table in §6.3 (red border and tint, warning icon, `aria-invalid`, message as tooltip and live-region announcement; never strikethrough). Unknown keys are errors (U9).
2. **Server `ExprError`** (`exprErrorOf` in [`api/errors.ts`](../../frontend/src/api/errors.ts)): parse `path` with `/^and\.exprs\[(\d+)\]/`; map index `i` to `clauses[parsed.clauseOfPredicate[i]]` and give that chip the same error style with the server message. A root-level or unmatched path is shown only in the summary line.

Negated clauses are never errors because of their negation (except `-in:`, which is `negated-in`); they keep the negated style, which differs from the error style in colour (blue vs. red), icon (none vs. warning), marker (muted minus) and ARIA (`aria-description="Excludes…"` vs. `aria-invalid="true"` + `"Error: …"`).

Below the input, a single muted line summarises: "1 part of the query is ignored: lable is not a known filter" (first issue; count if more), prefixed by the same `AlertTriangle` icon. While the input is focused, the clause under the caret (the draft) is excluded from the summary line and the live region, so typing `label:` does not flicker an error; it is excluded from the `Expr` anyway. The existing "invalid query" inline report in `Dashboard.tsx` is replaced by this line. Invalid-query responses must still never show the "Disconnected" banner (existing `isConnectivityError` rule).

## 8. URL scheme (U5)

### 8.1 Decision and reasons

After Phase 2 the dashboard writes `?q=<text>[&sort=…][&order=…][&item=…]`. The original plan to move to `?q=` dated from when query strings were going to the backend; it was re-evaluated with the structured wire format and kept because:
- `?q=` can carry everything the parser can express (including OR across fields, grouping and NOT if they are added later); structured parameters cannot.
- It preserves the user's exact text, which option 1 chips need because they display raw text.
- URLs become readable and can be pasted to and from GitHub-style queries.

The dashboard keeps **reading** legacy structured parameters indefinitely so old bookmarks, notification links and shared links keep working. It never writes both forms: a single written form avoids two sources of truth.

### 8.2 Reading

`parseDashboardUrl(search): { state: DashboardQueryState; canonicalSearch: string }`

1. `legacy = parseLegacyParams(params)`: today's `parseQueryParams` predicate logic, unchanged, ignoring `q`, `sort`, `order`, `item` (grouping per field and sign, `-key=` negation, `triage=activity` → `new:any`, `assigned=me` → `assignee:@me`, `triage=inbox` dropped, `org` dropped when `repo` is present, `author=@x` → `x`, `tracking=tracked|untracked` → `true|false`, invalid values and unknown keys dropped).
2. `q = params.get('q') ?? ''`.
3. `joined = [formatPredicates(legacy), q].join(' ')` (legacy predicates first, then `q`, ANDed by juxtaposition), then `text = scan(joined).map(c => c.raw).join(' ')`: clause whitespace is normalised (runs of spaces collapse, ends trimmed), establishing the §4 invariant. `?q=is:open%20%20%20label:bug` therefore loads as `is:open label:bug` and the URL is rewritten.
4. `sort`, `order`, `item` as today.
5. `canonicalSearch = serializeDashboardUrl(state)`.

On initial load and on `popstate`, if `'?' + canonicalSearch` (or `''`) differs from `location.search`, call `history.replaceState` with the canonical URL (same path and hash). This converts legacy links in place and also normalises hand-written `?q=` URLs (e.g. drops unknown parameters, as today's serializer already does).

Examples (golden tests):

| Legacy URL | Rewritten |
|---|---|
| `?repo=a/b&author=x&triage=acked&state=closed&label=bug` | `?q=repo:a/b+author:x+triage:acked+state:closed+label:bug` |
| `?triage=activity&repo=k/k` | `?q=new:any+repo:k/k` |
| `?assigned=me&-label=bug&label=a&label=b` | `?q=assignee:@me+-label:bug+label:a,b` |
| `?tracking=untracked&q=flaky+test` | `?q=tracking:false+flaky+test` |
| `?label=good%20first%20issue` | `?q=label:%22good+first+issue%22` |
| `?triage=inbox&sort=created&item=k/k%2312` | `?sort=created&item=k/k%2312` |
| `?q=is:open+++label:bug` | `?q=is:open+label:bug` |

### 8.3 Writing

`serializeDashboardUrl(state)`: `q` (when `text.trim()` is non-empty), then `sort` and `order` when non-default, then `item`. Build with `URLSearchParams`, then un-escape `%2F`, `%3A`, `%40` and `%2C` (all legal in a query string per RFC 3986) so `?q=repo:kubernetes/kubernetes+label:bug,flake` stays readable. Spaces are `+`. Typing uses `replaceState` (as the search box does today); every other edit uses `pushState`.

### 8.4 Compatibility note (accepted behaviour change)

`q=` already exists as plain free-text search. Bare words still parse as text terms, so `?q=flaky` behaves the same. But an old `q=` value containing qualifier-like text (`repo:x`) or a leading `-` (`-wip`) is now read as syntax (a qualifier, or a negated term). An old value with an unterminated quote is now an incomplete clause and is ignored rather than treated as a phrase. This is accepted; such links were rare and the new reading is arguably what the user meant.

### 8.5 What happens to `urlCodec.ts` and its tests

- `parseQueryParams` moves to a new `frontend/src/logic/query/legacyUrl.ts` as `parseLegacyParams(params): FilterPredicate[]`. All of its current tests in [`urlCodec.test.ts`](../../frontend/src/logic/query/__tests__/urlCodec.test.ts) (`describe('parseQueryParams')`) move to `legacyUrl.test.ts` and assert predicates; the `q`/`sort`/`order`/`item` assertions move to the new reader tests.
- `serializeQueryParams` is deleted, and so are its round-trip tests (`serialize(parse(s)) === s` for structured URLs): nothing writes structured URLs any more.
- `urlCodec.ts` keeps its name and now exports `parseDashboardUrl` and `serializeDashboardUrl`. New tests: the legacy conversion golden table (every legacy key and sign, legacy + `q` combination); exact round trip `serializeDashboardUrl(parseDashboardUrl(s).state) === s` for canonical `?q=` URLs; idempotence of normalisation for arbitrary inputs.
- `requestKey` in `useDashboardData` switches to `formatPredicates(parseQuery(requestText).predicates)` plus sort and order, so editing only an error clause (which does not change the request) does not advance `settledKey` and reset scroll anchoring.
- [`textTerms.ts`](../../frontend/src/logic/query/textTerms.ts) and its tests are deleted; equivalent cases (words, phrases, `#123`) move to the parser tests, with the unterminated-quote case updated to the new behaviour.
- The extension and daemon only generate `?item=` deep links, which are unaffected. Verify that `Notification.url` in the daemon still only uses `item`.

## 9. Layout (U7)

- The query input moves out of the top nav (`Dashboard.tsx` lines ~568–578) into the list header, directly under the title row, at the full width of the header column (`max-w-4xl`). It wraps onto more lines as chips are added. The nav keeps the logo and sync status.
- The Phase 1 chips row (`ActiveFilterChips`) is deleted: the chips are in the input. The menus' trigger buttons keep the active (blue) style they have had since Phase 1, so a field with a selection is still visible at a glance.
- Placeholder: "Filter or search, e.g. is:open label:bug".
- The pin button (Phase 3) sits at the right end of the input row, outside the input box.

## 10. Vocabulary consolidation

Before the parser, merge the field metadata into one table in [`vocabulary.ts`](../../frontend/src/logic/query/vocabulary.ts):

```ts
export interface FieldSpec {
  readonly field: Field;
  readonly key: string;                       // text key and legacy URL key
  readonly rank: number;                      // canonical insert position
  readonly label: string;                     // human label (menus, chips, a11y)
  readonly description: string;               // autocomplete detail
  readonly closed?: readonly string[];        // closed values (lower-case, proto order)
  readonly legacyDecode?: (raw: string) => string | null; // legacy URL quirks (tracking, author '@')
  readonly negatable: boolean;                // false for 'in'
}
export const FIELD_SPECS: readonly FieldSpec[];
export const IS_SHORTHAND: Readonly<Record<string, { field: Field; value: string }>>;
```

`URL_FIELDS`/`UrlFieldSpec` are replaced by `FIELD_SPECS`; `legacyUrl.ts`, the parser, the formatter, chips and suggestions all read it.

## 11. The prototype: reference in git history (U2)

The throwaway prototype (`frontend/prototype/query-input.html`, `frontend/src/prototypes/queryInput/`) was recorded by Phase 1 commit 1.0 (`chore(frontend): record the throwaway query input prototype`) and deleted by commit 1.1. Read it from git history (`git show <1.0>:frontend/src/prototypes/queryInput/TokenizedInput.tsx`, and likewise `useSuggestions.ts`, `parser.ts`, `TokenizedInput.test.tsx`) for interaction behaviour only. Never restore it into the tree or import from it.

Lessons from the prototype that this design addresses (also recorded in parent §7.1):
- A comma adds another value (`key:a,b` is OR) instead of finishing a token; space and Enter finish a token; quoted values may contain spaces (§6.1, §6.2).
- Click-to-caret inside a chip relies on `caretPositionFromPoint`/`caretRangeFromPoint` and on chips rendering their exact raw text, so chips show what the user typed, not a canonical form (§6.3).
- Native select-all, copy across chips and Ctrl+Z do not work with chips and need explicit handling: a custom undo stack and a copy handler that serializes the whole query (§6.4, §6.5).
- Opening a chip while the draft holds unfinished text commits the draft (§6.1 `openChip`).
- Keyboard (Backspace into a chip, arrows, Home/End, Delete), IME and screen-reader accessibility need explicit design and tests (§6.2, §6.6).
- The prototype struck through illegal values, which reads like negation; error and negated chips must look different and neither uses strikethrough (§6.3, U9).

---

## 12. Decisions made for this phase (reviewable)

User decisions (U*) are listed in the [overview](query_model_plan_overview.md#21-decided-by-the-user). Phase 2 owns these plan decisions:

| # | Decision | Short reason | Where |
|---|---|---|---|
| P6 | The state of record is the **query text**; predicates, `Expr`, control projections and chips are derived from it. | Option 1 chips and `?q=` both need the exact text; one source of truth. | §4 |
| P7 | Dropdowns, triage tabs and sidebar shortcuts edit the text by **splicing clauses** (replace/remove/insert one clause by source span), never by reformatting the whole query. The preserved unit is the clause: whitespace between clauses is not part of the preserved text, and the input collapses it to single spaces. | Preserves the user's text for every clause they didn't touch. | §5 |
| P9 | Clauses with errors (or still incomplete) are **left out of the request** and highlighted; the rest of the query still runs. | The list keeps updating while the user types; nothing is silently reinterpreted. | §7 |
| P10 | Quoted values support `\"` and `\\` escapes. | Label and milestone names may contain quotes; the formatter must be total over real values. | §3 |

---

## 13. Commit plan

Each commit must leave `./verify.sh` green (never `--force`). Commit subjects follow Conventional Commits with no backticks.

**2.1 `refactor(frontend): consolidate the query vocabulary into one field table`**
- Files: `logic/query/vocabulary.ts` (`FIELD_SPECS`, `IS_SHORTHAND`), `logic/query/urlCodec.ts`, `logic/query/predicates.ts`, chips.
- Tests: existing tests pass unchanged; add a test that `FIELD_SPECS` closed sets equal the values documented in `query.proto` (hard-coded expectation table, so a proto change forces an update).
- AC: no behaviour change.

**2.2 `feat(frontend): add a query text parser and formatter`**
- Files: `logic/query/syntax/{scan,parse,format,types,index}.ts`.
- Tests: `syntax/__tests__/parse.test.ts` (grammar cases, every issue code with exact spans, escapes including a value ending in `\` (`label:"a b\\"` round-trips) and `\x` kept literally, `label:""` is `empty-value`, `author:@alice` and `author:alice` give the same predicate while `author:@me` keeps `@me`, surrogate pairs), `format.test.ts` (quoting rules, `QueryFormatError` paths), `roundTrip.test.ts` (P-struct, P-canon, P-spans with a seeded generator), `isShorthand.test.ts` (golden table §3.3).
- AC: not wired into the UI.

**2.3 `feat(frontend): add clause-level query text edits`**
- Files: `logic/query/textEdit.ts`, `logic/query/predicates.ts` (add a **new** `projectClauses(parsed): Projection` returning clause owners; the Phase 1 `projectControls(state)` stays unchanged until 2.4b, so `useDashboardFilters` and `predicates.test.ts` keep compiling).
- Tests: `textEdit.test.ts`: replace/remove/insert; whitespace handling at start/middle/end; canonical insert positions; `is:open` replaced by the State control; error clauses untouched; `setTriageTabInText` removes `-triage:acked` and replaces `new:mention,code` on New tab switch; P-edit property over generated texts. `predicates.test.ts`: `projectClauses` agrees with `projectControls` on equivalent inputs.
- AC: not wired into the UI.

Commit 2.4 is split in two so each half is reviewable and green.

**2.4a `feat(dashboard): keep the query as text and write it to the q URL parameter`**
- Files: `types/filters.ts` (`DashboardQueryState.text`, `FilterControls.q` removed), `logic/query/legacyUrl.ts` (new), `logic/query/urlCodec.ts` (rewritten), `logic/query/expr.ts` (`toExpr(parsed)`), `logic/query/predicates.ts` (state-level helpers `isDefaultQuery`, `activeQueryCount`, `workflowState` retargeted to text; the predicate-list editors `setControl`, `setTriageTab`, `toggleRepo`, `removePredicate`, `clearSecondary` become unused here and are deleted in 2.4b), delete `logic/query/textTerms.ts` and its test, `hooks/useDashboardFilters.ts` (§4.1: edit kinds, debounce effect, updater-based setters; keep temporary chip removal/clear wiring for `ActiveFilterChips` until 2.6 deletes it), `hooks/useDashboardData.ts` (`requestText`, `requestKey`), `Dashboard.tsx` and `components/dashboard/*` (controls call the text edits; the existing nav `<input>` now edits the whole text as plain text; the chips row renders from `projectClauses`), error summary line (§7), and the tests that operate on the removed `predicates`/`q` state: `__tests__/expr.test.ts`, `__tests__/predicates.test.ts` (state-level cases), `__tests__/urlCodec.test.ts`, `hooks/__tests__/useDashboardFilters.test.ts`.
- Tests: `legacyUrl.test.ts` (moved cases), `urlCodec.test.ts` (golden conversion table §8.2 including whitespace normalisation, canonical round trip, idempotence), `useDashboardFilters.test.ts` (legacy URL rewritten with `replaceState` on load and on popstate; typing uses `replaceState`, control edits `pushState`; debounce only for typing; **race**: type, then make a dropdown edit within 200 ms → the request uses the dropdown edit immediately and the pending debounce never overwrites it; **stale splice**: type `label:bu` without committing, click a State option → the request is `state:closed` plus the committed draft), RPC tests updated: URL assertions become `?q=…`; for every control edit the written `location.search` contains none of the legacy keys (`repo`, `org`, `author`, `assignee`, `assigned`, `label`, `milestone`, `state`, `type`, `tracking`, `triage`, `new`, or any `-key`); legacy example URL still sends the same structured query; `?q=flaky` still sends one TEXT predicate; an invalid clause is excluded from the request and reported; a server `ExprError` path maps to the right clause; editing only an error clause does not reset scroll anchoring.
- AC: every existing behaviour reachable; URLs written only as `?q=`; old links work.

**2.4b `refactor(frontend): remove the predicate-list editors`**
- Files: `logic/query/predicates.ts` (delete `projectControls(state)`, `setControl`, `setTriageTab`, `applyControls`, `toggleRepo`, `removePredicate`, `clearSecondary`; keep `formatPredicateChip`, `projectClauses` and the projection helpers until `ActiveFilterChips` is deleted in 2.6), `__tests__/predicates.test.ts` (remove the predicate-list cases; their behaviour is covered by `textEdit.test.ts`).
- Tests: as listed; no behaviour change.
- AC: no dead predicate-list code remains.

**2.5 `feat(dashboard): add the tokenized query input component`**
- Files: `logic/query/editor.ts`, `components/query/{QueryInput,QueryChip,SuggestionList}.tsx`, `hooks/useQuerySuggestions.ts`.
- Tests: `editor.test.ts` (every transition; normalisation: space finishes, comma does not, quotes keep spaces, paste splits; `openChip` commits the draft; select-all; undo coalescing), `QueryInput.test.tsx` (the full keyboard table in §6.2, click-to-caret with stubbed caret APIs and the fallback, copy/cut/paste in select-all mode (`data-selected` on chips, "All selected" announced), undo/redo, IME composition, combobox ARIA, live-region messages, external `value` change resets state and history even while focused with an open draft; **chip styles**: `lable:bug` renders `data-status="error"`, `aria-invalid="true"`, the `chip-error-icon` and an `aria-description` starting "Error:", while `-label:kind/bug` renders `data-status="ok"`, `data-negated="true"`, the muted minus marker, an `aria-description` starting "Excludes" and no `aria-invalid`; the two chips have different container classes; no rendered chip has a `line-through` class), `useQuerySuggestions.test.ts` (key context, value context for closed/open fields, `is:`, ranking, exclusion of used values, quoting on insert).
- AC: component works standalone with a static vocabulary and injected facet values; not yet in the dashboard; error and negated chips are distinguishable by colour, icon and ARIA, and neither uses strikethrough (U9).

**2.6 `feat(dashboard): replace the search box and chips row with the query input`**
- Files: `Dashboard.tsx` (input moves into the list header, U7), delete `components/dashboard/ActiveFilterChips.tsx` together with the "Clear filters" button, `formatPredicateChip`/`ExtraPredicate`, and any remaining chip-row helpers in `useDashboardFilters.ts` and `predicates.ts`, `components/dashboard/FilterToolbar.tsx` (keeps the active trigger styles it has had since Phase 1), `hooks/useKeyboardNavigation.ts` and `components/KeyboardShortcutsModal.tsx` (`/` shortcut), author "you" row writes `author:@me`.
- Tests: RPC tests: typing `is:open label:bug` sends `state:open label:bug`; ticking a label in the menu edits only that clause and the chip text updates; Backspace into a chip and edit; **clear (U8)**: on the Acked tab with text `triage:acked label:bug` and `sort=created`, clicking × gives text `''`, title "Inbox", a URL without `q` but still with `sort=created`, and the next `GetItems` has no `triage` and no `label` predicate; the title menu edits a `triage:acked` chip in place while the sidebar Workflow rows reset text and sort to the tab alone (Phase 1 §3.4); `/` focuses the input and its default is prevented; existing chip tests rewritten against the input. `Dashboard.test.tsx` updated where it referenced the old search box placeholder, chips or "Clear filters".
- AC: the dashboard has one query input and one clear control (×).

**2.7 `feat(dashboard): autocomplete query keys and values`**
- Files: `hooks/useQuerySuggestions.ts` (facet wiring), `hooks/useDashboardData.ts` (expose selector facets), `components/query/QueryInput.tsx`, `spec.md`, `docs/user_guide.md` (query syntax section with the `is:` table and examples).
- Tests: RPC tests: typing `label:` lists labels from the selector facets; typing `assignee:` lists assignees from the same selector facets (no extra `GetFacets` call); Enter on a value finishes the chip.
- AC: `spec.md` describes the text query input and `?q=` URLs (Phase 2 milestone).

---

## 14. Risks and edge cases

| Risk / edge case | Handling |
|---|---|
| Controlled `<input>` inside a tokenized editor loses the caret on re-render. | Restore focus and selection in `useLayoutEffect` from `EditorState.caret` (prototype pattern); test caret position after every transition. |
| `caretPositionFromPoint`/`caretRangeFromPoint` differ by browser or return a node outside the chip. | Feature-detect both; accept only text nodes whose parent has `data-off` inside the clicked chip; otherwise caret at the chip end. |
| The 3 s poll re-renders while typing. | Editor state is local and only re-initialised when `value` differs from `toText(local)`; polling never changes the text. |
| Popstate or a sidebar click arrives while a draft is open. | The external value always wins, focused or not (§6.1); a focused input keeps focus with an empty draft at the end. Pointer-down on a control blurs and commits first. Test both. |
| Hand-written `?q=` with runs of spaces. | `parseDashboardUrl` normalises clause whitespace and rewrites the URL (§8.2), so the §4 invariant holds from the first render. |
| Legacy URL plus `?q=` with conflicting predicates (`?repo=a/b&q=repo:c/d`). | ANDed as specified (matches nothing), consistent with the rule; no special case. |
| Old `?q=` values change meaning (§8.4). | Accepted and documented. |
| URL length with very long queries. | Browsers handle several KB; no cap. |
| Values with quotes/backslashes (GitHub labels). | Escapes (P10); covered by the round-trip generator. |
| Error chips confused with negated chips. | Distinct colour, icon, marker and ARIA (§6.3); asserted in commit 2.5. |
| Keyboard navigation (`j`/`k`, `x`, `s`) firing while typing in the query input. | `useKeyboardNavigation` already ignores events from text inputs; add a test with the new input, and keep the `/` shortcut ignored inside inputs. |
| Phase 3 parses saved-search text with this parser. | Keep `parseQuery` pure and exported from `logic/query/syntax/index.ts`; any later grammar change must keep previously valid text valid or Phase 3 rows will show errors ([Phase 3 §12](query_model_phase3_saved_searches.md)). |
