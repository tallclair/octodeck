// Pure client-side logic for saved searches (Phase 3 §6.3, §7, §9.1):
// view projection from config.json entries, triage-scope badge classification,
// sidebar GetFacets count request building/attachment, active-row matching,
// suggested naming, and list reordering.
import { Field, SortKey, SortOrder as ProtoSortOrder } from '../api/octodeck/v1/query_pb';
import {
  DEFAULT_QUERY_STATE,
  type SortOption,
  type SortOrder,
} from '../types/filters';
import { toExpr, type ExprInit } from './query/expr';
import {
  canonicalQuery,
  formatPredicates,
  parseQuery,
  type Clause,
  type ParsedQuery,
} from './query/syntax';
import { insertClause, removeClause } from './query/textEdit';
import { isActivityPredicate } from './query/vocabulary';

export const MAX_SAVED_SEARCHES = 50;
export const MAX_SAVED_SEARCH_NAME_LENGTH = 80;
export const MAX_SAVED_SEARCH_QUERY_LENGTH = 1000;
export const SUGGESTED_NAME_MAX_LENGTH = 40;

export type BadgeScope = 'inbox' | 'new' | 'acked' | 'all';

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

export interface SavedSearchInput {
  readonly id: string;
  readonly name: string;
  readonly query: string;
  readonly sort?: {
    readonly key?: SortKey;
    readonly order?: ProtoSortOrder;
  };
}

export interface CountResultLike {
  readonly count?: number;
  readonly newCount?: number;
  readonly inboxCount?: number;
  readonly error?: { readonly message?: string } | undefined;
}

export interface SavedSearchCountRequest {
  queries: ExprInit[];
  rowIndex: number[];
}

export type SavedSearchBadgeStyle =
  | 'orange-bubble'
  | 'slate-bubble'
  | 'faded'
  | 'error'
  | 'none';

export interface SavedSearchBadge {
  readonly style: SavedSearchBadgeStyle;
  readonly variant: 'inbox' | 'new' | 'acked' | 'error' | 'none';
  readonly count: number | null;
  readonly hasNew: boolean;
  readonly ariaLabel: string | null;
  readonly error: string | null;
}

function fromProtoSortKey(key?: SortKey): SortOption {
  switch (key) {
    case SortKey.ACKED:
      return 'acked';
    case SortKey.CREATED:
      return 'created';
    case SortKey.UPDATED:
    default:
      return DEFAULT_QUERY_STATE.sort;
  }
}

function fromProtoSortOrder(order?: ProtoSortOrder): SortOrder {
  switch (order) {
    case ProtoSortOrder.ASC:
      return 'asc';
    case ProtoSortOrder.DESC:
    default:
      return DEFAULT_QUERY_STATE.order;
  }
}

/**
 * Tab clauses of a query (§7): every `triage` clause, plus the first `new:any` clause
 * when there is no `triage` clause (the New-tab derivation).
 */
export function tabClauses(parsed: ParsedQuery): Clause[] {
  const triage = parsed.clauses.filter((c) => c.predicate?.field === Field.TRIAGE);
  if (triage.length > 0) {
    return triage;
  }
  const firstNewAny = parsed.clauses.find(
    (c) => c.predicate !== null && isActivityPredicate(c.predicate)
  );
  return firstNewAny ? [firstNewAny] : [];
}

/** Returns `parsed.text` with its tab clauses removed via `removeClause`. */
export function stripTabClauses(parsed: ParsedQuery): string {
  let current = parsed.text;
  const tabs = tabClauses(parsed);
  for (let i = tabs.length - 1; i >= 0; i--) {
    current = removeClause(current, tabs[i]);
  }
  return current;
}

