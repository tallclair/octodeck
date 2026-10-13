import type { Field } from '../api/octodeck/v1/query_pb';

export type TriageFilter = 'inbox' | 'activity' | 'acked' | 'all';
export type ActivityValue = 'any' | 'item' | 'mention' | 'comment' | 'code' | 'noise';
export type ItemStateFilter = 'open' | 'closed' | 'merged' | 'all';
export type ItemTypeFilter = 'all' | 'pr' | 'issue';
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
 * The dashboard query state of record (Phase 2 §4).
 * `text` is the query string written to `?q=`; predicates, Expr, and control states are derived from it.
 */
export interface DashboardQueryState {
  readonly text: string;
  readonly sort: SortOption;
  readonly order: SortOrder;
  /** Selected item (details pane). Not part of the query. */
  readonly item: string | null;
}

export const DEFAULT_QUERY_STATE: Readonly<DashboardQueryState> = Object.freeze({
  text: '',
  sort: 'updated',
  order: 'desc',
  item: null,
});

const EMPTY_STRINGS: readonly string[] = Object.freeze([]);
const EMPTY_ACTIVITIES: readonly ActivityValue[] = Object.freeze([]);

/**
 * Read-only projection of the parsed query clauses onto the dashboard's filter controls.
 * Clauses that no control can display (negation, second clause of the same field, or
 * fields without a control) are reported separately as extra predicates.
 */
export interface FilterControls {
  triage: TriageFilter;
  state: ItemStateFilter;
  type: ItemTypeFilter;
  tracking: TrackingFilter;
  org: readonly string[];
  repo: readonly string[];
  author: readonly string[];
  assignee: readonly string[];
  milestone: readonly string[];
  label: readonly string[];
  activity: readonly ActivityValue[];
  sort: SortOption;
  order: SortOrder;
  item: string | null;
}

export const DEFAULT_FILTER_CONTROLS: Readonly<FilterControls> = Object.freeze({
  triage: 'inbox',
  state: 'all',
  type: 'all',
  tracking: 'all',
  org: EMPTY_STRINGS,
  repo: EMPTY_STRINGS,
  author: EMPTY_STRINGS,
  assignee: EMPTY_STRINGS,
  milestone: EMPTY_STRINGS,
  label: EMPTY_STRINGS,
  activity: EMPTY_ACTIVITIES,
  sort: 'updated',
  order: 'desc',
  item: null,
});

/** Controls backed by clauses (every FilterControls key except the non-query tail). */
export type ControlKey = Exclude<keyof FilterControls, 'sort' | 'order' | 'item'>;
