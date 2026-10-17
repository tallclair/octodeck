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
import type { ParsedQuery } from './syntax/types';

export type ExprInit = MessageInitShape<typeof ExprSchema>;
export type SortInit = MessageInitShape<typeof SortSchema>;

export function predicateExpr(p: FilterPredicate): ExprInit {
  return { kind: { case: 'predicate', value: { field: p.field, values: [...p.values], negated: p.negated } } };
}

export function andExpr(predicates: readonly FilterPredicate[]): ExprInit {
  return { kind: { case: 'and', value: { exprs: predicates.map(predicateExpr) } } };
}

/**
 * The dashboard query as an Expr: an AND of the valid predicates in clause order.
 * Incomplete and error clauses are omitted from parsed.predicates so the remaining
 * valid clauses still execute against the daemon. With no triage predicate the daemon
 * applies the implicit triage:inbox scope.
 */
export function toExpr(parsed: ParsedQuery): ExprInit {
  return andExpr(parsed.predicates);
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

