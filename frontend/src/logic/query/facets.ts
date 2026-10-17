// Shapes GetFacets responses into the dashboard's dropdown options and sidebar data.
// Facet values are case-grouped by the daemon, so comparisons here are case-insensitive.
import type { Field, FacetValue } from '../../api/octodeck/v1/query_pb';
import { RepoSortMode, type GetFacetsResponse } from '../../api/octodeck/v1/service_pb';
import type { ActivityValue } from '../../types/filters';
import { getProtoTimestampMs } from '../timeline';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
const fold = (s: string) => s.toLowerCase();

/** Values of the first facet for `field` (the response has one facet per requested field). */
export function facetValues(resp: GetFacetsResponse | undefined, field: Field): readonly FacetValue[] {
  return resp?.facets.find((f) => f.field === field)?.values ?? [];
}

/** An ordered set of display strings with case-insensitive membership (first casing wins). */
class FoldedSet {
  private readonly byKey = new Map<string, string>();
  add(value: string): void {
    if (value && !this.byKey.has(fold(value))) this.byKey.set(fold(value), value);
  }
  has(value: string): boolean {
    return this.byKey.has(fold(value));
  }
  sorted(): string[] {
    return [...this.byKey.values()].sort(byName);
  }
}

export interface OptionList<T> {
  /** Options to render: values with matches, or every value when "Show all" is on. */
  readonly list: T[];
  /** Whether "Show all" would reveal more options. */
  readonly hasMore: boolean;
}

export interface FacetOption {
  readonly value: string;
  readonly count: number;
}

/**
 * Dropdown options for an open field. By default the values with a non-zero count are shown;
 * "Show all" adds the zero-count values. The selected values are always listed (they may have no
 * matches, or be unknown to the daemon).
 */
export function buildOptions(
  values: readonly FacetValue[],
  selected: readonly string[],
  showAll: boolean
): OptionList<FacetOption> {
  const counts = countsByValue(values);
  const displayed = new FoldedSet();
  const all = new FoldedSet();
  for (const v of values) {
    all.add(v.value);
    if (v.count > 0) displayed.add(v.value);
  }
  for (const s of selected) {
    displayed.add(s);
    all.add(s);
  }
  const displayedList = displayed.sorted();
  const allList = all.sorted();
  const chosen = showAll ? allList : displayedList;
  return {
    list: chosen.map((value) => ({ value, count: counts[fold(value)] ?? 0 })),
    hasMore: allList.some((v) => !displayed.has(v)),
  };
}

export interface LabelOption extends FacetOption {
  /** Hex color without '#', or '' when unknown. */
  readonly color: string;
}

/** Label dropdown options: like buildOptions, carrying each label's color. */
export function buildLabelOptions(
  values: readonly FacetValue[],
  selected: readonly string[],
  showAll: boolean
): OptionList<LabelOption> {
  const colors = new Map<string, string>();
  for (const v of values) {
    if (!colors.has(fold(v.value))) colors.set(fold(v.value), v.color);
  }
  const base = buildOptions(values, selected, showAll);
  return {
    list: base.list.map((opt) => ({
      value: opt.value,
      count: opt.count,
      color: colors.get(fold(opt.value)) ?? '',
    })),
    hasMore: base.hasMore,
  };
}

export interface UserMenuOption {
  readonly value: string;
  readonly label?: string;
  readonly count: number;
  readonly pinned?: boolean;
}

/**
 * Author dropdown options: pins `currentUser` first as `@<login> (you)` with `value: '@me'`,
 * matching `buildAssigneeMenuOptions`.
 */
export function buildAuthorMenuOptions(
  values: readonly FacetValue[],
  selected: readonly string[],
  currentUser: string | null | undefined,
  showAll: boolean
): OptionList<UserMenuOption> {
  return buildAssigneeMenuOptions(values, selected, currentUser, showAll);
}

/**
 * Assignee dropdown options: maps `@me` in `selected` to `currentUser` (when known) so that
 * `@<currentUser> (you)` is shown as a single pinned row with `value: '@me'` and `currentUser`'s
 * facet count; when `currentUser` is unknown and `@me` is selected, shows a pinned `@me (you)` row.
 */
