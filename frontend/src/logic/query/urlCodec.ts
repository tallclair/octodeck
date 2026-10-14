// Dashboard URL <-> query state (design §8).
// Dashboard URLs carry four parameters: q, sort, order, and item.
// Legacy structured parameters (repo=, author=, triage=, -label=, assigned=me, ...)
// are decoded on load via parseLegacyParams and merged into the q query string.
import {
  DEFAULT_QUERY_STATE,
  type DashboardQueryState,
  type SortOption,
  type SortOrder,
} from '../../types/filters';
import { normalizeQuerySpacing } from './clauseDisplay';
import { parseLegacyParams } from './legacyUrl';
import { formatPredicates } from './syntax/format';

const SORT_OPTIONS: readonly SortOption[] = ['updated', 'acked', 'created'];
const SORT_ORDERS: readonly SortOrder[] = ['asc', 'desc'];

function toParams(search: string | URLSearchParams): URLSearchParams {
  if (typeof search !== 'string') return search;
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
}

/**
 * Parses dashboard URL parameters (including legacy structured parameters) into query state
 * and returns the canonical URL search string (without a leading '?').
 */
export function parseDashboardUrl(search: string | URLSearchParams): {
  state: DashboardQueryState;
  canonicalSearch: string;
} {
  const params = toParams(search);
  const legacy = parseLegacyParams(params);
  const q = params.get('q') ?? '';
  const joined = [formatPredicates(legacy), q].join(' ');
  const text = normalizeQuerySpacing(joined);

  const rawSort = params.get('sort')?.toLowerCase();
  const rawOrder = params.get('order')?.toLowerCase();
  const state: DashboardQueryState = {
    text,
    sort: SORT_OPTIONS.find((s) => s === rawSort) ?? DEFAULT_QUERY_STATE.sort,
    order: SORT_ORDERS.find((o) => o === rawOrder) ?? DEFAULT_QUERY_STATE.order,
    item: params.get('item')?.trim() || null,
  };

  return {
    state,
    canonicalSearch: serializeDashboardUrl(state),
  };
}

/** Serializes query state to URL parameters (without a leading '?'). Defaults are omitted. */
export function serializeDashboardUrl(state: DashboardQueryState): string {
  const params = new URLSearchParams();
  const q = state.text.trim();
  if (q) params.append('q', q);
  if (state.sort !== DEFAULT_QUERY_STATE.sort) params.append('sort', state.sort);
  if (state.order !== DEFAULT_QUERY_STATE.order) params.append('order', state.order);
  if (state.item) params.append('item', state.item);

  // URLSearchParams escapes '/', ':', '@' and ',', which are legal in a query string (RFC 3986).
  // Leaving them readable keeps links such as ?q=repo:a/b+label:x,y+author:@me unchanged.
  return params
    .toString()
    .replace(/%2F/gi, '/')
    .replace(/%3A/gi, ':')
    .replace(/%40/gi, '@')
    .replace(/%2C/gi, ',');
}
