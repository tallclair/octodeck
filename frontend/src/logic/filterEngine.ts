import { ItemType as ProtoItemType, ItemState as ProtoItemState, ItemStatus as ProtoItemStatus, type Item, type Label } from '../api/octodeck/v1/resources_pb';
import {
  type DashboardFilterState,
  type TriageFilter,
  type ItemStateFilter,
  type ItemTypeFilter,
  type AssignedFilter,
  type SortOption,
  type SortOrder,
  DEFAULT_FILTER_STATE,
} from '../types/filters';
import { getProtoTimestampMs, getLatestNonNoiseActivityMs } from './timeline';

/**
 * Parses URL query parameters into a validated DashboardFilterState object.
 */
export function parseFilterParams(search: string | URLSearchParams): DashboardFilterState {
  const params = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search;

  const rawTriage = params.get('triage')?.toLowerCase();
  const triage: TriageFilter =
    rawTriage === 'activity' || rawTriage === 'acked' || rawTriage === 'all' || rawTriage === 'inbox'
      ? rawTriage
      : DEFAULT_FILTER_STATE.triage;

  const rawState = params.get('state')?.toLowerCase();
  const state: ItemStateFilter =
    rawState === 'closed' || rawState === 'all' || rawState === 'open'
      ? rawState
      : DEFAULT_FILTER_STATE.state;

  const rawType = params.get('type')?.toLowerCase();
  const type: ItemTypeFilter =
    rawType === 'pr' || rawType === 'issue' || rawType === 'all'
      ? rawType
      : DEFAULT_FILTER_STATE.type;

  const rawAssigned = params.get('assigned')?.toLowerCase();
  const assigned: AssignedFilter =
    rawAssigned === 'me' || rawAssigned === 'all'
      ? rawAssigned
      : DEFAULT_FILTER_STATE.assigned;

  const repo = params.get('repo')?.trim() || null;
  const org = params.get('org')?.trim() || null;

  const rawAuthor = params.get('author')?.trim();
  const author = rawAuthor ? rawAuthor.replace(/^@/, '') : null;

  const rawMilestone = params.get('milestone')?.trim() || null;

  const rawLabel = params.get('label')?.trim() || null;

  const q = params.get('q')?.trim() || '';

  const rawSort = params.get('sort')?.toLowerCase();
  const sort: SortOption =
    rawSort === 'acked' || rawSort === 'created' || rawSort === 'updated'
      ? rawSort
      : DEFAULT_FILTER_STATE.sort;

  const rawOrder = params.get('order')?.toLowerCase();
  const order: SortOrder =
    rawOrder === 'asc' || rawOrder === 'desc'
      ? rawOrder
      : DEFAULT_FILTER_STATE.order;

  const item = params.get('item')?.trim() || null;

  return {
    triage,
    state,
    type,
    assigned,
    org,
    repo,
    author,
    milestone: rawMilestone,
    label: rawLabel,
    q,
    sort,
    order,
    item,
  };
}

/**
 * Serializes a DashboardFilterState object into a clean URLSearchParams instance,
 * omitting default values to ensure concise, bookmarkable URLs.
 */
export function filterStateToSearchParams(filters: DashboardFilterState): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.triage !== DEFAULT_FILTER_STATE.triage) {
    params.set('triage', filters.triage);
  }

  if (filters.state !== DEFAULT_FILTER_STATE.state) {
    params.set('state', filters.state);
  }

  if (filters.type !== DEFAULT_FILTER_STATE.type) {
    params.set('type', filters.type);
  }

  if (filters.assigned !== DEFAULT_FILTER_STATE.assigned) {
    params.set('assigned', filters.assigned);
  }

  if (filters.repo) {
    params.set('repo', filters.repo);
  } else if (filters.org) {
    params.set('org', filters.org);
  }

  if (filters.author) {
    params.set('author', filters.author.replace(/^@/, ''));
  }

  if (filters.milestone) {
    params.set('milestone', filters.milestone);
  }

  if (filters.label) {
    params.set('label', filters.label);
  }

  if (filters.q && filters.q.trim() !== '') {
    params.set('q', filters.q.trim());
  }

  if (filters.sort !== DEFAULT_FILTER_STATE.sort) {
    params.set('sort', filters.sort);
  }

  if (filters.order !== DEFAULT_FILTER_STATE.order) {
    params.set('order', filters.order);
  }

  if (filters.item) {
    params.set('item', filters.item);
  }

  return params;
}

