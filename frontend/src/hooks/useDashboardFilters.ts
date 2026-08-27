import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  type DashboardFilterState,
  type TriageFilter,
  DEFAULT_FILTER_STATE,
} from '../types/filters';
import {
  parseFilterParams,
  filterStateToSearchParams,
  isDefaultFilterState,
  getActiveFilterCount,
} from '../logic/filterEngine';

function getInitialFilters(): DashboardFilterState {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_FILTER_STATE };
  }
  return parseFilterParams(window.location.search);
}

export function useDashboardFilters() {
  const [filters, setFiltersInternal] = useState<DashboardFilterState>(getInitialFilters);

  // Sync state when browser Back/Forward (popstate) occurs
  useEffect(() => {
    const handlePopState = () => {
      setFiltersInternal(getInitialFilters());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Update browser URL query parameters
  const syncUrl = useCallback((newFilters: DashboardFilterState, replaceHistory = false) => {
    if (typeof window === 'undefined' || !window.history) return;

    try {
      const searchParams = filterStateToSearchParams(newFilters);
      const searchStr = searchParams.toString();
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

  const setFilters = useCallback(
    (partial: Partial<DashboardFilterState>, replaceHistory = false) => {
      setFiltersInternal(prev => {
        const next = { ...prev, ...partial };
        syncUrl(next, replaceHistory);
        return next;
      });
    },
    [syncUrl]
  );

  const setFilter = useCallback(
    <K extends keyof DashboardFilterState>(
      key: K,
      value: DashboardFilterState[K],
      replaceHistory = false
    ) => {
      setFilters({ [key]: value }, replaceHistory);
    },
    [setFilters]
  );

  const resetFilters = useCallback(() => {
    const defaultState = { ...DEFAULT_FILTER_STATE };
    setFiltersInternal(defaultState);
    syncUrl(defaultState, false);
  }, [syncUrl]);

  // Sidebar shortcut for top-level workflow: resets other filters to defaults
  const applyWorkflowShortcut = useCallback(
    (triage: TriageFilter) => {
      const nextState: DashboardFilterState = {
        ...DEFAULT_FILTER_STATE,
        triage,
      };
      setFiltersInternal(nextState);
      syncUrl(nextState, false);
    },
    [syncUrl]
  );

  // Sidebar shortcut for repo toggle
  const toggleRepo = useCallback(
    (repo: string) => {
      setFiltersInternal(prev => {
        const next: DashboardFilterState = {
          ...prev,
          repo: prev.repo === repo ? null : repo,
          org: null, // Clear org when toggling a specific repo
        };
        syncUrl(next, false);
        return next;
      });
    },
    [syncUrl]
  );

  const isDefault = useMemo(() => isDefaultFilterState(filters), [filters]);
  const activeCount = useMemo(() => getActiveFilterCount(filters), [filters]);

  return {
    filters,
    setFilter,
    setFilters,
    resetFilters,
    applyWorkflowShortcut,
    toggleRepo,
    isDefault,
    activeCount,
  };
}