/**
 * Classifies a parsed saved query's badge scope from its top-level predicates (§6.3):
 * 1. Start with `allowed = {inbox, acked}`. Each positive `triage` predicate intersects `allowed`
 *    with its values (`all` expands to `inbox, acked`); each negated one removes its values.
 *    With no `triage` predicate, `allowed = {inbox}` (the implicit scope).
 * 2. `allowed = {inbox}`: `'new'` if there is a non-negated `new:` predicate with at least one
 *    value other than `noise`; otherwise `'inbox'`.
 * 3. `allowed = {acked}` -> `'acked'`.
 * 4. `allowed = {inbox, acked}` -> `'all'`.
 * 5. `allowed` empty -> `'inbox'`.
 */
export function badgeScope(parsed: ParsedQuery): BadgeScope {
  const triagePredicates = parsed.predicates.filter((p) => p.field === Field.TRIAGE);
  const allowed = new Set<'inbox' | 'acked'>(
    triagePredicates.length === 0 ? ['inbox'] : ['inbox', 'acked']
  );

  for (const pred of triagePredicates) {
    const values = new Set<'inbox' | 'acked'>();
    for (const raw of pred.values) {
      const v = raw.toLowerCase();
      if (v === 'all') {
        values.add('inbox');
        values.add('acked');
      } else if (v === 'inbox' || v === 'acked') {
        values.add(v);
      }
    }
    if (pred.negated) {
      for (const v of values) {
        allowed.delete(v);
      }
    } else {
      for (const existing of [...allowed]) {
        if (!values.has(existing)) {
          allowed.delete(existing);
        }
      }
    }
  }

  const hasInbox = allowed.has('inbox');
  const hasAcked = allowed.has('acked');

  if (hasInbox && hasAcked) {
    return 'all';
  }
  if (hasAcked && !hasInbox) {
    return 'acked';
  }
  if (hasInbox) {
    const hasNewActivity = parsed.predicates.some(
      (p) =>
        p.field === Field.NEW &&
        !p.negated &&
        p.values.some((v) => v.toLowerCase() !== 'noise')
    );
    return hasNewActivity ? 'new' : 'inbox';
  }
  return 'inbox';
}

/** Converts a stored `SavedSearch` config entry into a `SavedSearchView` (before counts arrive). */
export function toView(saved: SavedSearchInput): SavedSearchView {
  const text = saved.query;
  const parsed = parseQuery(text);
  const hasIssues = parsed.issues.length > 0;
  return {
    id: saved.id,
    name: saved.name,
    text,
    parsed,
    canonical: hasIssues ? '' : formatPredicates(parsed.predicates),
    hasScope: tabClauses(parsed).length > 0,
    scope: badgeScope(parsed),
    sort: fromProtoSortKey(saved.sort?.key),
    order: fromProtoSortOrder(saved.sort?.order),
    count: null,
    newCount: 0,
    inboxCount: 0,
    error: hasIssues ? parsed.issues[0].message : null,
  };
}

/**
 * Builds the `queries` array for the sidebar `GetFacets` request from valid saved searches,
 * together with `rowIndex` mapping each request entry back to its index in `views` (§6.2).
 */
export function buildCountRequest(views: readonly SavedSearchView[]): SavedSearchCountRequest {
  const queries: ExprInit[] = [];
  const rowIndex: number[] = [];
  views.forEach((view, index) => {
    if (view.parsed.issues.length === 0 && view.error === null) {
      queries.push(toExpr(view.parsed));
      rowIndex.push(index);
    }
  });
  return { queries, rowIndex };
}

/**
 * Attaches the `counts` returned by the sidebar `GetFacets` call back onto the corresponding
 * `SavedSearchView` rows (§6.2, §9.1).
 */
export function attachCounts(
  views: readonly SavedSearchView[],
  rowIndex: readonly number[],
  counts: readonly (CountResultLike | undefined)[] | undefined
): SavedSearchView[] {
  if (!counts) {
    return views.map((v) => ({ ...v }));
  }
  const byRow = new Map<number, CountResultLike>();
  rowIndex.forEach((r, k) => {
    if (k < counts.length && counts[k] !== undefined) {
      byRow.set(r, counts[k]);
    }
  });

  return views.map((view, idx) => {
    if (view.parsed.issues.length > 0) {
      return { ...view };
    }
    const res = byRow.get(idx);
    if (!res) {
      return { ...view };
    }
    if (res.error) {
      return {
        ...view,
        count: null,
        newCount: 0,
        inboxCount: 0,
        error: res.error.message || 'Invalid query',
      };
    }
    return {
      ...view,
      count: res.count ?? 0,
      newCount: res.newCount ?? 0,
      inboxCount: res.inboxCount ?? 0,
      error: null,
    };
  });
}

