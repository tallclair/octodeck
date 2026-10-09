// Everything the dashboard shows that comes from the daemon's item store: the item list
// (GetItems), the dropdown options and the sidebar repos and counts (GetFacets). Filtering,
// option extraction and counting all happen in the daemon (design §3.4, §5).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { useQuery } from '@connectrpc/connect-query';
import { getFacets, getItem, getItems } from '../api/octodeck/v1/service-OctoDeckService_connectquery';
import { Field } from '../api/octodeck/v1/query_pb';
import type { Item } from '../api/octodeck/v1/resources_pb';
import type { DashboardQueryState, FilterControls } from '../types/filters';
import { NEW_ANY_EXPR, toExpr, toSort } from '../logic/query/expr';
import { serializeQueryParams } from '../logic/query/urlCodec';
import {
  buildLabelOptions,
  buildOptions,
  buildRepoDropdown,
  buildSidebar,
  countOf,
  countsByValue,
  facetValues,
} from '../logic/query/facets';
import { exprErrorOf, isConnectivityError } from '../api/errors';
import { useDebouncedValue } from './useDebouncedValue';

/** Polling cadence for every list/facet query (the list's cadence before the migration). */
const POLL = { refetchInterval: 3000, staleTime: 1000 } as const;
/** Search-box typing is debounced before it becomes part of the query. */
export const SEARCH_DEBOUNCE_MS = 200;

/** Facets for the dropdowns: one call for every selector field (one evaluation pass in the daemon). */
const SELECTOR_FIELDS = [Field.REPO, Field.ORG, Field.AUTHOR, Field.MILESTONE, Field.LABEL];
/** Facets for the sidebar: the repo list with inbox counts, and inbox/acked totals. */
const SIDEBAR_FIELDS = [Field.REPO, Field.TRIAGE];
const SIDEBAR_REQUEST = { fields: SIDEBAR_FIELDS };
const UNREAD_REQUEST = { query: NEW_ANY_EXPR, fields: SIDEBAR_FIELDS };

const NO_ITEMS: Item[] = [];

export interface DashboardDataOptions {
  query: DashboardQueryState;
  /** The control projection of `query` (selected values for the dropdowns). */
  filters: FilterControls;
  pinnedRepos: readonly string[];
  showAll: { repos: boolean; authors: boolean; milestones: boolean; labels: boolean };
}

function matchesSelection(item: Item, selectedId: string): boolean {
  return item.id === selectedId || `${item.repo}#${item.number}` === selectedId;
}