export function buildAssigneeMenuOptions(
  values: readonly FacetValue[],
  selected: readonly string[],
  currentUser: string | null | undefined,
  showAll: boolean
): OptionList<UserMenuOption> {
  const mappedSelected = selected.map((a) =>
    fold(a) === '@me' && currentUser ? currentUser : a
  );
  const built = buildOptions(values, mappedSelected, showAll);
  const pinned: UserMenuOption[] = [];
  const rest: UserMenuOption[] = [];
  for (const opt of built.list) {
    if (currentUser && fold(opt.value) === fold(currentUser)) {
      pinned.push({
        value: '@me',
        label: `@${opt.value} (you)`,
        count: opt.count,
        pinned: true,
      });
    } else if (fold(opt.value) === '@me') {
      pinned.push({
        value: '@me',
        label: '@me (you)',
        count: opt.count,
        pinned: true,
      });
    } else {
      rest.push(opt);
    }
  }
  return {
    list: [...pinned, ...rest],
    hasMore: built.hasMore,
  };
}

/**
 * Whether an option in the Assignee menu is ticked: the `@me` row is ticked when either `@me` or
 * `currentUser` is in `selected`.
 */
export function isAssigneeOptionSelected(
  option: { readonly value: string },
  selected: readonly string[],
  currentUser?: string | null
): boolean {
  if (fold(option.value) === '@me') {
    return (
      selected.some((s) => fold(s) === '@me') ||
      Boolean(currentUser && selected.some((s) => fold(s) === fold(currentUser)))
    );
  }
  return selected.some((s) => fold(s) === fold(option.value));
}

/**
 * Toggles an option in the Assignee menu: unticking the `@me` row removes both `@me` and
 * `currentUser` from `selected`; ticking it appends `@me` (after stripping any duplicate `@me` or
 * `currentUser`).
 */
export function toggleAssigneeOption(
  option: { readonly value: string },
  currentlySelected: boolean,
  selected: readonly string[],
  currentUser?: string | null
): string[] {
  if (fold(option.value) === '@me') {
    const withoutSelf = selected.filter(
      (a) => fold(a) !== '@me' && !(currentUser && fold(a) === fold(currentUser))
    );
    return currentlySelected ? withoutSelf : [...withoutSelf, '@me'];
  }
  return currentlySelected
    ? selected.filter((a) => fold(a) !== fold(option.value))
    : [...selected, option.value];
}

function ownerOf(repo: string): string | null {
  const slash = repo.indexOf('/');
  return slash > 0 ? repo.slice(0, slash) : null;
}

interface OrgsAndRepos {
  orgs: FoldedSet;
  repos: FoldedSet;
}

function groupByOrg(
  { orgs, repos }: OrgsAndRepos,
  repoCounts: Record<string, number>
): { orgs: string[]; reposByOrg: Record<string, FacetOption[]> } {
  const orgList = orgs.sorted();
  const reposByOrg: Record<string, FacetOption[]> = {};
  for (const org of orgList) reposByOrg[org] = [];
  for (const repo of repos.sorted()) {
    const owner = ownerOf(repo);
    const org = owner === null ? undefined : orgList.find((o) => fold(o) === fold(owner));
    if (org !== undefined) {
      reposByOrg[org].push({ value: repo, count: repoCounts[fold(repo)] ?? 0 });
    }
  }
  return { orgs: orgList, reposByOrg };
}

export interface RepoDropdown {
  readonly orgs: string[];
  readonly reposByOrg: Record<string, FacetOption[]>;
  readonly hasMore: boolean;
}

/**
 * The repository dropdown: repos grouped under org headers. Repo and org facets are requested
 * together; each excludes only its own predicates, so the org headers are the union of the org
 * facet and the owners of the listed repos. "Show all" adds zero-count values.
 */
