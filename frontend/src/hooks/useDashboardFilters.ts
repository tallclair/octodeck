import { useState, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
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
} from '../logic/query/predicates';
import { parseQuery, type ParsedQuery } from '../logic/query/syntax';
import {
  setControlInText,
  setTriageTabInText,
  toggleAssignedToMeInText,
  toggleRepoInText,
} from '../logic/query/textEdit';
import {
  isActive,
  reapplySavedSearchText,
  tabClauses,
  type SavedSearchView,
} from '../logic/savedSearches';
import { SEARCH_DEBOUNCE_MS } from './useDashboardData';

export type QueryEditKind = 'typing' | 'edit';
export type UrlSyncMode = 'push' | 'replace' | 'none';

interface InternalState {
  readonly state: DashboardQueryState;
  readonly requestText: string;
  readonly kind: QueryEditKind;
  readonly urlMode: UrlSyncMode;
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

export interface UseDashboardFilters {
  state: DashboardQueryState;
  parsed: ParsedQuery;
  controls: FilterControls;
  /** Text used for requests: debounced while typing, immediate for other edits. */
  requestText: string;
  setText: (text: string, kind?: QueryEditKind) => void;
  setControl: <K extends ControlKey>(key: K, value: FilterControls[K]) => void;
  setTriageTab: (tab: TriageFilter) => void;
  setSort: (sort: SortOption) => void;
  setOrder: (order: SortOrder) => void;
  selectItem: (id: string | null) => void;
  toggleAssignedToMe: () => void;
  clearQuery: () => void;
  applyWorkflowShortcut: (triage: TriageFilter) => void;
  toggleRepo: (repo: string) => void;
  openSavedSearch: (view: SavedSearchView) => void;
  applySavedSearch: (view: SavedSearchView) => void;
  hasNoSecondaryFilters: boolean;
  isDefault: boolean;
  activeCount: number;
}

/**
 * Dashboard filter state, kept in sync with the URL (`?q=...`).
 * The state of record is the query text (`state.text`); `controls` is a read-only
 * projection of `parsed.clauses`, and control mutations splice only the clause(s) they own.
 */
export function useDashboardFilters(): UseDashboardFilters {
  const [internal, setInternal] = useState<InternalState>(() => {
    const initial = readLocationUrl().state;
    return {
      state: initial,
      requestText: initial.text,
      kind: 'edit',
      urlMode: 'none',
    };
  });

  // Rewrite legacy or un-normalized URLs in place on initial load and on browser Back/Forward.
  useEffect(() => {
    const initial = readLocationUrl();
    rewriteIfNonCanonical(initial.canonicalSearch);

    const handlePopState = () => {
      const next = readLocationUrl();
      rewriteIfNonCanonical(next.canonicalSearch);
      setInternal({
        state: next.state,
        requestText: next.state.text,
        kind: 'edit',
        urlMode: 'none',
      });
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Sync browser URL history after state transitions commit, keeping state updaters pure.
  useLayoutEffect(() => {
    if (internal.urlMode === 'none') return;
    if (typeof window === 'undefined' || !window.history) return;

    try {
      const searchStr = serializeDashboardUrl(internal.state);
      const newSearch = searchStr ? `?${searchStr}` : '';
      const currentPath = window.location.pathname;
      const currentSearch = window.location.search;
      const hash = window.location.hash || '';

      if (currentSearch !== newSearch) {
        const targetUrl = `${currentPath}${newSearch}${hash}`;
        if (internal.urlMode === 'replace') {
          window.history.replaceState(null, '', targetUrl);
        } else {
          window.history.pushState(null, '', targetUrl);
        }
      }
    } catch (e) {
      console.warn('Failed to update browser history with filter state', e);
    }
  }, [internal]);

  // Debounce requestText by SEARCH_DEBOUNCE_MS for 'typing' edits; 'edit' transitions update
  // requestText immediately inside applyUpdate, and cleaning up this effect cancels any pending timer.
  useEffect(() => {
    if (internal.kind !== 'typing') return;
    const timer = setTimeout(() => {
      setInternal((prev) =>
        prev.requestText === prev.state.text
          ? prev
          : { ...prev, requestText: prev.state.text, urlMode: 'none' }
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [internal.state.text, internal.kind]);

  const applyUpdate = useCallback(
    (fn: (prev: DashboardQueryState) => DashboardQueryState, kind: QueryEditKind) => {
      setInternal((prev) => {
        const next = fn(prev.state);
        return {
          state: next,
          requestText: kind === 'edit' ? next.text : prev.requestText,
          kind,
          urlMode: kind === 'typing' ? 'replace' : 'push',
        };
      });
    },
    []
  );

  const setText = useCallback(
    (text: string, kind: QueryEditKind = 'typing') => {
      applyUpdate((prev) => ({ ...prev, text }), kind);
    },
    [applyUpdate]
  );

  const setTriageTab = useCallback(
    (tab: TriageFilter) => {
      applyUpdate(
        (prev) => ({
          ...prev,
          text: setTriageTabInText(prev.text, parseQuery(prev.text), tab),
        }),
        'edit'
      );
    },
    [applyUpdate]
  );

  const setControl = useCallback(
    <K extends ControlKey>(key: K, value: FilterControls[K]) => {
      applyUpdate(
        (prev) => ({
          ...prev,
          text: setControlInText(prev.text, parseQuery(prev.text), key, value),
        }),
        'edit'
      );
    },
    [applyUpdate]
  );

  const setSort = useCallback(
    (sort: SortOption) => {
      applyUpdate((prev) => ({ ...prev, sort }), 'edit');
    },
    [applyUpdate]
  );

  const setOrder = useCallback(
    (order: SortOrder) => {
      applyUpdate((prev) => ({ ...prev, order }), 'edit');
    },
    [applyUpdate]
  );

  const selectItem = useCallback(
    (id: string | null) => {
      applyUpdate((prev) => ({ ...prev, item: id?.trim() || null }), 'edit');
    },
    [applyUpdate]
  );

  const toggleAssignedToMe = useCallback(() => {
    applyUpdate(
      (prev) => ({
        ...prev,
        text: toggleAssignedToMeInText(prev.text, parseQuery(prev.text)),
      }),
      'edit'
    );
  }, [applyUpdate]);

  const clearQuery = useCallback(() => {
    applyUpdate((prev) => ({ ...prev, text: '' }), 'edit');
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

  const openSavedSearch = useCallback(
    (view: SavedSearchView) => {
      applyUpdate((prev) => {
        const currentParsed = parseQuery(prev.text);
        if (isActive(currentParsed, view)) {
          const tabs = tabClauses(currentParsed);
          return {
            ...prev,
            text: tabs.map((c) => c.raw).join(' '),
            sort: DEFAULT_QUERY_STATE.sort,
            order: DEFAULT_QUERY_STATE.order,
          };
        }
        return {
          ...prev,
          text: view.text,
          sort: view.sort,
          order: view.order,
        };
      }, 'edit');
    },
    [applyUpdate]
  );

  const applySavedSearch = useCallback(
    (view: SavedSearchView) => {
      applyUpdate((prev) => {
        const currentParsed = parseQuery(prev.text);
        return {
          ...prev,
          text: reapplySavedSearchText(currentParsed, view),
          sort: view.sort,
          order: view.order,
        };
      }, 'edit');
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
  const hasNoSecondaryFilters =
    parsed.predicates.length === (projection.owners.triage !== undefined ? 1 : 0);
  const isDefault = useMemo(() => isDefaultQuery(state), [state]);
  const activeCount = useMemo(() => activeQueryCount(state, parsed), [state, parsed]);

  return {
    state,
    parsed,
    controls,
    requestText,
    setText,
    setControl,
    setTriageTab,
    setSort,
    setOrder,
    selectItem,
    toggleAssignedToMe,
    clearQuery,
    applyWorkflowShortcut,
    toggleRepo,
    openSavedSearch,
    applySavedSearch,
    hasNoSecondaryFilters,
    isDefault,
    activeCount,
  };
}

