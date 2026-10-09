// Shapes GetFacets responses into the dashboard's dropdown options and sidebar data.
// Facet values are case-grouped by the daemon, so comparisons here are case-insensitive.
import type { Field, FacetValue } from '../../api/octodeck/v1/query_pb';
import type { GetFacetsResponse } from '../../api/octodeck/v1/service_pb';
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

/**
 * Dropdown options for an open field. By default the values with a non-zero count are shown;
 * "Show all" adds the zero-count values. The selected value is always listed (it may have no
 * matches, or be unknown to the daemon).
 */
export function buildOptions(values: readonly FacetValue[], selected: string | null, showAll: boolean): OptionList<string> {
  const displayed = new FoldedSet();
  const all = new FoldedSet();
  for (const v of values) {
    all.add(v.value);
    if (v.count > 0) displayed.add(v.value);
  }
  if (selected) {
    displayed.add(selected);
    all.add(selected);
  }
  const displayedList = displayed.sorted();
  const allList = all.sorted();
  return {
    list: showAll ? allList : displayedList,
    hasMore: allList.some((v) => !displayed.has(v)),
  };
}

export interface LabelOption {
  readonly name: string;
  /** Hex color without '#', or '' when unknown. */
  readonly color: string;
}

/** Label dropdown options: like buildOptions, carrying each label's color. */
export function buildLabelOptions(
  values: readonly FacetValue[],
  selected: string | null,
  showAll: boolean
): OptionList<LabelOption> {
  const colors = new Map<string, string>();
  for (const v of values) {
    if (!colors.has(fold(v.value))) colors.set(fold(v.value), v.color);
  }
  const names = buildOptions(values, selected, showAll);
  return {
    list: names.list.map((name) => ({ name, color: colors.get(fold(name)) ?? '' })),
    hasMore: names.hasMore,
  };
}

function ownerOf(repo: string): string | null {
  const slash = repo.indexOf('/');
  return slash > 0 ? repo.slice(0, slash) : null;
}

interface OrgsAndRepos {
  orgs: FoldedSet;
  repos: FoldedSet;
}

function groupByOrg({ orgs, repos }: OrgsAndRepos): { orgs: string[]; reposByOrg: Record<string, string[]> } {
  const orgList = orgs.sorted();
  const reposByOrg: Record<string, string[]> = {};
  for (const org of orgList) reposByOrg[org] = [];
  for (const repo of repos.sorted()) {
    const owner = ownerOf(repo);
    const org = owner === null ? undefined : orgList.find((o) => fold(o) === fold(owner));
    if (org !== undefined) reposByOrg[org].push(repo);
  }
  return { orgs: orgList, reposByOrg };
}

export interface RepoDropdown {
  readonly orgs: string[];
  readonly reposByOrg: Record<string, string[]>;
  readonly hasMore: boolean;
}

/**
 * The repository dropdown: repos grouped under org headers. Repo and org facets are requested
 * together; each excludes only its own predicates, so the org headers are the union of the org
 * facet and the owners of the listed repos. "Show all" adds zero-count values and pinned repos.
 */
export function buildRepoDropdown(
  repoValues: readonly FacetValue[],
  orgValues: readonly FacetValue[],
  selected: { repo: string | null; org: string | null },
  pinnedRepos: readonly string[],
  showAll: boolean
): RepoDropdown {
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
  for (const repo of pinnedRepos) addRepo(all, repo);
  for (const target of [displayed, all]) {
    if (selected.repo) addRepo(target, selected.repo);
    else if (selected.org) target.orgs.add(selected.org);
  }

  const hasMore =
    all.repos.sorted().some((r) => !displayed.repos.has(r)) || all.orgs.sorted().some((o) => !displayed.orgs.has(o));
  return { ...groupByOrg(showAll ? all : displayed), hasMore };
}

export interface SidebarRepos {
  readonly pinnedList: string[];
  /** Every non-pinned repo with items. */
  readonly otherList: string[];
  /** Non-pinned repos with non-noise activity in the last 30 days. */
  readonly activeOtherList: string[];
  /** The rest, shown behind "More". */
  readonly hiddenOtherList: string[];
}

/** Sidebar repository lists from the repo facet of the unfiltered query. */
export function buildSidebar(
  repoValues: readonly FacetValue[],
  pinnedRepos: readonly string[],
  nowMs: number = Date.now()
): SidebarRepos {
  const pinned = new FoldedSet();
  pinnedRepos.forEach((r) => pinned.add(r));
  const latest = new Map<string, number>();
  const other = new FoldedSet();
  for (const v of repoValues) {
    if (!v.value.includes('/') || pinned.has(v.value)) continue;
    other.add(v.value);
    latest.set(fold(v.value), Math.max(latest.get(fold(v.value)) ?? 0, getProtoTimestampMs(v.latestActivityAt)));
  }
  const otherList = other.sorted();
  const cutoffMs = nowMs - THIRTY_DAYS_MS;
  const isActive = (repo: string) => (latest.get(fold(repo)) ?? 0) >= cutoffMs;
  return {
    pinnedList: [...pinnedRepos],
    otherList,
    activeOtherList: otherList.filter(isActive),
    hiddenOtherList: otherList.filter((r) => !isActive(r)),
  };
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
