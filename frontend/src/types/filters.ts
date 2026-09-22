export type TriageFilter = 'inbox' | 'activity' | 'acked' | 'all';
export type ItemStateFilter = 'open' | 'closed' | 'all';
export type ItemTypeFilter = 'all' | 'pr' | 'issue';
export type AssignedFilter = 'all' | 'me';
export type TrackingFilter = 'all' | 'tracked' | 'untracked';
export type SortOption = 'updated' | 'acked' | 'created';
export type SortOrder = 'asc' | 'desc';

export interface DashboardFilterState {
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

export const DEFAULT_FILTER_STATE: Readonly<DashboardFilterState> = Object.freeze({
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