export function buildRepoDropdown(
  repoValues: readonly FacetValue[],
  orgValues: readonly FacetValue[],
  selected: { repos: readonly string[]; orgs: readonly string[] },
  showAll: boolean
): RepoDropdown {
  const repoCounts = countsByValue(repoValues);
  const displayed: OrgsAndRepos = { orgs: new FoldedSet(), repos: new FoldedSet() };
  const all: OrgsAndRepos = { orgs: new FoldedSet(), repos: new FoldedSet() };
  const addRepo = (target: OrgsAndRepos, repo: string) => {
    const owner = ownerOf(repo);
    if (owner === null) return;
    target.repos.add(repo);
    target.orgs.add(owner);
  };

  for (const v of repoValues) {
    addRepo(all, v.value);
    if (v.count > 0) addRepo(displayed, v.value);
  }
  for (const v of orgValues) {
    all.orgs.add(v.value);
    if (v.count > 0) displayed.orgs.add(v.value);
  }
  for (const target of [displayed, all]) {
    for (const repo of selected.repos) addRepo(target, repo);
    for (const org of selected.orgs) target.orgs.add(org);
  }

  const hasMore =
    all.repos.sorted().some((r) => !displayed.repos.has(r)) ||
    all.orgs.sorted().some((o) => !displayed.orgs.has(o));
  return { ...groupByOrg(showAll ? all : displayed, repoCounts), hasMore };
}

export interface RepoMenuOption {
  readonly value: string;
  readonly count: number | null;
  readonly group: string;
  readonly isGroupHeader?: boolean;
  readonly indented?: boolean;
}

/**
 * Flattens `buildRepoDropdown` into grouped option rows for `MultiSelectMenu`: each org header
 * (`isGroupHeader: true`, `count: null`) is followed by its indented repository rows, sharing a
 * case-folded `group` key so filtering and stable option retention keep repos under their org.
 */
export function buildRepoMenuOptions(
  repoValues: readonly FacetValue[],
  orgValues: readonly FacetValue[],
  selected: { repos: readonly string[]; orgs: readonly string[] },
  showAll: boolean
): OptionList<RepoMenuOption> {
  const dropdown = buildRepoDropdown(repoValues, orgValues, selected, showAll);
  const list: RepoMenuOption[] = [];
  for (const org of dropdown.orgs) {
    const group = fold(org);
    list.push({
      value: org,
      count: null,
      group,
      isGroupHeader: true,
    });
    for (const repo of dropdown.reposByOrg[org] ?? []) {
      list.push({
        value: repo.value,
        count: repo.count,
        group,
        indented: true,
      });
    }
  }
  return {
    list,
    hasMore: dropdown.hasMore,
  };
}

export type SidebarRepoSort = 'alphabetical' | 'recent_activity' | 'total_items';

/** Converts the proto `RepoSortMode` enum into the frontend `SidebarRepoSort` string union. */
export function toSidebarRepoSort(mode?: RepoSortMode): SidebarRepoSort {
  switch (mode) {
    case RepoSortMode.RECENT_ACTIVITY:
      return 'recent_activity';
    case RepoSortMode.TOTAL_ITEMS:
      return 'total_items';
    case RepoSortMode.ALPHABETICAL:
    case RepoSortMode.UNSPECIFIED:
    default:
      return 'alphabetical';
  }
}

export interface SidebarRepos {
  readonly repoList: string[];
  /** Repos with non-noise activity in the last 30 days (or fitting above "More" for non-alphabetical sorts). */
  readonly activeList: string[];
  /** The rest, shown behind "More". */
  readonly hiddenList: string[];
}

/** Splits a sorted repository list into `activeList` and `hiddenList` at `maxVisibleRepos`. */
export function splitAtVisible(
  sorted: readonly string[],
  maxVisibleRepos?: number
): SidebarRepos {
  const repoList = [...sorted];
  if (maxVisibleRepos !== undefined && maxVisibleRepos < repoList.length) {
    const splitAt = Math.max(0, maxVisibleRepos);
    return {
      repoList,
      activeList: repoList.slice(0, splitAt),
      hiddenList: repoList.slice(splitAt),
    };
  }
  return {
    repoList,
    activeList: repoList,
    hiddenList: [],
  };
}

