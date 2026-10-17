// Everything the dashboard shows that comes from the daemon's item store: the item list
// (GetItems), the dropdown options and the sidebar repos and counts (GetFacets). Filtering,
// option extraction and counting all happen in the daemon (design §3.4, §5).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { useQuery } from '@connectrpc/connect-query';
import { getFacets, getItem, getItems } from '../api/octodeck/v1/service-OctoDeckService_connectquery';
import { Field, type CountResult, type FacetValue } from '../api/octodeck/v1/query_pb';
import type { Item } from '../api/octodeck/v1/resources_pb';
import type { DashboardQueryState } from '../types/filters';
import { toExpr, toSort, type ExprInit } from '../logic/query/expr';
import { formatPredicates, parseQuery } from '../logic/query/syntax';
import { serializeDashboardUrl } from '../logic/query/urlCodec';
import {
  buildSidebar,
  countOf,
  countsByValue,
  facetValues,
  newCountOf,
  valuesWithNew,
  type SidebarRepoSort,
} from '../logic/query/facets';
import { exprErrorOf, isConnectivityError } from '../api/errors';
import { mapServerErrorToRequest } from '../logic/query/predicates';

/** Polling cadence for every list/facet query (the list's cadence before the migration). */
const POLL = { refetchInterval: 3000, staleTime: 1000 } as const;
/** Search-box typing is debounced before it becomes part of the query. */
export const SEARCH_DEBOUNCE_MS = 200;

/** Facets for the dropdowns: one call for every selector field (one evaluation pass in the daemon). */
const SELECTOR_FIELDS = [
  Field.REPO,
  Field.ORG,
  Field.AUTHOR,
  Field.ASSIGNEE,
  Field.MILESTONE,
  Field.LABEL,
  Field.NEW,
];
/** Facets for the sidebar: the repo list with inbox/new counts, and inbox/acked/new totals. */
const SIDEBAR_FIELDS = [Field.REPO, Field.TRIAGE];

const NO_ITEMS: Item[] = [];
const NO_COUNTS: CountResult[] = [];
const NO_SAVED_QUERIES: readonly ExprInit[] = [];

export interface SelectorFacets {
  readonly repos: readonly FacetValue[];
  readonly orgs: readonly FacetValue[];
  readonly authors: readonly FacetValue[];
  readonly assignees: readonly FacetValue[];
  readonly milestones: readonly FacetValue[];
  readonly labels: readonly FacetValue[];
  readonly activity: readonly FacetValue[];
}

export interface DashboardDataOptions {
  query: DashboardQueryState;
  requestText: string;
  savedSearchQueries?: readonly ExprInit[];
  savedSearchesReady?: boolean;
  repoSortMode?: SidebarRepoSort;
}

function matchesSelection(item: Item, selectedId: string): boolean {
  return item.id === selectedId || `${item.repo}#${item.number}` === selectedId;
}

export function useDashboardData({
  query,
  requestText,
  savedSearchQueries = NO_SAVED_QUERIES,
  savedSearchesReady = true,
  repoSortMode = 'alphabetical',
}: DashboardDataOptions) {
  const requestParsed = useMemo(() => parseQuery(requestText), [requestText]);
  const expr = useMemo(() => toExpr(requestParsed), [requestParsed]);
  const sort = useMemo(() => toSort(query.sort, query.order), [query.sort, query.order]);
  // Identifies the request (valid predicates + sort), independent of the selected item
  // and independent of incomplete/error clauses (design §8.5).
  const requestKey = useMemo(
    () =>
      serializeDashboardUrl({
        text: formatPredicates(requestParsed.predicates),
        sort: query.sort,
        order: query.order,
        item: null,
      }),
    [requestParsed.predicates, query.sort, query.order]
  );

  // Keep showing the previous result while a changed query is in flight (no loading flash).
  const itemsQ = useQuery(getItems, { query: expr, sort }, { ...POLL, placeholderData: keepPreviousData });
  const selectorQ = useQuery(
    getFacets,
    { query: expr, fields: SELECTOR_FIELDS },
    { ...POLL, placeholderData: keepPreviousData }
  );
  const sidebarRequest = useMemo(
    () => ({ fields: SIDEBAR_FIELDS, queries: [...savedSearchQueries] }),
    [savedSearchQueries]
  );
  // Unfiltered sidebar counts (repo inbox/new counts, inbox/acked/new totals, and saved-search counts) in one call.
  const sidebarQ = useQuery(getFacets, sidebarRequest, {
    ...POLL,
    placeholderData: keepPreviousData,
    enabled: savedSearchesReady,
  });

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
        needFallbackRef.current ? refetchFallback() : undefined,
      ]),
    [refetchItems, refetchSelector, refetchSidebar, refetchFallback]
  );

  const sidebarRepos = facetValues(sidebarQ.data, Field.REPO);
  const sidebarTriage = facetValues(sidebarQ.data, Field.TRIAGE);
  const sidebar = useMemo(
    () => buildSidebar(sidebarRepos, undefined, repoSortMode),
    [sidebarRepos, repoSortMode]
  );
  const repoInboxCounts = useMemo(() => countsByValue(sidebarRepos), [sidebarRepos]);
  const repoHasUnread = useMemo(() => valuesWithNew(sidebarRepos), [sidebarRepos]);
  const savedSearchCounts = sidebarQ.data?.counts ?? NO_COUNTS;
  const totals = {
    inbox: countOf(sidebarTriage, 'inbox'),
    acked: countOf(sidebarTriage, 'acked'),
    // Acked items carry no new: flags, so every new:any item is in the inbox.
    new: newCountOf(sidebarTriage, 'inbox'),
  };

  const selectorData = selectorQ.data;
  const facets: SelectorFacets = useMemo(
    () => ({
      repos: facetValues(selectorData, Field.REPO),
      orgs: facetValues(selectorData, Field.ORG),
      authors: facetValues(selectorData, Field.AUTHOR),
      assignees: facetValues(selectorData, Field.ASSIGNEE),
      milestones: facetValues(selectorData, Field.MILESTONE),
      labels: facetValues(selectorData, Field.LABEL),
      activity: facetValues(selectorData, Field.NEW),
    }),
    [selectorData]
  );

  const rawInvalidQuery = exprErrorOf(itemsQ.error) ?? exprErrorOf(selectorQ.error);
  const invalidQuery = useMemo(
    () => mapServerErrorToRequest(requestParsed, rawInvalidQuery),
    [requestParsed, rawInvalidQuery]
  );

  const queryErrors = [itemsQ.error, selectorQ.error, sidebarQ.error];
  return {
    items,
    selectedItem,
    isInitialLoading: itemsQ.isLoading,
    /** A list or facet query failed for a reason other than an invalid query. */
    hasConnectivityError: queryErrors.some(isConnectivityError),
    /** The daemon rejected the current query (shown inline, not as "Disconnected"). */
    invalidQuery,
    settledKey,
    refreshAll,
    sidebar,
    repoInboxCounts,
    repoHasUnread,
    savedSearchCounts,
    isSidebarPlaceholderData: Boolean(sidebarQ.isPlaceholderData),
    totals,
    facets,
  };
}