/**
 * Resolves the sidebar badge presentation for a `SavedSearchView` according to its triage scope
 * and counts (§6.3, U12, U14).
 */
export function resolveSavedSearchBadge(
  view: Pick<SavedSearchView, 'scope' | 'count' | 'newCount' | 'inboxCount' | 'error'>
): SavedSearchBadge {
  if (view.error !== null) {
    return {
      style: 'error',
      variant: 'error',
      count: null,
      hasNew: false,
      ariaLabel: null,
      error: view.error,
    };
  }
  if (view.count === null || view.count <= 0) {
    return {
      style: 'none',
      variant: 'none',
      count: null,
      hasNew: false,
      ariaLabel: null,
      error: null,
    };
  }

  switch (view.scope) {
    case 'inbox': {
      const hasNew = view.newCount > 0;
      return {
        style: hasNew ? 'orange-bubble' : 'slate-bubble',
        variant: 'inbox',
        count: view.count,
        hasNew,
        ariaLabel: `${view.count} items${hasNew ? ', some with new activity' : ''}`,
        error: null,
      };
    }
    case 'new':
      return {
        style: 'orange-bubble',
        variant: 'new',
        count: view.count,
        hasNew: true,
        ariaLabel: `${view.count} items with new activity`,
        error: null,
      };
    case 'acked':
      return {
        style: 'faded',
        variant: 'acked',
        count: view.count,
        hasNew: false,
        ariaLabel: `${view.count} acked items`,
        error: null,
      };
    case 'all': {
      if (view.inboxCount > 0) {
        const hasNew = view.newCount > 0;
        return {
          style: hasNew ? 'orange-bubble' : 'slate-bubble',
          variant: 'inbox',
          count: view.inboxCount,
          hasNew,
          ariaLabel: `${view.inboxCount} items${hasNew ? ', some with new activity' : ''}`,
          error: null,
        };
      }
      return {
        style: 'faded',
        variant: 'acked',
        count: view.count,
        hasNew: false,
        ariaLabel: `${view.count} acked items`,
        error: null,
      };
    }
  }
}

/**
 * Whether `view` is active for `currentParsed` (§7):
 * - Both the current query and the saved search must have no parse issues.
 * - A scoped search is active when `canonicalQuery(current) === canonicalQuery(saved)`.
 * - An unscoped search is active when `canonicalQuery(current minus tab clauses) === canonicalQuery(saved)`.
 * Sort is ignored.
 */
export function isActive(currentParsed: ParsedQuery, view: SavedSearchView): boolean {
  if (
    currentParsed.issues.length > 0 ||
    view.parsed.issues.length > 0 ||
    view.canonical === ''
  ) {
    return false;
  }
  if (view.hasScope) {
    return formatPredicates(currentParsed.predicates) === view.canonical;
  }
  return canonicalQuery(stripTabClauses(currentParsed)) === view.canonical;
}

/**
 * Whether `currentParsed` adds a tab clause to the unscoped saved search `view` (§7). An unscoped
 * search always opens on the implicit Inbox tab, so any tab clause in the current text was added
 * by the user afterwards; pinning then treats the query as a modification of `view` and keeps
 * the tab clause instead of discarding it.
 */
export function addsTabScope(currentParsed: ParsedQuery, view: SavedSearchView): boolean {
  return !view.hasScope && tabClauses(currentParsed).length > 0;
}

/** Returns the first active saved search matching `currentParsed`, or `undefined`. */
export function findActiveSearch(
  currentParsed: ParsedQuery,
  views: readonly SavedSearchView[]
): SavedSearchView | undefined {
  return views.find((v) => isActive(currentParsed, v));
}