export function useDashboardData({ query, filters, pinnedRepos, showAll }: DashboardDataOptions) {
  const debouncedQ = useDebouncedValue(query.q, SEARCH_DEBOUNCE_MS);
  const expr = useMemo(() => toExpr(query.predicates, debouncedQ), [query.predicates, debouncedQ]);
  const sort = useMemo(() => toSort(query.sort, query.order), [query.sort, query.order]);
  // Identifies the request (query + sort), independent of the selected item.
  const requestKey = useMemo(
    () => serializeQueryParams({ ...query, q: debouncedQ, item: null }),
    [query, debouncedQ]
  );

  // Keep showing the previous result while a changed query is in flight (no loading flash).
  const itemsQ = useQuery(getItems, { query: expr, sort }, { ...POLL, placeholderData: keepPreviousData });
  const selectorQ = useQuery(
    getFacets,
    { query: expr, fields: SELECTOR_FIELDS },
    { ...POLL, placeholderData: keepPreviousData }
  );
  // Constant inputs: the unfiltered inbox and inbox items with new activity.
  const sidebarQ = useQuery(getFacets, SIDEBAR_REQUEST, POLL);
  const unreadQ = useQuery(getFacets, UNREAD_REQUEST, POLL);

  const items = itemsQ.data?.items ?? NO_ITEMS;

  // The selected item may be outside the current result (deep link, extension link): fetch it
  // directly once the item list has loaded without it, and retain the previously resolved item
  // while the fallback fetch is pending so the details pane does not flash closed.
  const selectedId = query.item;
  const inResult = useMemo(
    () => (selectedId ? items.find(i => matchesSelection(i, selectedId)) ?? null : null),
    [items, selectedId]
  );
  const needFallback = Boolean(selectedId) && !inResult && itemsQ.isSuccess;
  const fallbackQ = useQuery(
    getItem,
    { itemId: selectedId ?? '' },
    { ...POLL, enabled: needFallback, retry: false }
  );
  const resolvedSelected = inResult ?? (needFallback ? fallbackQ.data?.item ?? null : null);
  const [prevSelected, setPrevSelected] = useState<Item | null>(null);
  if (resolvedSelected && resolvedSelected !== prevSelected) {
    setPrevSelected(resolvedSelected);
  } else if (!selectedId && prevSelected !== null) {
    setPrevSelected(null);
  }
  const retainedSelected =
    selectedId && prevSelected && matchesSelection(prevSelected, selectedId) && needFallback && fallbackQ.isPending
      ? prevSelected
      : null;
  const selectedItem = resolvedSelected ?? retainedSelected;

  // The key of the data on screen: it only advances when the new query's result has arrived,
  // so scroll anchoring treats a filter change (not the arrival of its result) as a reset.
  const [settledKey, setSettledKey] = useState(requestKey);
  if (!itemsQ.isPlaceholderData && settledKey !== requestKey) {
    setSettledKey(requestKey);
  }

  const { refetch: refetchItems } = itemsQ;
  const { refetch: refetchSelector } = selectorQ;
  const { refetch: refetchSidebar } = sidebarQ;
  const { refetch: refetchUnread } = unreadQ;
  const { refetch: refetchFallback } = fallbackQ;
  // refreshAll stays stable across renders (effects depend on it); it reads whether the
  // selected-item fallback is active when it runs.
  const needFallbackRef = useRef(needFallback);
  useEffect(() => {
    needFallbackRef.current = needFallback;
  }, [needFallback]);
  const refreshAll = useCallback(
    () =>
      Promise.all([
        refetchItems(),
        refetchSelector(),
        refetchSidebar(),
        refetchUnread(),
        needFallbackRef.current ? refetchFallback() : undefined,
      ]),
    [refetchItems, refetchSelector, refetchSidebar, refetchUnread, refetchFallback]
  );

  const sidebarRepos = facetValues(sidebarQ.data, Field.REPO);
  const sidebarTriage = facetValues(sidebarQ.data, Field.TRIAGE);
  const unreadRepos = facetValues(unreadQ.data, Field.REPO);
  const unreadTriage = facetValues(unreadQ.data, Field.TRIAGE);
  const sidebar = useMemo(() => buildSidebar(sidebarRepos, pinnedRepos), [sidebarRepos, pinnedRepos]);
  const repoInboxCounts = useMemo(() => countsByValue(sidebarRepos), [sidebarRepos]);
  const repoHasUnread = useMemo(
    () => new Set(unreadRepos.filter(v => v.count > 0).map(v => v.value.toLowerCase())),
    [unreadRepos]
  );
  const totals = {
    inbox: countOf(sidebarTriage, 'inbox'),
    acked: countOf(sidebarTriage, 'acked'),
    // Acked items carry no new: flags, so every new:any item is in the inbox.
    new: countOf(unreadTriage, 'inbox'),
  };

  const selectorData = selectorQ.data;
  const options = useMemo(
    () => ({
      repos: buildRepoDropdown(
        facetValues(selectorData, Field.REPO),
        facetValues(selectorData, Field.ORG),
        { repo: filters.repo, org: filters.org },
        pinnedRepos,
        showAll.repos
      ),
      authors: buildOptions(facetValues(selectorData, Field.AUTHOR), filters.author, showAll.authors),
      milestones: buildOptions(facetValues(selectorData, Field.MILESTONE), filters.milestone, showAll.milestones),
      labels: buildLabelOptions(facetValues(selectorData, Field.LABEL), filters.label, showAll.labels),
    }),
    [
      selectorData,
      filters.repo,
      filters.org,
      filters.author,
      filters.milestone,
      filters.label,
      pinnedRepos,
      showAll.repos,
      showAll.authors,
      showAll.milestones,
      showAll.labels,
    ]
  );

  const queryErrors = [itemsQ.error, selectorQ.error, sidebarQ.error, unreadQ.error];
  return {
    items,
    selectedItem,
    isInitialLoading: itemsQ.isLoading,
    /** A list or facet query failed for a reason other than an invalid query. */
    hasConnectivityError: queryErrors.some(isConnectivityError),
    /** The daemon rejected the current query (shown inline, not as "Disconnected"). */
    invalidQuery: exprErrorOf(itemsQ.error) ?? exprErrorOf(selectorQ.error),
    settledKey,
    refreshAll,
    sidebar,
    repoInboxCounts,
    repoHasUnread,
    totals,
    options,
  };
}
