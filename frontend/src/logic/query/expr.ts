// Builds GetItems / GetFacets request parts from dashboard query state.
import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  type ExprSchema,
  Field,
  SortKey,
  SortOrder as ProtoSortOrder,
  type SortSchema,
} from '../../api/octodeck/v1/query_pb';
import type { FilterPredicate, SortOption, SortOrder } from '../../types/filters';
import { tokenizeSearch } from './textTerms';

export type ExprInit = MessageInitShape<typeof ExprSchema>;
export type SortInit = MessageInitShape<typeof SortSchema>;

export function predicateExpr(p: FilterPredicate): ExprInit {
  return { kind: { case: 'predicate', value: { field: p.field, values: [...p.values], negated: p.negated } } };
}

export function andExpr(predicates: readonly FilterPredicate[]): ExprInit {
  return { kind: { case: 'and', value: { exprs: predicates.map(predicateExpr) } } };
}

/**
 * The dashboard query as an Expr: an AND of the list predicates followed by one TEXT predicate
 * per search term. With no triage predicate the daemon applies the implicit triage:inbox scope.
 * The order is deterministic, so identical states give identical requests (and cache keys).
 */
export function toExpr(predicates: readonly FilterPredicate[], q: string): ExprInit {
  const text: FilterPredicate[] = tokenizeSearch(q).map((term) => ({ field: Field.TEXT, values: [term], negated: false }));
  return andExpr([...predicates, ...text]);
}

const SORT_KEYS: Readonly<Record<SortOption, SortKey>> = {
  updated: SortKey.UPDATED,
  acked: SortKey.ACKED,
  created: SortKey.CREATED,
};
const SORT_ORDERS: Readonly<Record<SortOrder, ProtoSortOrder>> = {
  desc: ProtoSortOrder.DESC,
  asc: ProtoSortOrder.ASC,
};

/** The sort selection as an explicit Sort (never UNSPECIFIED). */
export function toSort(sort: SortOption, order: SortOrder): SortInit {
  return { key: SORT_KEYS[sort], order: SORT_ORDERS[order] };
}

/** Every item, acked included (design §4.6): for views that list the whole cache. */
export const ALL_ITEMS_QUERY: ExprInit = predicateExpr({ field: Field.TRIAGE, values: ['all'], negated: false });

/** Inbox items with new activity: the sidebar "New" count and per-repo unread dots (design §5). */
export const NEW_ANY_EXPR: ExprInit = predicateExpr({ field: Field.NEW, values: ['any'], negated: false });