/**
 * Computes the new query text when re-applying an edited `view` in place from
 * `currentParsed` (§7), e.g. after updating the active saved search:
 * - Scoped search: replaces the whole text with `view.text`.
 * - Unscoped search: keeps `currentParsed`'s tab clauses and inserts them at rank 0 into
 *   `view.text`, so editing a search does not move the user off their current triage tab.
 *
 * Opening a saved search from the sidebar does not use this: it always replaces the whole
 * text with `view.text`, so an unscoped search opens on the implicit Inbox tab.
 */
export function reapplySavedSearchText(
  currentParsed: ParsedQuery,
  view: SavedSearchView
): string {
  if (view.hasScope) {
    return view.text;
  }
  const tabs = tabClauses(currentParsed);
  if (tabs.length === 0) {
    return view.text;
  }
  const tabRaw = tabs.map((c) => c.raw).join(' ');
  return insertClause(view.text, view.parsed, tabRaw, 0);
}

/**
 * Suggests a default name for a query when saving (§2.2):
 * - If the query, after removing tab clauses (§7), has no parse issues and is a single
 *   non-negated single-value `repo:` clause, returns that repository name (`owner/name`).
 * - Otherwise returns the trimmed query text truncated to 40 characters with an ellipsis (`…`).
 */
export function suggestName(parsedOrText: ParsedQuery | string): string {
  const parsed = typeof parsedOrText === 'string' ? parseQuery(parsedOrText) : parsedOrText;
  const tabs = new Set(tabClauses(parsed));
  const remaining = parsed.clauses.filter((c) => !tabs.has(c));
  if (parsed.issues.length === 0 && remaining.length === 1) {
    const only = remaining[0];
    if (
      only.status === 'ok' &&
      only.predicate !== null &&
      only.predicate.field === Field.REPO &&
      !only.predicate.negated &&
      only.predicate.values.length === 1
    ) {
      return only.predicate.values[0];
    }
  }
  const text = parsed.text.trim();
  const chars = Array.from(text);
  if (chars.length <= SUGGESTED_NAME_MAX_LENGTH) {
    return text;
  }
  return `${chars.slice(0, SUGGESTED_NAME_MAX_LENGTH - 1).join('')}…`;
}

/** Pure array reorder: moves the item at `from` to index `to`, returning a new array. */
export function moveItem<T = string>(items: readonly T[], from: number, to: number): T[] {
  if (
    from < 0 ||
    from >= items.length ||
    to < 0 ||
    to >= items.length ||
    from === to
  ) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

const SORT_PREVIEW_LABELS: Readonly<Record<SortOption, string>> = {
  updated: 'Latest activity',
  acked: 'Last acked',
  created: 'Creation date',
};

/** Human-readable sort description for the modal and sidebar edit mode (§2.2, §2.4). */
export function formatSavedSearchSort(sort: SortOption, order: SortOrder): string {
  const direction = order === 'asc' ? 'oldest first' : 'newest first';
  return `${SORT_PREVIEW_LABELS[sort]}, ${direction}`;
}

export function isDefaultSavedSearchSort(sort: SortOption, order: SortOrder): boolean {
  return sort === DEFAULT_QUERY_STATE.sort && order === DEFAULT_QUERY_STATE.order;
}

/**
 * Client-side validation for a saved search name (§5.3, §2.2, §2.4).
 * Returns an error message, or `null` when valid.
 */
export function validateSavedSearchName(
  name: string,
  existing: readonly { readonly id: string; readonly name: string }[] = [],
  selfId?: string
): string | null {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return 'Name cannot contain control characters.';
    }
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Name is required.';
  }
  if (Array.from(trimmed).length > MAX_SAVED_SEARCH_NAME_LENGTH) {
    return `Name cannot exceed ${MAX_SAVED_SEARCH_NAME_LENGTH} characters.`;
  }
  const duplicate = existing.some(
    (s) => s.id !== selfId && s.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (duplicate) {
    return 'A saved search with this name already exists.';
  }
  return null;
}
