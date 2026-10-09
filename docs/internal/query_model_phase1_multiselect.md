# Query Model Phase 1: Multi-select and Activity Filters

**Status:** Ready to implement.
**Overview:** [query_model_plan_overview.md](query_model_plan_overview.md) (ground rules, user decisions U1–U14, scope, module map, testing strategy).
**Parent design:** [query_model_design.md](query_model_design.md).
**Tracking:** [#15 Selector multi-select](https://github.com/tallclair/octodeck/issues/15)

This document is self-contained for the agent implementing Phase 1. Read the [overview's ground rules](query_model_plan_overview.md#1-ground-rules-for-the-implementer) first.

---

## 1. Prerequisites

- **Phase 0 merged** (it is, on `main`). Phase 1 relies on:
  - the predicate-list state in [`useDashboardFilters.ts`](../../frontend/src/hooks/useDashboardFilters.ts) and [`predicates.ts`](../../frontend/src/logic/query/predicates.ts) (`projectControls`, `setControl`, `setTriageTab`, `rankOf`; this phase also rewrites the module-private `replacePredicates`, whose use of `spec.owns` is what P2 removes);
  - the structured URL codec [`urlCodec.ts`](../../frontend/src/logic/query/urlCodec.ts), which already reads and writes repeated parameters and `-key=`;
  - `GetFacets` own-field exclusion (`Query.WithoutTopLevel` in [`facets.go`](../../backend/internal/query/facets.go)) and `GetItems` evaluation of multi-value predicates;
  - the RPC-level test harness [`rpcTestUtils.tsx`](../../frontend/src/test/rpcTestUtils.tsx).
- No earlier plan phase. Phase 2 builds on this phase's component extraction and projection with owner indices.
- The untracked Phase 2 input prototype (`frontend/prototype/`, `frontend/src/prototypes/`) is recorded in git history by commit 1.0 and deleted in commit 1.1 (U2), because its tests and lint otherwise run on every Phase 1 commit. Phase 2 reads it from git history.
- User decisions that apply here: U9 (no strikethrough; negated chips are distinct from errors) and U11 (multi-select rules). See the [overview](query_model_plan_overview.md#21-decided-by-the-user).

## 2. Goals and non-goals

Goals:
- Apply U11: every non-binary field is multi-select, written as one comma-OR predicate per field (`label:a,b`), as parent §4.1 requires.
- An **Activity** menu over `new:item|mention|comment|code|noise|any`.
- Shrink `Dashboard.tsx` (1,806 lines) by extracting the header, toolbar, menus, chips and sidebar into components, before adding anything.

Control inventory after Phase 1:

| Field | Control | Selection | Notes |
|---|---|---|---|
| triage | title menu + sidebar Workflows | tabs (Inbox / New / Acked / All) | unchanged |
| type | segmented control (All / PRs / Issues) | single | unchanged (binary) |
| state | State menu | single: Open / Closed / **Merged** | single-select because merged is a subset of closed (U11); Merged is new (P20) |
| tracking | State menu section (Tracked / Untracked) | single | unchanged (binary) |
| repo, org | Repository menu | multi (org and repo do not coexist, P3) | §3.2 |
| author | Author menu | multi | §3.3 |
| assignee | **Assignee menu** (new) + "Assigned to me" toggle | multi | §3.3, P19 |
| milestone | Milestone menu | multi | |
| label | Label menu | multi | |
| new | **Activity menu** (new) | multi | §3.4 |
| draft, starred | none in Phase 1 | (binary) | reachable via Phase 2 text (`is:draft`, `is:starred`); future controls are toggles (P20) |

Non-goals:
- No negation from menus (no "exclude" tri-state). Negated predicates arriving from URLs keep showing as chips. Phase 2 text covers negation.
- No backend or proto changes: `GetFacets` already facets `FIELD_NEW` and `FIELD_ASSIGNEE` (both facetable; `new:any` is a meta value and is not listed, see `isMetaValue` in [`facets.go`](../../backend/internal/query/facets.go)), and `GetItems` already evaluates multi-value predicates.
- No URL format change. [`urlCodec.ts`](../../frontend/src/logic/query/urlCodec.ts) already reads and writes repeated parameters (`label=a&label=b`) and `-key=`.

## 3. UI specification

### 3.1 The multi-select menu (shared by all multi-select fields)

Trigger button (in the toolbar, same position and style as today's custom dropdowns in `Dashboard.tsx` lines ~1094–1399):
- Icon + field label ("Repository", "Author", "Assignee", "Milestone", "Label", "Activity") + chevron.
- When the field has a selection, the button gets the active style used by the "Assigned to me" toggle (blue border/background) and shows the number of selected values: `Label · 2`.

Menu panel (opens below the trigger, `w-64 max-h-80`, scrolls). An `<input>` is not valid content of `role="menu"`, so the panel is a container holding the filter box plus a `role="listbox"` with `aria-multiselectable="true"`:
1. **Filter box** at the top (autofocused on open; placeholder "Filter labels…"). Case-insensitive substring filter over the listed options, client-side only. Hidden for Activity (fixed short list).
2. **Header line** with "Clear" (only when something is selected): sets the field's selection to empty.
3. **Option rows**, `role="option"`, `aria-selected`. Each row: a checkbox square (lucide `Check` inside a bordered square when checked), the value (labels keep their colour dot; authors are prefixed `@`), and the facet count right-aligned in muted monospace. Zero-count rows (visible only with "Show all") are dimmed.
4. **"Show all"** footer as today (`hasMore` from [`facets.ts`](../../frontend/src/logic/query/facets.ts)). `MultiSelectMenu` **owns** the `showAll` state and builds its options itself from raw facet values (§6); an effect resets `showAll` to off whenever `open` becomes false, so `useMenuGroup` needs no close callbacks.

Behaviour:
- Clicking a row (or Space/Enter on a focused row) toggles that value and **keeps the menu open**. Each toggle is applied immediately (one history entry per toggle, `pushState`, as control edits do today).
- **Stable rows while open:** the set of rows is frozen when the menu opens and only grows while it stays open (`useStableOptions(open, options)` keeps every value seen since opening). Without this, unticking a value whose count drops to 0 would make it vanish under the pointer on the next facet refresh. Rows keep their alphabetical position; checking a value does not move it. Counts always come from the latest facet response (0 for a value no longer in it), and the union is re-sorted by name so rows do not move. This is compatible with `placeholderData: keepPreviousData`, which only delays the prop change.
- The selected values are always listed even when their count is 0 or the daemon does not know them (generalises today's "selected value is always listed" rule in `buildOptions`).
- Keyboard: ArrowDown/ArrowUp move between the filter box and rows; Escape closes and returns focus to the trigger; Tab closes.
- Only one menu is open at a time: `useMenuGroup.toggle(id)` closes the others explicitly. (Today this holds only as a side effect of the `mousedown` click-outside handler; opening a second trigger with the keyboard leaves both open.)
- Own-field facet exclusion is already done by the daemon: `GetFacets` counts each field with that field's own top-level predicates removed (`Query.WithoutTopLevel`), so ticking `repo:a` keeps every other repo listed with its count, and a second repo can be added. Negated predicates of the field are also removed for counting (they are top-level predicates of the field). The menu never displays negated predicates.

### 3.2 Repository menu (org + repo)

- Same grouping as today (`buildRepoDropdown`): org header rows with repos indented beneath.
- Org header rows are checkboxes for `org:` values; repo rows are checkboxes for `repo:` values. Both are multi-select: `org:a,b` and `repo:x/y,x/z` are fine.
- **Org and repo do not coexist (P3, revisited for U11):** ticking an org while any repo is selected clears the repo selection, and vice versa. Reason: two different fields are ANDed (parent §4.1), so any org + repo combination is either redundant (`org:kubernetes repo:kubernetes/website` = just the repo) or empty (`org:kubernetes repo:golang/go`). The union the user means ("this org, plus that repo") needs OR across fields, which the predicate list and the Phase 2 grammar do not express. Making the menu prevent the useless combinations is clearer than letting it produce an empty list. A one-line hint at the top of the menu appears while one mode is active: "Selecting an organization clears repositories" (and the converse).
- If both an `org:` and a `repo:` predicate are present in the state, the menu shows both ticked and the list is filtered as the AND says; the next tick in the menu applies the rule above. This state is not reachable from legacy URLs (the reader drops `org` when `repo` is present, and keeps doing so in Phase 2); it is reachable from Phase 2 text and hand-built states.
- Org header rows show **no count**. The org facet excludes only org predicates, so under a repo selection every other org would read 0 while its repo rows show real counts.
- The filter box matches both org and repo names; an org header is shown if it or any of its repos match.

### 3.3 Author and Assignee menus

- **Author:** "@login (you)" row first when the current user appears in the facet, as today. In Phase 1 it writes the login (the legacy URL reader maps `author=@me` to the login "me", see `URL_FIELDS` in [`vocabulary.ts`](../../frontend/src/logic/query/vocabulary.ts), so `@me` cannot be written to structured URLs). Phase 2 switches this row to `author:@me` ([Phase 2 §5.4](query_model_phase2_query_input.md)).
- **Assignee (new menu):** same component, options from the `FIELD_ASSIGNEE` facet (added to `SELECTOR_FIELDS`). The first row is "@login (you)" and writes `@me` (the legacy assignee decoder keeps a leading `@`, so `assignee=@me` round-trips in Phase 1 URLs). The row is ticked when the selection contains `@me` or the current login.
- **"Assigned to me" toggle (P19)** stays next to the menus as a shortcut: it is active when the assignee selection contains `@me`, and clicking it adds or removes `@me` from that selection (one predicate, e.g. `assignee:@me,alice`). The serializer keeps writing the legacy `assigned=me` for the exact `assignee:@me` predicate (today's `isAssignedToMePredicate` rule) and `assignee=@me&assignee=alice` otherwise.

### 3.4 Activity menu and the New tab (P4)

Rows, in this order (values from the `FIELD_NEW` closed set in [`query.proto`](../../api/octodeck/v1/query.proto)):

| Row label | Value | Count |
|---|---|---|
| Any new activity | `any` | none shown (meta value, not in the facet) |
| *(divider)* | | |
| New items | `item` | facet |
| Mentions | `mention` | facet |
| Comments & reviews | `comment` | facet |
| New commits | `code` | facet |
| Noise (bots) | `noise` | facet |

Selection rules (enforced in the control-edit function, not the component):
- Ticking **Any** removes `item`, `mention`, `comment`, `code` (they are subsumed); `noise` is kept, because noise is never part of `any` (parent §4.4).
- Ticking any of `item`, `mention`, `comment`, `code` while Any is ticked unticks Any.

Relationship to the triage tabs. **Two entry points, unchanged from today, and this is the canonical statement that Phases 2 and 3 refer to:**
- The **title menu** switches the tab **in place** (`setTriageTab`): other predicates, the search text and the sort survive.
- The **sidebar Workflow rows** (Inbox / New / Acked) are shortcuts that **reset the whole query to that tab alone** (`applyWorkflowShortcut` = `setTriageTab(DEFAULT_QUERY_STATE, tab)`): every other predicate, the search text, and sort/order go back to their defaults, and the selected item is cleared.

Tab rules:
- The **New tab** is displayed when there is no `triage` predicate and the activity predicate is exactly `new:any` (today's `isActivityPredicate` rule). Nothing else changes about what "New" means.
- The activity predicate is now **displayed by two controls**: the Activity menu (shows "Any new activity" ticked) and the tab title ("New"). To avoid saying the same thing twice, the chips row does **not** show an Activity chip in exactly that case. In every other case (e.g. `new:mention`, or `new:any` together with `triage:acked`) the Activity chip is shown.
- Switching tabs (`setTriageTab`): removes every `triage` predicate, **negated ones included** (an explicit exception to P2: a negated triage predicate contradicts every tab), and the activity predicate **only if it is exactly `new:any`**, then adds `triage:acked`/`triage:all`, or `new:any` for New. Other activity selections survive a tab switch and remain visible as a chip (so Acked + `new:mention` shows an empty list with an "Activity: Mentions" chip, and the facet counts in the menu read 0, which explains it).
- Selecting New while the activity predicate is e.g. `new:mention,code` replaces it with `new:any` (the tab means "any new").
- Ticking `noise` while on the New tab gives `new:any,noise`, which is no longer exactly `new:any`, so the title becomes "Inbox" and an Activity chip appears. This follows from the rules and is intended.
- The sidebar "New" count (`totals.new`) is unchanged.

`SELECTOR_FIELDS` in [`useDashboardData.ts`](../../frontend/src/hooks/useDashboardData.ts) gains `Field.ASSIGNEE` and `Field.NEW` so the Assignee and Activity menus have options and counts (still one `GetFacets` call).

### 3.5 Chips row

One chip per displayed control plus one per extra predicate (today's structure in `Dashboard.tsx` lines ~1421–1596, extracted into `ActiveFilterChips`). Multi-value chips:
- Label: `Repo: kubernetes/kubernetes, kubernetes/website` for up to 2 values; `Repo: kubernetes/kubernetes +2` for more, with a `title` listing all values.
- Authors and assignees are shown with `@`; activity values with the row labels above ("Activity: Mentions, New commits").
- The × removes the whole predicate; `aria-label` lists every value: "Remove repository filter kubernetes/kubernetes, kubernetes/website".
- Clicking the chip body opens the corresponding menu (no-op for extra-predicate chips).
- **Negated chips** (from URLs, e.g. `-label=kind/bug`) use the normal chip colours with a leading **NOT** marker: a small `rounded bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300 text-[10px] font-semibold uppercase px-1` badge reading "NOT", then "Label: kind/bug". The chip has `data-negated="true"` and an `aria-label` starting "Excluding". No strikethrough (U9). This replaces today's "Not Label:" prefix and is the same visual language Phase 2 uses ([Phase 2 §6.3](query_model_phase2_query_input.md)).

### 3.6 Sidebar repo shortcuts

`toggleRepo(repo)`: if the repo control is exactly `[repo]`, clear it; otherwise set it to `[repo]` and clear org. A repo row is highlighted when the repo control **contains** it (today: equals it).

## 4. Types ([`types/filters.ts`](../../frontend/src/types/filters.ts))

```ts
export type ActivityValue = 'any' | 'item' | 'mention' | 'comment' | 'code' | 'noise';
export type ItemStateFilter = 'open' | 'closed' | 'merged' | 'all'; // 'merged' is new (P20)

export interface FilterControls {
  triage: TriageFilter;          // unchanged ('inbox' | 'activity' | 'acked' | 'all')
  state: ItemStateFilter;        // single-select (merged is a subset of closed)
  type: ItemTypeFilter;          // unchanged (binary)
  tracking: TrackingFilter;      // unchanged (binary)
  org: readonly string[];        // was string | null
  repo: readonly string[];       // was string | null
  author: readonly string[];     // was string | null
  assignee: readonly string[];   // new; replaces the 'assigned' control ('Assigned to me' is derived)
  milestone: readonly string[];  // was string | null
  label: readonly string[];      // was string | null
  activity: readonly ActivityValue[]; // new
  q: string;
  sort: SortOption;
  order: SortOrder;
  item: string | null;
}
```

`DEFAULT_FILTER_CONTROLS` uses frozen empty arrays. Also add, in commit 1.2, `export type ControlKey = Exclude<keyof FilterControls, 'q' | 'sort' | 'order' | 'item'>;` (it replaces the private `PredicateControl` in `predicates.ts`). `AssignedFilter` and the `assigned` control key are removed; "Assigned to me" is `controls.assignee.includes('@me')`. `DashboardQueryState` is unchanged in Phase 1.

## 5. Predicate logic ([`predicates.ts`](../../frontend/src/logic/query/predicates.ts))

Change the projection so it records **which predicate index each control displays**:

```ts
export interface Projection {
  controls: FilterControls;
  /** Index in state.predicates of the predicate each control displays. */
  owners: Partial<Record<ControlKey, number>>;
  extras: ExtraPredicate[];
}
export function projectControls(state: DashboardQueryState): Projection;
```

Rules (P2):
- A multi-value control (`org`, `repo`, `author`, `assignee`, `milestone`, `label`, `activity`) displays the **first non-negated** predicate of its field, with all its values. Single-value controls (`state`, `type`, `tracking`) keep today's rules (exactly one value that the control can show; `state` now also shows `merged`).
- Negated predicates are never displayed by a control; they are extras.
- `activity` is displayed by the Activity control; the triage tab value `'activity'` is derived (no triage predicate and activity is exactly `['any']`), and the same predicate index is recorded for both `owners.activity` and `owners.triage`.
- `setControl(state, key, value)` recomputes the projection from `state` internally (never takes owners from the caller, so `applyControls`, which reduces several edits, never uses stale indices), then replaces the predicate at `owners[key]` (or removes it when the new value is empty/"all"), or inserts at the canonical rank (`rankOf`) when the control displays nothing. It **no longer removes every predicate of the field** (today `replacePredicates(predicates, spec.owns, next)` removes all owned predicates, including negated ones).
- `setActivity(state, values)` applies the Any/specific rules from §3.4, then `setControl`.
- `setOrgOrRepo(state, kind, values)` applies P3: setting a non-empty org selection removes the repo control's predicate, and vice versa.
- `toggleAssignedToMe(state)` adds or removes `@me` in the assignee selection (P19).
- `setTriageTab` as described in §3.4.
- `clearSecondary` keeps the predicates displayed by `triage` and `type` (by owner index) and drops the rest, as today.
- `formatPredicateChip` gains the multi-value label rules from §3.5 (return `{label, values: string[], negated}` and let the component render the "+N" and the NOT marker).

`isActivityPredicate` stays (the tab test). `isAssignedToMePredicate` stays (URL serialization only).

## 6. Facets ([`facets.ts`](../../frontend/src/logic/query/facets.ts))

- `useDashboardData` returns the **raw** `FacetValue[]` per selector field (plus `pinnedRepos`) instead of finished option lists; `MultiSelectMenu` calls the builders below with its own `showAll` (§3.1).
- `buildOptions(values, selected: readonly string[], showAll)`; `buildLabelOptions` likewise. Options become `{ value: string; count: number; color?: string }` so menus can show counts (`count` is 0 for selected values unknown to the facet). Used for author, assignee, milestone and label.
- `buildRepoDropdown(repoValues, orgValues, selected: { repos: readonly string[]; orgs: readonly string[] }, pinnedRepos, showAll)` returns repos and orgs with counts.
- New `buildActivityOptions(values)` returning the six rows (counts from the `FIELD_NEW` facet; `any` has `count: null`).

## 7. Component extraction (do this first, as a pure refactor)

Create `frontend/src/components/dashboard/`:

| New file | Moves out of `Dashboard.tsx` | Notes |
|---|---|---|
| `useMenuGroup.ts` (in `frontend/src/hooks/`) | the seven `*MenuOpen` states, seven refs, the Escape handler (lines ~414–435) and the click-outside effect (lines ~437–470) | Instantiated **once, in `Dashboard`**: `const menus = useMenuGroup<'status' \| 'state' \| 'repo' \| ...>()` returning `{ open, isOpen(id), toggle(id), close(), refFor(id), anyOpen }`. `anyOpen` feeds `useKeyboardNavigation({ disabled })`, and the group spans components in the header and the list body, so `menus` (or a per-id slice `{open, toggle, close, ref}`) is passed down as props to `TriageTitleMenu`, `FilterToolbar`, `SortMenu`. `toggle(id)` closes the others. `refFor(id)` returns a stable per-id ref object (a `Map` created once), otherwise the `mousedown` `contains()` check breaks. |
| `TriageTitleMenu.tsx` | Row 1 (title + status menu, lines ~850–955) | props: `triage`, `onSelect(tab)`, menu props |
| `FilterToolbar.tsx` | Row 2 (type slider, State/Repo/Author/Milestone/Label menus, Assigned toggle, lines ~956–1419) | receives controls, options and callbacks |
| `ActiveFilterChips.tsx` | Row 3 (lines ~1421–1596) | |
| `SortMenu.tsx` | sort control (lines ~1614–1723; it lives in the list body inside the scroll container, not in the header) | |
| `DashboardSidebar.tsx` | `<aside>` (lines ~622–839), including a reusable `SidebarRow` (name, count, unread dot, active state) used by workflow, pinned and repo rows | also needs `setShowShortcutsModal` (from `useKeyboardNavigation`) and `showSettings`/`setShowSettings`; `showHiddenRepos` can become local state |

After this refactor `Dashboard.tsx` should be ≤ 950 lines and contain only data wiring, mutations and layout. Later phases add files next to these rather than growing `Dashboard.tsx`.

---

## 8. Decisions made for this phase (reviewable)

User decisions (U*) are listed in the [overview](query_model_plan_overview.md#21-decided-by-the-user). Phase 1 owns these plan decisions:

| # | Decision | Short reason | Where |
|---|---|---|---|
| P2 | Every control edits only the predicate it displays; negated predicates are never owned by a control. One explicit exception: a tab switch removes negated `triage` predicates too (§3.4). | Multi-select would otherwise silently delete `-label:x` or a second `label:` clause. | §5 |
| P3 | In the combined Org & Repo menu, org and repo selections do **not** coexist: ticking an org clears the repo selection and vice versa. Several orgs, or several repos, are fine. | Any org + repo combination is an AND, which is either redundant (the repo is inside the org) or empty (it is not); the union a user means needs cross-field OR, which neither the menus nor the Phase 2 grammar express. | §3.2 |
| P4 | Activity filter UI is a new **Activity** multi-select menu in the toolbar; the New tab stays as "inbox + `new:any`". | Keeps the tab as the one-click workflow while exposing every flag. | §3.4 |
| P5 | Menus show facet counts next to each value and have a filter box. | Counts are already returned; long repo/author lists need filtering once several can be picked. | §3.1 |
| P19 | The "Assigned to me" toggle stays as a one-click shortcut that toggles `@me` inside the (now multi-select) assignee selection. | Keeps today's most-used assignee filter one click away without a second assignee predicate. | §3.3 |
| P20 | The State menu gains "Merged" (single-select: Open / Closed / Merged). Draft and starred get no new toolbar controls in Phase 1 (they are reachable through Phase 2 text: `is:draft`, `is:starred`); if controls are added later they are toggles. | Completes the single-select state field without widening Phase 1 scope. | §2 |

---

## 9. Commit plan

Each commit must leave `./verify.sh` green (never `--force`). Commit subjects follow Conventional Commits with no backticks.

**1.0 `chore(frontend): record the throwaway query input prototype`**
- Files: `git add frontend/prototype frontend/src/prototypes` exactly as they are in the working tree (no edits). This exists only so the prototype is recoverable from git history once 1.1 deletes it (U2); it is never imported by production code.
- Tests: the prototype's own tests (`TokenizedInput.test.tsx`, `parser.test.ts`) already pass under `./verify.sh`.
- AC: `git show <1.0>:frontend/src/prototypes/queryInput/TokenizedInput.tsx` works.

**1.1 `refactor(dashboard): extract toolbar, menus, chips and sidebar from Dashboard`**
- Files: new `components/dashboard/{TriageTitleMenu,FilterToolbar,ActiveFilterChips,SortMenu,DashboardSidebar,SidebarRow}.tsx`, new `hooks/useMenuGroup.ts`; `Dashboard.tsx`; `git rm -r frontend/prototype frontend/src/prototypes` (U2; Phase 2 points at commit 1.0 for the code).
- Tests: `hooks/__tests__/useMenuGroup.test.ts` (opening one closes the others, including via `toggle` without a mousedown; Escape closes; outside pointer-down closes; `anyOpen`; `refFor(id)` returns the same object across renders). Existing `Dashboard.test.tsx` and `Dashboard.rpc.test.tsx` pass **unchanged** (they scope menus by `trigger.parentElement`, so each trigger must stay a direct child of its ref'd `div.relative`).
- AC: no behaviour or DOM-text change; `Dashboard.tsx` ≤ 950 lines; no `frontend/prototype` or `frontend/src/prototypes` on disk.

**1.2 `fix(dashboard): keep negated filters when changing a selector`**
- Files: `types/filters.ts` (`ControlKey`), `logic/query/predicates.ts`, `hooks/useDashboardFilters.ts`.
- Change: `projectControls` returns `owners`; `setControl` recomputes them internally; `setControl` edits only the displayed predicate; controls never own negated predicates (P2).
- Tests: update `predicates.test.ts`: `-label:bug` survives choosing a label; a second `label:` predicate stays an extra and survives edits; existing ordering tests still pass. Add an RPC test: URL `?-label=bug`, pick label `a` → request `-label:bug label:a`.
- AC: all existing single-select behaviour unchanged except the negated/duplicate cases.

**1.3 `feat(dashboard): add a multi-select menu component`**
- Files: `components/dashboard/MultiSelectMenu.tsx`, `hooks/useStableOptions.ts`.
- Tests: component tests: toggling keeps the menu open and calls `onChange` with the new array; Clear; filter box; Show all (owned by the menu; reset after close and reopen); dimmed zero counts; stable rows while open (option removed from props stays rendered until close, with count 0; rows keep their order); keyboard (arrows, Space, Escape returns focus); ARIA (`listbox` with `aria-multiselectable`, `option` with `aria-selected`; tests query `option`).
- AC: not yet used by the dashboard.

Commit 1.4 is split in two to keep it reviewable and bisectable.

**1.4a `refactor(dashboard): make selector controls array-valued`**
- Files: `types/filters.ts` (array controls, `assignee` replaces `assigned`, `merged` state), `logic/query/predicates.ts` (`setOrgOrRepo`, `toggleAssignedToMe`), `logic/query/facets.ts` (option shapes with counts), `hooks/useDashboardData.ts` (raw facet values per field; `Field.ASSIGNEE` in `SELECTOR_FIELDS`), `hooks/useDashboardFilters.ts`, and the existing dropdowns adapted to write one-element arrays (no visible change yet).
- Tests:
  - `predicates.test.ts`: array controls; org/repo do not coexist (ticking an org clears repos and vice versa; a constructed `DashboardQueryState` holding both an `org:` and a `repo:` predicate projects both); `toggleRepo` rules; Assigned-to-me toggles `@me` within `assignee:@me,alice`; state Open/Closed/Merged is single-select.
  - `facets.test.ts`: array `selected`, counts.
  - `useDashboardFilters.test.ts`: URL `label=a&label=b` round trip through the control; `assigned=me` still written for exactly `assignee:@me`, `assignee=@me&assignee=alice` otherwise.
- AC: existing behaviour unchanged; all tests green.

**1.4b `feat(dashboard): select several repositories, orgs, authors, assignees, milestones and labels`**
- Files: `components/dashboard/{FilterToolbar,ActiveFilterChips,DashboardSidebar}.tsx` (wire `MultiSelectMenu`; new Assignee menu; Merged in the State menu; NOT marker on negated chips).
- Tests:
  - `Dashboard.rpc.test.tsx`: tick two labels → `label:a,b` and URL `?label=a&label=b`; tick two assignees → `assignee:a,b`; tick org then repo clears org; select Merged → `state:merged`; chip "Repo: a/b +2" with full `title`; chip × removes the predicate; the selected value with zero count stays listed; selector `GetFacets` includes `FIELD_ASSIGNEE`.
  - `ActiveFilterChips` test: a negated chip renders the "NOT" badge, has `data-negated="true"` and an `aria-label` starting "Excluding", and no element has a `line-through` class.
  - `Dashboard.test.tsx`: the "Tracking Filter in State Dropdown" tests drive the State menu by `getByRole('button', …)`; State stays single-select with button rows, so they keep passing.
- AC: U11 behaviour for every field except activity; type and tracking unchanged; legacy single-value URLs behave as before.

**1.5 `feat(dashboard): filter by new activity type`**
- Files: `types/filters.ts`, `logic/query/predicates.ts` (`setActivity`, tab interplay), `logic/query/facets.ts` (`buildActivityOptions`), `hooks/useDashboardData.ts` (`Field.NEW` in `SELECTOR_FIELDS`), `components/dashboard/{FilterToolbar,ActiveFilterChips}.tsx`, `spec.md`, `docs/user_guide.md` (§3 Filtering & Search: multi-select, Assignee and Activity).
- Tests: `predicates.test.ts`: Any/specific exclusivity, noise combines with Any (and `new:any,noise` is not the New tab), New tab derivation, tab switch keeps `new:mention`, tab switch removes `-triage:acked`, New replaces `new:mention,code` with `new:any`. RPC tests for the two entry points (§3.4): with `label:bug` selected, sidebar New → request is exactly `new:any` and sort is reset; title-menu New → `new:any label:bug` with sort kept. RPC tests: selector `GetFacets` requests include `FIELD_NEW`; ticking Mentions sends `new:mention`; New tab shows no Activity chip but the menu shows Any ticked; Acked + Mentions shows the chip.
- AC: parent §4.4 semantics visible in the UI; `spec.md` updated (Phase 1 milestone).

---

## 10. Risks and edge cases

| Risk / edge case | Handling |
|---|---|
| Facet refresh (every 3 s) changes menu rows under the pointer. | `useStableOptions` (§3.1). |
| `org:` and `repo:` predicates both present in the state (not from legacy URLs, which drop `org`; possible from Phase 2 text). | Both are displayed ticked and the list shows the AND; the next tick applies P3 (§3.2). |
| A second non-negated predicate for the same field (`label=a` cannot produce it today, but hand-built URLs and Phase 2 text can). | It is an extra chip; the menu edits only the first (P2). |
| Acked tab combined with an activity selection shows an empty list. | Expected (acked items have no `new:` flags); the Activity chip and zero counts in the menu explain it (§3.4). |
| `Dashboard.test.tsx` drives the State menu by button role. | State stays single-select with button rows (its `GetFacets` stub ignores fields, so the new selector fields need no stub change). |
| `assignee=@me` in URLs. | The legacy assignee decoder keeps the `@`, so it round-trips; the exact `assignee:@me` predicate is still written as `assigned=me` (§3.3). |
| Keyboard navigation (`j`/`k`, `x`, `s`) while a menu's filter box has focus. | `useKeyboardNavigation` ignores text inputs and is disabled while any menu is open (`useMenuGroup().anyOpen`). |