/**
 * Checks if a given filter state matches the default filter state.
 */
export function isDefaultFilterState(filters: DashboardFilterState): boolean {
  return (
    filters.triage === DEFAULT_FILTER_STATE.triage &&
    filters.state === DEFAULT_FILTER_STATE.state &&
    filters.type === DEFAULT_FILTER_STATE.type &&
    filters.assigned === DEFAULT_FILTER_STATE.assigned &&
    !filters.org &&
    !filters.repo &&
    !filters.author &&
    !filters.milestone &&
    !filters.label &&
    (!filters.q || filters.q.trim() === '') &&
    filters.sort === DEFAULT_FILTER_STATE.sort &&
    filters.order === DEFAULT_FILTER_STATE.order &&
    !filters.item
  );
}

/**
 * Calculates the number of non-default filter dimensions currently applied.
 */
export function getActiveFilterCount(filters: DashboardFilterState): number {
  let count = 0;
  if (filters.triage !== DEFAULT_FILTER_STATE.triage) count++;
  if (filters.state !== DEFAULT_FILTER_STATE.state) count++;
  if (filters.type !== DEFAULT_FILTER_STATE.type) count++;
  if (filters.assigned !== DEFAULT_FILTER_STATE.assigned) count++;
  if (filters.repo || filters.org) count++;
  if (filters.author) count++;
  if (filters.milestone) count++;
  if (filters.label) count++;
  if (filters.q && filters.q.trim() !== '') count++;
  if (filters.sort !== DEFAULT_FILTER_STATE.sort || filters.order !== DEFAULT_FILTER_STATE.order) count++;
  return count;
}

/**
 * Pure filter engine applying the full set of multidimensional filters to a list of items.
 */
