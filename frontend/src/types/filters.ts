import type { Field } from '../api/octodeck/v1/query_pb';

export type TriageFilter = 'inbox' | 'activity' | 'acked' | 'all';
export type ItemStateFilter = 'open' | 'closed' | 'all';
export type ItemTypeFilter = 'all' | 'pr' | 'issue';
export type AssignedFilter = 'all' | 'me';
export type TrackingFilter = 'all' | 'tracked' | 'untracked';
export type SortOption = 'updated' | 'acked' | 'created';
export type SortOrder = 'asc' | 'desc';

/**
 * One structured filter condition, sent to the daemon as an Expr predicate.
 * Values are ORed (`field:v1,v2`); `negated` negates the whole OR (`-field:v1,v2`).
 */
export interface FilterPredicate {
  readonly field: Field;
  readonly values: readonly string[];
  readonly negated: boolean;
}

/**
 * The dashboard query state of record. Predicates are ANDed and keep the order in which they
 * appeared in the URL (new predicates are inserted at their canonical position).
 */
export interface DashboardQueryState {
  readonly predicates: readonly FilterPredicate[];
  /** Raw search-box text. It is split into one TEXT predicate per word or quoted phrase. */
  readonly q: string;
  readonly sort: SortOption;
  readonly order: SortOrder;
  /** Selected item (details pane). Not part of the query. */
  readonly item: string | null;
}

export const DEFAULT_QUERY_STATE: Readonly<DashboardQueryState> = Object.freeze({
  predicates: Object.freeze([]) as readonly FilterPredicate[],
  q: '',
  sort: 'updated',
  order: 'desc',
  item: null,
});

/**
 * Read-only projection of the predicate list onto the dashboard's single-select controls.
 * Predicates that no control can display (multiple values, negation, fields without a control)
 * are reported separately as extra predicates.
 */
export interface FilterControls {
  triage: TriageFilter;
  state: ItemStateFilter;
  type: ItemTypeFilter;
  assigned: AssignedFilter;
  tracking: TrackingFilter;
  org: string | null;
  repo: string | null;
  author: string | null;
  milestone: string | null;
  label: string | null;
  q: string;
  sort: SortOption;
  order: SortOrder;
  item: string | null;
}

export const DEFAULT_FILTER_CONTROLS: Readonly<FilterControls> = Object.freeze({
  triage: 'inbox',
  state: 'all',
  type: 'all',
  assigned: 'all',
  tracking: 'all',
  org: null,
  repo: null,
  author: null,
  milestone: null,
  label: null,
  q: '',
  sort: 'updated',
  order: 'desc',
  item: null,
});
