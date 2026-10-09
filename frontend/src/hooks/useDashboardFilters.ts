import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  DEFAULT_QUERY_STATE,
  type DashboardQueryState,
  type FilterControls,
  type TriageFilter,
} from '../types/filters';
import { parseQueryParams, serializeQueryParams } from '../logic/query/urlCodec';
import {
  activeQueryCount,
  applyControls,
  clearSecondary,
  isDefaultQuery,
  projectControls,
  removePredicate,
  setControl,
  toggleRepo as toggleRepoOp,
  workflowState,
} from '../logic/query/predicates';

function getInitialQuery(): DashboardQueryState {
  if (typeof window === 'undefined') {
    return DEFAULT_QUERY_STATE;
  }
  return parseQueryParams(window.location.search);
}

/**
 * Dashboard filter state, kept in sync with the URL. The state of record is a list of predicates
 * (`query`); `filters` is a read-only projection onto the single-select controls, and
 * `extraPredicates` lists the predicates no control can show (e.g. from hand-written URLs).
 */
export function useDashboardFilters() {
  const [query, setQuery] = useState<DashboardQueryState>(getInitialQuery);

  // Sync state when browser Back/Forward (popstate) occurs
  useEffect(() => {
    const handlePopState = () => {
      setQuery(getInitialQuery());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Update browser URL query parameters
  const syncUrl = useCallback((next: DashboardQueryState, replaceHistory = false) => {
    if (typeof window === 'undefined' || !window.history) return;

    try {
      const searchStr = serializeQueryParams(next);
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

  const update = useCallback(
    (fn: (prev: DashboardQueryState) => DashboardQueryState, replaceHistory = false) => {
      setQuery(prev => {
        const next = fn(prev);
        syncUrl(next, replaceHistory);
        return next;
      });
    },
    [syncUrl]
  );

  const replaceAll = useCallback(
    (next: DashboardQueryState) => {
      setQuery(next);
      syncUrl(next, false);
    },
    [syncUrl]
  );

  const setFilters = useCallback(
    (partial: Partial<FilterControls>, replaceHistory = false) => {
      update(s => applyControls(s, partial), replaceHistory);
    },
    [update]
  );

  const setFilter = useCallback(
    <K extends keyof FilterControls>(key: K, value: FilterControls[K], replaceHistory = false) => {
      update(s => setControl(s, key, value), replaceHistory);
    },
    [update]
  );

  const resetFilters = useCallback(() => replaceAll(DEFAULT_QUERY_STATE), [replaceAll]);

  // Sidebar shortcut for top-level workflow: resets other filters to defaults
  const applyWorkflowShortcut = useCallback(
    (triage: TriageFilter) => replaceAll(workflowState(triage)),
    [replaceAll]
  );

  // Sidebar shortcut for repo toggle (also clears org)
  const toggleRepo = useCallback((repo: string) => update(s => toggleRepoOp(s, repo)), [update]);

  // "Clear filters": keeps the triage tab, type, search text and sort.
  const clearSecondaryFilters = useCallback(() => update(clearSecondary), [update]);

  // Removes one predicate shown as a generic chip, by its index in query.predicates.
  const removePredicateAt = useCallback((index: number) => update(s => removePredicate(s, index)), [update]);

  const { controls: filters, extras: extraPredicates } = useMemo(() => projectControls(query), [query]);
  const isDefault = useMemo(() => isDefaultQuery(query), [query]);
  const activeCount = useMemo(() => activeQueryCount(query), [query]);

  return {
    query,
    filters,
    extraPredicates,
    setFilter,
    setFilters,
    resetFilters,
    applyWorkflowShortcut,
    toggleRepo,
    clearSecondaryFilters,
    removePredicateAt,
    isDefault,
    activeCount,
  };
}