/** Sidebar repository lists from the repo facet of the unfiltered query. */
export function buildSidebar(
  repoValues: readonly FacetValue[],
  nowMs: number = Date.now(),
  sortMode: SidebarRepoSort = 'alphabetical',
  maxVisibleRepos?: number
): SidebarRepos {
  const latest = new Map<string, number>();
  const recent = new Map<string, number>();
  const total = new Map<string, number>();
  const repos = new FoldedSet();
  for (const v of repoValues) {
    if (!v.value.includes('/')) continue;
    repos.add(v.value);
    const key = fold(v.value);
    latest.set(key, Math.max(latest.get(key) ?? 0, getProtoTimestampMs(v.latestActivityAt)));
    recent.set(key, (recent.get(key) ?? 0) + (v.recentCount ?? 0));
    total.set(key, (total.get(key) ?? 0) + (v.totalCount ?? 0));
  }
  const alphabeticalList = repos.sorted();
  if (sortMode === 'alphabetical') {
    const cutoffMs = nowMs - THIRTY_DAYS_MS;
    const isActive = (repo: string) => (latest.get(fold(repo)) ?? 0) >= cutoffMs;
    return {
      repoList: alphabeticalList,
      activeList: alphabeticalList.filter(isActive),
      hiddenList: alphabeticalList.filter((r) => !isActive(r)),
    };
  }

  const sorted = [...alphabeticalList].sort((a, b) => {
    const keyA = fold(a);
    const keyB = fold(b);
    if (sortMode === 'total_items') {
      const totalDiff = (total.get(keyB) ?? 0) - (total.get(keyA) ?? 0);
      if (totalDiff !== 0) return totalDiff;
    }
    const recentDiff = (recent.get(keyB) ?? 0) - (recent.get(keyA) ?? 0);
    if (recentDiff !== 0) return recentDiff;
    const latestDiff = (latest.get(keyB) ?? 0) - (latest.get(keyA) ?? 0);
    if (latestDiff !== 0) return latestDiff;
    return byName(a, b);
  });

  return splitAtVisible(sorted, maxVisibleRepos);
}

/** Facet counts keyed by lower-cased value. */
export function countsByValue(values: readonly FacetValue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[fold(v.value)] = (counts[fold(v.value)] ?? 0) + v.count;
  return counts;
}

/** Count of one value (0 if absent). */
export function countOf(values: readonly FacetValue[], value: string): number {
  return countsByValue(values)[fold(value)] ?? 0;
}

/** Facet new-activity counts (`newCount`) keyed by lower-cased value. */
export function newCountsByValue(values: readonly FacetValue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[fold(v.value)] = (counts[fold(v.value)] ?? 0) + v.newCount;
  return counts;
}

/** New-activity count (`newCount`) of one value (0 if absent). */
export function newCountOf(values: readonly FacetValue[], value: string): number {
  return newCountsByValue(values)[fold(value)] ?? 0;
}

/** Lower-cased values with at least one matching item carrying new activity (`newCount > 0`). */
export function valuesWithNew(values: readonly FacetValue[]): Set<string> {
  return new Set(values.filter((v) => v.newCount > 0).map((v) => fold(v.value)));
}

export interface ActivityOption {
  readonly value: ActivityValue;
  readonly label: string;
  readonly count: number | null;
  readonly isGroupHeader?: boolean;
  readonly indented?: boolean;
}

/** Labels for chips and other summaries of the activity selection. */
export const ACTIVITY_LABELS: Readonly<Record<ActivityValue, string>> = {
  any: 'Any',
  item: 'New items',
  mention: 'Mentions',
  comment: 'Comments & reviews',
  code: 'New commits',
  noise: 'Noise (bots)',
};

/** Menu label of the 'any' row, which doubles as the section heading. */
const ACTIVITY_GROUP_LABEL = 'New Activity';

const ACTIVITY_ORDER: readonly ActivityValue[] = [
  'any',
  'item',
  'mention',
  'comment',
  'code',
  'noise',
];

/**
 * Activity menu options in fixed order (§3.4): a selectable "New Activity" group header for
 * new:any (no count), styled like an organization in the Repository menu, then the five concrete
 * activity flags indented beneath it with their facet counts.
 */
export function buildActivityOptions(values: readonly FacetValue[]): ActivityOption[] {
  const counts = countsByValue(values);
  return ACTIVITY_ORDER.map((value) =>
    value === 'any'
      ? { value, label: ACTIVITY_GROUP_LABEL, count: null, isGroupHeader: true }
      : { value, label: ACTIVITY_LABELS[value], count: counts[value] ?? 0, indented: true }
  );
}