export function applyFilters(
  items: Item[],
  filters: DashboardFilterState,
  currentUser?: string | null
): Item[] {
  let filtered = items;

  // 1. Triage filter: Inbox, Activity, Acked, All
  if (filters.triage === 'acked') {
    filtered = filtered.filter(item => item.local?.computedStatus === ProtoItemStatus.ACKED);
  } else if (filters.triage === 'inbox') {
    filtered = filtered.filter(item => item.local?.computedStatus !== ProtoItemStatus.ACKED);
  } else if (filters.triage === 'activity') {
    filtered = filtered.filter(
      item =>
        item.local?.computedStatus !== ProtoItemStatus.ACKED &&
        item.local?.computedStatus !== ProtoItemStatus.IDLE &&
        item.local?.computedStatus !== ProtoItemStatus.NOISE
    );
  }
  // 'all' applies no triage filtering

  // 2. State filter: Open, Closed (including merged), All
  if (filters.state === 'open') {
    filtered = filtered.filter(item => {
      const s = item.state;
      return s === ProtoItemState.OPEN || s === ProtoItemState.UNSPECIFIED || s === undefined;
    });
  } else if (filters.state === 'closed') {
    filtered = filtered.filter(item => {
      const s = item.state;
      return s === ProtoItemState.CLOSED || s === ProtoItemState.MERGED;
    });
  }
  // 'all' applies no state filtering

  // 3. Type filter: All, PR, Issue
  if (filters.type === 'pr') {
    filtered = filtered.filter(
      item => item.type === ProtoItemType.PR || (item.type !== ProtoItemType.ISSUE && item.url.includes('/pull/'))
    );
  } else if (filters.type === 'issue') {
    filtered = filtered.filter(
      item => item.type === ProtoItemType.ISSUE || (item.type !== ProtoItemType.PR && item.url.includes('/issues/'))
    );
  }

  // 4. Assigned filter: Assigned to Me
  if (filters.assigned === 'me') {
    const user = currentUser?.toLowerCase();
    if (user) {
      filtered = filtered.filter(item =>
        (item.assignees || []).some(a => a.login?.toLowerCase() === user)
      );
    } else {
      // If user not authenticated or not passed, show nothing for assigned=me
      filtered = [];
    }
  }

  // 5. Org / Repo filter
  if (filters.repo) {
    const targetRepo = filters.repo.toLowerCase();
    filtered = filtered.filter(item => (item.repo || '').toLowerCase() === targetRepo);
  } else if (filters.org) {
    const targetOrgPrefix = filters.org.toLowerCase() + '/';
    filtered = filtered.filter(item => (item.repo || '').toLowerCase().startsWith(targetOrgPrefix));
  }

  // 6. Author filter
  if (filters.author) {
    const targetAuthor = filters.author.toLowerCase().replace(/^@/, '');
    filtered = filtered.filter(
      item => item.author?.login?.toLowerCase() === targetAuthor
    );
  }

  // 7. Milestone filter
  if (filters.milestone) {
    const targetMilestone = filters.milestone.toLowerCase();
    filtered = filtered.filter(
      item => item.milestone?.title?.toLowerCase() === targetMilestone
    );
  }

  // 8. Label filter
  if (filters.label) {
    const targetLabel = filters.label.toLowerCase();
    filtered = filtered.filter(item =>
      (item.labels || []).some(l => l.name?.toLowerCase() === targetLabel)
    );
  }

  // 9. Search query filter
  if (filters.q && filters.q.trim() !== '') {
    const lower = filters.q.toLowerCase().trim();
    filtered = filtered.filter(item => {
      const titleMatch = item.title?.toLowerCase().includes(lower);
      const repoMatch = item.repo?.toLowerCase().includes(lower);
      const authorMatch = item.author?.login?.toLowerCase().includes(lower);
      const bodyMatch = item.body?.toLowerCase().includes(lower);
      const milestoneMatch = item.milestone?.title?.toLowerCase().includes(lower);
      const labelMatch = (item.labels || []).some(l => l.name?.toLowerCase().includes(lower));
      const numberMatch =
        item.number != null &&
        (String(item.number) === lower || `#${item.number}`.includes(lower));

      return Boolean(titleMatch || repoMatch || authorMatch || bodyMatch || numberMatch || milestoneMatch || labelMatch);
    });
  }

  // 9. Sorting logic: Starred items always float to the top; then sort by chosen criterion & order
  const sortOption = filters.sort || DEFAULT_FILTER_STATE.sort;
  const sortOrder = filters.order || DEFAULT_FILTER_STATE.order;

  const getItemTimestamp = (item: Item, option: SortOption): number => {
    if (option === 'acked') {
      return getProtoTimestampMs(item.local?.ackedAt);
    }
    if (option === 'created') {
      const createdMs = getProtoTimestampMs(item.createdAt);
      return createdMs > 0 ? createdMs : getProtoTimestampMs(item.updatedAt);
    }
    // Default: 'updated' (latest non-noise activity)
    return getLatestNonNoiseActivityMs(item);
  };

  return filtered.slice().sort((a, b) => {
    // Starred items float to top of list
    const aStarred = Boolean(a.local?.starred);
    const bStarred = Boolean(b.local?.starred);
    if (aStarred !== bStarred) {
      return aStarred ? -1 : 1;
    }

    const tA = getItemTimestamp(a, sortOption);
    const tB = getItemTimestamp(b, sortOption);

    if (tA !== tB) {
      return sortOrder === 'asc' ? tA - tB : tB - tA;
    }

    // Tie-breaker: fallback to latest non-noise activity descending
    const updatedA = getLatestNonNoiseActivityMs(a);
    const updatedB = getLatestNonNoiseActivityMs(b);
    if (updatedA !== updatedB) {
      return updatedB - updatedA;
    }

    return (a.id || '').localeCompare(b.id || '');
  });
}

