import { useState, useEffect, useCallback, useMemo } from 'react';
import { Field } from '../api/octodeck/v1/query_pb';
import {
  DEFAULT_QUERY_STATE,
  type ControlKey,
  type DashboardQueryState,
  type FilterControls,
  type SortOption,
  type SortOrder,
  type TriageFilter,
} from '../types/filters';
import { parseDashboardUrl, serializeDashboardUrl } from '../logic/query/urlCodec';
import {
  activeQueryCount,
  isDefaultQuery,
  projectClauses,
  workflowState,
  type ExtraPredicate,
} from '../logic/query/predicates';
import { parseQuery, type ParsedQuery } from '../logic/query/syntax';
import {
  removeClause,
  removeClauseInText,
  setControlInText,
  setTriageTabInText,
  toggleAssignedToMeInText,
  toggleRepoInText,
} from '../logic/query/textEdit';
import { SEARCH_DEBOUNCE_MS } from './useDashboardData';

export type QueryEditKind = 'typing' | 'edit';

interface InternalState {
  readonly state: DashboardQueryState;
  readonly requestText: string;
  readonly kind: QueryEditKind;
}

function readLocationUrl(): { state: DashboardQueryState; canonicalSearch: string } {
  if (typeof window === 'undefined') {
    return { state: DEFAULT_QUERY_STATE, canonicalSearch: '' };
  }
  return parseDashboardUrl(window.location.search);
}

function rewriteIfNonCanonical(canonicalSearch: string): void {
  if (typeof window === 'undefined' || !window.history) return;
  const expectedSearch = canonicalSearch ? `?${canonicalSearch}` : '';
  if (window.location.search !== expectedSearch) {
    const targetUrl = `${window.location.pathname}${expectedSearch}${window.location.hash || ''}`;
    try {
      window.history.replaceState(null, '', targetUrl);
    } catch (e) {
      console.warn('Failed to update browser history with filter state', e);
    }
  }
}

function clearSecondaryInText(text: string, parsed: ParsedQuery): string {
  const { owners } = projectClauses(parsed);
  let current = text;
  for (let i = parsed.clauses.length - 1; i >= 0; i--) {
    if (i === owners.triage || i === owners.type) continue;
    if (parsed.clauses[i].kind === 'term') continue;
    current = removeClause(current, parsed.clauses[i]);
  }
  return current;
}

export interface UseDashboardFilters {
  state: DashboardQueryState;
  query: DashboardQueryState;
  parsed: ParsedQuery;
  controls: FilterControls;
  filters: FilterControls;
  extraPredicates: readonly ExtraPredicate[];
  requestText: string;
  setText: (text: string, kind?: QueryEditKind) => void;
  setControl: <K extends ControlKey>(
    key: K,
    value: FilterControls[K],
    replaceHistory?: boolean
  ) => void;
  setTriageTab: (tab: TriageFilter, replaceHistory?: boolean) => void;
  setSort: (sort: SortOption, replaceHistory?: boolean) => void;
  setOrder: (order: SortOrder, replaceHistory?: boolean) => void;
  selectItem: (id: string | null, replaceHistory?: boolean) => void;
  setFilter: <K extends keyof FilterControls>(
    key: K,
    value: FilterControls[K],
    replaceHistory?: boolean
  ) => void;
  setFilters: (partial: Partial<FilterControls>, replaceHistory?: boolean) => void;
  setOrgOrRepo: (
    kind: 'org' | 'repo',
    values: readonly string[],
    replaceHistory?: boolean
  ) => void;
  toggleAssignedToMe: (replaceHistory?: boolean) => void;
  resetFilters: () => void;
  clearQuery: () => void;
  applyWorkflowShortcut: (triage: TriageFilter) => void;
  toggleRepo: (repo: string) => void;
  clearSecondaryFilters: () => void;
  removePredicateAt: (index: number) => void;
  isDefault: boolean;
  activeCount: number;
}

/**
 * Dashboard filter state, kept in sync with the URL (`?q=...`).
 * The state of record is the query text (`state.text`); `controls` (`filters`) is a read-only
 * projection of `parsed.clauses`, and control mutations splice only the clause(s) they own.
 */