export interface UniqueOrgsAndRepos {
  orgs: string[];
  reposByOrg: Record<string, string[]>;
  pinnedList: string[];
  otherList: string[];
  activeOtherList: string[];
  hiddenOtherList: string[];
}

/**
 * Extracts unique organizations and repository groupings from items.
 */
export function extractUniqueOrgsAndRepos(
  items: Item[],
  pinnedRepos: string[] = [],
  nowMs?: number
): UniqueOrgsAndRepos {
  const pinnedSet = new Set(pinnedRepos);
  const reposWithItems = new Set<string>();
  const orgsSet = new Set<string>();
  const reposByOrg: Record<string, Set<string>> = {};
  const latestActivityByRepo: Record<string, number> = {};

  // Register pinned repos
  pinnedRepos.forEach(repo => {
    if (repo && repo.includes('/')) {
      const [org] = repo.split('/');
      orgsSet.add(org);
      if (!reposByOrg[org]) reposByOrg[org] = new Set();
      reposByOrg[org].add(repo);
    }
  });

  // Register repos from items
  items.forEach(item => {
    if (item.repo && item.repo.includes('/')) {
      reposWithItems.add(item.repo);
      const [org] = item.repo.split('/');
      orgsSet.add(org);
      if (!reposByOrg[org]) reposByOrg[org] = new Set();
      reposByOrg[org].add(item.repo);

      const activityMs = getLatestNonNoiseActivityMs(item);
      latestActivityByRepo[item.repo] = Math.max(latestActivityByRepo[item.repo] || 0, activityMs);
    }
  });

  const otherList = Array.from(reposWithItems)
    .filter(r => !pinnedSet.has(r))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const cutoffMs = (nowMs !== undefined ? nowMs : Date.now()) - THIRTY_DAYS_MS;
  const activeOtherList = otherList.filter(r => (latestActivityByRepo[r] || 0) >= cutoffMs);
  const hiddenOtherList = otherList.filter(r => (latestActivityByRepo[r] || 0) < cutoffMs);

  const orgs = Array.from(orgsSet).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );

  const formattedReposByOrg: Record<string, string[]> = {};
  for (const org of orgs) {
    formattedReposByOrg[org] = Array.from(reposByOrg[org] || []).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
  }

  return {
    orgs,
    reposByOrg: formattedReposByOrg,
    pinnedList: pinnedRepos,
    otherList,
    activeOtherList,
    hiddenOtherList,
  };
}

/**
 * Extracts a sorted list of unique author logins from a list of items.
 */
export function extractUniqueAuthors(items: Item[]): string[] {
  const authors = new Set<string>();
  items.forEach(item => {
    if (item.author?.login) {
      authors.add(item.author.login);
    }
  });
  return Array.from(authors).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );
}

/**
 * Extracts a sorted list of unique milestone titles from a list of items.
 */
export function extractUniqueMilestones(items: Item[]): string[] {
  const milestones = new Set<string>();
  items.forEach(item => {
    if (item.milestone?.title && item.milestone.title.trim()) {
      milestones.add(item.milestone.title.trim());
    }
  });
  return Array.from(milestones).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );
}

/**
 * Extracts a sorted list of unique labels from a list of items.
 */
export function extractUniqueLabels(items: Item[]): Label[] {
  const labelMap = new Map<string, Label>();
  items.forEach(item => {
    (item.labels || []).forEach(l => {
      if (l.name && l.name.trim() && !labelMap.has(l.name.toLowerCase())) {
        labelMap.set(l.name.toLowerCase(), l);
      }
    });
  });
  return Array.from(labelMap.values()).sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
  );
}