export function useDashboardFilters(): UseDashboardFilters {
  const [internal, setInternal] = useState<InternalState>(() => {
    const initial = readLocationUrl().state;
    return {
      state: initial,
      requestText: initial.text,
      kind: 'edit',
    };
  });

  // Rewrite legacy or un-normalized URLs in place on initial load and on browser Back/Forward.
  useEffect(() => {
    const initial = readLocationUrl();
    rewriteIfNonCanonical(initial.canonicalSearch);

    const handlePopState = () => {
      const next = readLocationUrl();
      rewriteIfNonCanonical(next.canonicalSearch);
      setInternal({ state: next.state, requestText: next.state.text, kind: 'edit' });
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Debounce requestText by SEARCH_DEBOUNCE_MS for 'typing' edits; 'edit' transitions update
  // requestText immediately inside applyUpdate, and cleaning up this effect cancels any pending timer.
  useEffect(() => {
    if (internal.kind !== 'typing') return;
    const timer = setTimeout(() => {
      setInternal((prev) =>
        prev.requestText === prev.state.text
          ? prev
          : { ...prev, requestText: prev.state.text }
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [internal.state.text, internal.kind]);

  const syncUrl = useCallback((next: DashboardQueryState, replaceHistory: boolean) => {
    if (typeof window === 'undefined' || !window.history) return;

    try {
      const searchStr = serializeDashboardUrl(next);
      const newSearch = searchStr ? `?${searchStr}` : '';
      const currentPath = window.location.pathname;
      const currentSearch = window.location.search;
      const hash = window.location.hash || '';

      if (currentSearch !== newSearch) {
        const targetUrl = `${currentPath}${newSearch}${hash}`;
        if (replaceHistory) {
          window.history.replaceState(null, '', targetUrl);
        } else {
          window.history.pushState(null, '', targetUrl);
        }
      }
    } catch (e) {
      console.warn('Failed to update browser history with filter state', e);
    }
  }, []);

  const applyUpdate = useCallback(
    (fn: (prev: DashboardQueryState) => DashboardQueryState, kind: QueryEditKind) => {
      setInternal((prev) => {
        const next = fn(prev.state);
        syncUrl(next, kind === 'typing');
        return {
          state: next,
          requestText: kind === 'edit' ? next.text : prev.requestText,
          kind,
        };
      });
    },
    [syncUrl]
  );

  const setText = useCallback(
    (text: string, kind: QueryEditKind = 'typing') => {
      applyUpdate((prev) => ({ ...prev, text }), kind);
    },
    [applyUpdate]
  );

  const setTriageTab = useCallback(
    (tab: TriageFilter, replaceHistory = false) => {
      applyUpdate(
        (prev) => ({
          ...prev,
          text: setTriageTabInText(prev.text, parseQuery(prev.text), tab),
        }),
        replaceHistory ? 'typing' : 'edit'
      );
    },
    [applyUpdate]
  );

  const setControl = useCallback(
    <K extends ControlKey>(key: K, value: FilterControls[K], replaceHistory = false) => {
      applyUpdate(
        (prev) => ({
          ...prev,
          text: setControlInText(prev.text, parseQuery(prev.text), key, value),
        }),
        replaceHistory ? 'typing' : 'edit'
      );
    },
    [applyUpdate]
  );

  const setSort = useCallback(
    (sort: SortOption, replaceHistory = false) => {
      applyUpdate((prev) => ({ ...prev, sort }), replaceHistory ? 'typing' : 'edit');
    },
    [applyUpdate]
  );

  const setOrder = useCallback(
    (order: SortOrder, replaceHistory = false) => {
      applyUpdate((prev) => ({ ...prev, order }), replaceHistory ? 'typing' : 'edit');
    },
    [applyUpdate]
  );

  const selectItem = useCallback(
    (id: string | null, replaceHistory = false) => {
      applyUpdate(
        (prev) => ({ ...prev, item: id?.trim() || null }),
        replaceHistory ? 'typing' : 'edit'
      );
    },
    [applyUpdate]
  );

  const setFilter = useCallback(
    <K extends keyof FilterControls>(
      key: K,
      value: FilterControls[K],
      replaceHistory = false
    ) => {
      if (key === 'sort') {
        setSort(value as SortOption, replaceHistory);
      } else if (key === 'order') {
        setOrder(value as SortOrder, replaceHistory);
      } else if (key === 'item') {
        selectItem((value as string | null) || null, replaceHistory);
      } else if (key === 'triage') {
        setTriageTab(value as TriageFilter, replaceHistory);
      } else {
        setControl(key as ControlKey, value as FilterControls[ControlKey], replaceHistory);
      }
    },
    [setSort, setOrder, selectItem, setTriageTab, setControl]
  );

  const setFilters = useCallback(
    (partial: Partial<FilterControls>, replaceHistory = false) => {
      applyUpdate((prev) => {
        let next = prev;
        for (const key of Object.keys(partial) as (keyof FilterControls)[]) {
          const value = partial[key];
          if (key === 'sort') {
            next = { ...next, sort: value as SortOption };
          } else if (key === 'order') {
            next = { ...next, order: value as SortOrder };
          } else if (key === 'item') {
            next = { ...next, item: (value as string | null)?.trim() || null };
          } else if (key === 'triage') {
            next = {
              ...next,
              text: setTriageTabInText(next.text, parseQuery(next.text), value as TriageFilter),
            };
          } else {
            const cKey = key as ControlKey;
            next = {
              ...next,
              text: setControlInText(
                next.text,
                parseQuery(next.text),
                cKey,
                value as FilterControls[typeof cKey]
              ),
            };
          }
        }
        return next;
      }, replaceHistory ? 'typing' : 'edit');
    },
    [applyUpdate]
  );

  const setOrgOrRepo = useCallback(
    (kind: 'org' | 'repo', values: readonly string[], replaceHistory = false) => {
      applyUpdate(
        (prev) => ({
          ...prev,
          text: setControlInText(prev.text, parseQuery(prev.text), kind, values),
        }),
        replaceHistory ? 'typing' : 'edit'
      );
    },
    [applyUpdate]
  );

  const toggleAssignedToMe = useCallback(
    (replaceHistory = false) => {
      applyUpdate(
        (prev) => ({
          ...prev,
          text: toggleAssignedToMeInText(prev.text, parseQuery(prev.text)),
        }),
        replaceHistory ? 'typing' : 'edit'
      );
    },
    [applyUpdate]
  );

  const clearQuery = useCallback(() => {
    applyUpdate((prev) => ({ ...prev, text: '' }), 'edit');
  }, [applyUpdate]);

  const resetFilters = useCallback(() => {
    applyUpdate(() => DEFAULT_QUERY_STATE, 'edit');
  }, [applyUpdate]);

  const applyWorkflowShortcut = useCallback(
    (triage: TriageFilter) => {
      applyUpdate(() => workflowState(triage), 'edit');
    },
    [applyUpdate]
  );

  const toggleRepo = useCallback(
    (repo: string) => {
      applyUpdate(
        (prev) => ({
          ...prev,
          text: toggleRepoInText(prev.text, parseQuery(prev.text), repo),
        }),
        'edit'
      );
    },
    [applyUpdate]
  );

  const clearSecondaryFilters = useCallback(() => {
    applyUpdate(
      (prev) => ({
        ...prev,
        text: clearSecondaryInText(prev.text, parseQuery(prev.text)),
      }),
      'edit'
    );
  }, [applyUpdate]);

  const removePredicateAt = useCallback(
    (index: number) => {
      applyUpdate(
        (prev) => ({
          ...prev,
          text: removeClauseInText(prev.text, parseQuery(prev.text), index),
        }),
        'edit'
      );
    },
    [applyUpdate]
  );

  const state = internal.state;
  const requestText = internal.requestText;
  const parsed = useMemo(() => parseQuery(state.text), [state.text]);
  const projection = useMemo(
    () =>
      projectClauses(parsed, {
        sort: state.sort,
        order: state.order,
        item: state.item,
      }),
    [parsed, state.sort, state.order, state.item]
  );
  const controls = projection.controls;
  const extraPredicates = useMemo(
    () => projection.extras.filter((e) => e.predicate.field !== Field.TEXT),
    [projection.extras]
  );
  const isDefault = useMemo(() => isDefaultQuery(state), [state]);
  const activeCount = useMemo(() => activeQueryCount(state, parsed), [state, parsed]);

  return {
    state,
    query: state,
    parsed,
    controls,
    filters: controls,
    extraPredicates,
    requestText,
    setText,
    setControl,
    setTriageTab,
    setSort,
    setOrder,
    selectItem,
    setFilter,
    setFilters,
    setOrgOrRepo,
    toggleAssignedToMe,
    resetFilters,
    clearQuery,
    applyWorkflowShortcut,
    toggleRepo,
    clearSecondaryFilters,
    removePredicateAt,
    isDefault,
    activeCount,
  };
}
