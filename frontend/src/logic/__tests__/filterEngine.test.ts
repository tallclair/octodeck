import { describe, it, expect } from 'vitest';
import {
  parseFilterParams,
  filterStateToSearchParams,
  applyFilters,
  isDefaultFilterState,
  getActiveFilterCount,
  extractUniqueOrgsAndRepos,
  extractUniqueAuthors,
  extractUniqueMilestones,
  extractUniqueLabels,
} from '../filterEngine';
import {
  DEFAULT_FILTER_STATE,
  type DashboardFilterState,
} from '../../types/filters';
import {
  ItemType as ProtoItemType,
  ItemState as ProtoItemState,
  ItemStatus as ProtoItemStatus,
  type Item,
  type User,
  type Milestone,
  type Label,
} from '../../api/octodeck/v1/resources_pb';

const createMockItem = (overrides: Record<string, unknown> = {}): Item =>
  ({
    id: 'PR_1',
    repo: 'kubernetes/kubernetes',
    number: 100,
    type: ProtoItemType.PR,
    title: 'Test PR title',
    body: 'Test PR description body',
    state: ProtoItemState.OPEN,
    url: 'https://github.com/kubernetes/kubernetes/pull/100',
    updatedAt: { seconds: BigInt(1700000000), nanos: 0 },
    author: { login: 'alice', avatarUrl: '', type: 1 } as unknown as User,
    assignees: [{ login: 'stclair', avatarUrl: '', type: 1 } as unknown as User],
    commits: [],
    comments: [],
    reviews: [],
    local: {
      computedStatus: ProtoItemStatus.NEW,
      isAcked: false,
      privateNotes: '',
    },
    ...overrides,
  } as unknown as Item);

describe('filterEngine - parseFilterParams', () => {
  it('returns default filter state for empty query string or params', () => {
    expect(parseFilterParams('')).toEqual(DEFAULT_FILTER_STATE);
    expect(parseFilterParams('?')).toEqual(DEFAULT_FILTER_STATE);
    expect(parseFilterParams(new URLSearchParams())).toEqual(DEFAULT_FILTER_STATE);
  });

  it('parses valid triage parameter', () => {
    expect(parseFilterParams('?triage=activity').triage).toBe('activity');
    expect(parseFilterParams('?triage=acked').triage).toBe('acked');
    expect(parseFilterParams('?triage=all').triage).toBe('all');
    expect(parseFilterParams('?triage=inbox').triage).toBe('inbox');
    expect(parseFilterParams('?triage=unknown').triage).toBe('inbox');
  });

  it('parses valid state parameter', () => {
    expect(parseFilterParams('?state=closed').state).toBe('closed');
    expect(parseFilterParams('?state=all').state).toBe('all');
    expect(parseFilterParams('?state=open').state).toBe('open');
    expect(parseFilterParams('?state=invalid').state).toBe('all');
  });

  it('parses valid type parameter', () => {
    expect(parseFilterParams('?type=pr').type).toBe('pr');
    expect(parseFilterParams('?type=issue').type).toBe('issue');
    expect(parseFilterParams('?type=all').type).toBe('all');
    expect(parseFilterParams('?type=other').type).toBe('all');
  });

  it('parses assigned parameter', () => {
    expect(parseFilterParams('?assigned=me').assigned).toBe('me');
    expect(parseFilterParams('?assigned=all').assigned).toBe('all');
    expect(parseFilterParams('?assigned=other').assigned).toBe('all');
  });

  it('parses repo, org, author (with or without @), milestone, label, search query q, and item', () => {
    const params = parseFilterParams('?repo=kubernetes/kubernetes&org=kubernetes&author=@alice&milestone=v1.32&label=kind/bug&q=scheduler&item=PR_123');
    expect(params.repo).toBe('kubernetes/kubernetes');
    expect(params.org).toBe('kubernetes');
    expect(params.author).toBe('alice');
    expect(params.milestone).toBe('v1.32');
    expect(params.label).toBe('kind/bug');
    expect(params.q).toBe('scheduler');
    expect(params.item).toBe('PR_123');
  });
});

describe('filterEngine - filterStateToSearchParams', () => {
  it('omits all default parameters to produce clean URL query params', () => {
    const params = filterStateToSearchParams(DEFAULT_FILTER_STATE);
    expect(params.toString()).toBe('');
  });

  it('serializes custom filter parameters', () => {
    const state: DashboardFilterState = {
      triage: 'activity',
      state: 'closed',
      type: 'pr',
      assigned: 'me',
      org: null,
      repo: 'kubernetes/kubernetes',
      author: 'alice',
      milestone: 'v1.32',
      label: 'kind/bug',
      q: 'fix bug',
      sort: 'created',
      order: 'asc',
      item: null,
    };
    const params = filterStateToSearchParams(state);
    expect(params.get('triage')).toBe('activity');
    expect(params.get('state')).toBe('closed');
    expect(params.get('type')).toBe('pr');
    expect(params.get('assigned')).toBe('me');
    expect(params.get('repo')).toBe('kubernetes/kubernetes');
    expect(params.get('org')).toBeNull(); // repo takes precedence over org in URL
    expect(params.get('author')).toBe('alice');
    expect(params.get('milestone')).toBe('v1.32');
    expect(params.get('label')).toBe('kind/bug');
    expect(params.get('q')).toBe('fix bug');
    expect(params.get('sort')).toBe('created');
    expect(params.get('order')).toBe('asc');
  });

  it('serializes org if repo is not present', () => {
    const state: DashboardFilterState = {
      ...DEFAULT_FILTER_STATE,
      org: 'kubernetes',
    };
    const params = filterStateToSearchParams(state);
    expect(params.get('org')).toBe('kubernetes');
    expect(params.get('repo')).toBeNull();
  });
});

describe('filterEngine - isDefaultFilterState & getActiveFilterCount', () => {
  it('correctly detects default state', () => {
    expect(isDefaultFilterState(DEFAULT_FILTER_STATE)).toBe(true);
    expect(isDefaultFilterState({ ...DEFAULT_FILTER_STATE, triage: 'acked' })).toBe(false);
    expect(isDefaultFilterState({ ...DEFAULT_FILTER_STATE, repo: 'foo/bar' })).toBe(false);
    expect(isDefaultFilterState({ ...DEFAULT_FILTER_STATE, milestone: 'v1.32' })).toBe(false);
  });

  it('counts active non-default filter dimensions', () => {
    expect(getActiveFilterCount(DEFAULT_FILTER_STATE)).toBe(0);
    expect(
      getActiveFilterCount({
        ...DEFAULT_FILTER_STATE,
        triage: 'activity',
        repo: 'kubernetes/kubernetes',
        milestone: 'v1.32',
        assigned: 'me',
      })
    ).toBe(4);
  });
});

describe('filterEngine - applyFilters', () => {
  const item1 = createMockItem({
    id: 'PR_1',
    repo: 'kubernetes/kubernetes',
    type: ProtoItemType.PR,
    state: ProtoItemState.OPEN,
    title: 'Scheduler refactor',
    body: 'Optimizing scheduling loops',
    number: 101,
    author: { login: 'alice' } as unknown as User,
    assignees: [{ login: 'stclair' } as unknown as User],
    local: { computedStatus: ProtoItemStatus.NEW_ACTIVITY, isAcked: false, privateNotes: '' },
    updatedAt: { seconds: BigInt(1700000200), nanos: 0 },
  });

  const item2 = createMockItem({
    id: 'ISSUE_2',
    repo: 'kubernetes/minikube',
    type: ProtoItemType.ISSUE,
    state: ProtoItemState.CLOSED,
    title: 'Minikube startup issue',
    body: 'Fails to start driver on linux',
    url: 'https://github.com/kubernetes/minikube/issues/202',
    number: 202,
    author: { login: 'bob' } as unknown as User,
    assignees: [{ login: 'alice' } as unknown as User],
    local: { computedStatus: ProtoItemStatus.IDLE, isAcked: false, privateNotes: '' },
    updatedAt: { seconds: BigInt(1700000100), nanos: 0 },
  });

  const item3 = createMockItem({
    id: 'PR_3',
    repo: 'golang/go',
    type: ProtoItemType.PR,
    state: ProtoItemState.OPEN,
    title: 'Compiler optimization',
    body: 'Escape analysis improvement',
    number: 303,
    author: { login: 'carol' } as unknown as User,
    assignees: [],
    local: { computedStatus: ProtoItemStatus.ACKED, privateNotes: '' },
    updatedAt: { seconds: BigInt(1700000300), nanos: 0 },
  });

  const allItems = [item1, item2, item3];

  it('filters by triage mode (inbox, activity, acked, all)', () => {
    const item4 = createMockItem({
      id: 'PR_4',
      repo: 'golang/go',
      type: ProtoItemType.PR,
      state: ProtoItemState.OPEN,
      title: 'Noise PR',
      body: 'Only bot comments',
      number: 404,
      author: { login: 'dave' } as unknown as User,
      assignees: [],
      local: { computedStatus: ProtoItemStatus.NOISE, privateNotes: '' },
      updatedAt: { seconds: BigInt(1700000400), nanos: 0 },
    });
    const triageTestItems = [...allItems, item4];

    // Inbox: unacked items (including IDLE and NOISE)
    const inboxItems = applyFilters(triageTestItems, { ...DEFAULT_FILTER_STATE, state: 'all', triage: 'inbox' });
    expect(inboxItems.map(i => i.id)).toEqual(['PR_4', 'PR_1', 'ISSUE_2']);

    // Activity: unacked items with new actionable activity (computedStatus !== IDLE && computedStatus !== NOISE)
    const activityItems = applyFilters(triageTestItems, { ...DEFAULT_FILTER_STATE, state: 'all', triage: 'activity' });
    expect(activityItems.map(i => i.id)).toEqual(['PR_1']);

    // Acked: acked items
    const ackedItems = applyFilters(triageTestItems, { ...DEFAULT_FILTER_STATE, state: 'all', triage: 'acked' });
    expect(ackedItems.map(i => i.id)).toEqual(['PR_3']);

    // All triage
    const allTriageItems = applyFilters(triageTestItems, { ...DEFAULT_FILTER_STATE, state: 'all', triage: 'all' });
    expect(allTriageItems.length).toBe(4);
  });

  it('filters by item state (open, closed, all)', () => {
    const openItems = applyFilters(allItems, { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'open' });
    expect(openItems.map(i => i.id)).toEqual(['PR_3', 'PR_1']);

    const closedItems = applyFilters(allItems, { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'closed' });
    expect(closedItems.map(i => i.id)).toEqual(['ISSUE_2']);
  });

  it('filters by item type (all, pr, issue)', () => {
    const prItems = applyFilters(allItems, { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'all', type: 'pr' });
    expect(prItems.map(i => i.id)).toEqual(['PR_3', 'PR_1']);

    const issueItems = applyFilters(allItems, { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'all', type: 'issue' });
    expect(issueItems.map(i => i.id)).toEqual(['ISSUE_2']);
  });

  it('filters by assigned=me using currentUser', () => {
    const assignedItems = applyFilters(
      allItems,
      { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'all', assigned: 'me' },
      'stclair'
    );
    expect(assignedItems.map(i => i.id)).toEqual(['PR_1']);

    const noUserItems = applyFilters(
      allItems,
      { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'all', assigned: 'me' },
      null
    );
    expect(noUserItems).toEqual([]);
  });

  it('filters by repo and org', () => {
    // Exact repo
    const k8sRepoItems = applyFilters(allItems, {
      ...DEFAULT_FILTER_STATE,
      triage: 'all',
      state: 'all',
      repo: 'kubernetes/kubernetes',
    });
    expect(k8sRepoItems.map(i => i.id)).toEqual(['PR_1']);

    // Org matching both kubernetes/kubernetes and kubernetes/minikube
    const k8sOrgItems = applyFilters(allItems, {
      ...DEFAULT_FILTER_STATE,
      triage: 'all',
      state: 'all',
      org: 'kubernetes',
    });
    expect(k8sOrgItems.map(i => i.id)).toEqual(['PR_1', 'ISSUE_2']);
  });

  it('filters by author', () => {
    const authorItems = applyFilters(allItems, {
      ...DEFAULT_FILTER_STATE,
      triage: 'all',
      state: 'all',
      author: 'alice',
    });
    expect(authorItems.map(i => i.id)).toEqual(['PR_1']);
  });

  it('filters by milestone', () => {
    const itemWithMilestone1 = createMockItem({
      id: 'MS_1',
      milestone: { title: 'v1.32' } as unknown as Milestone,
    });
    const itemWithMilestone2 = createMockItem({
      id: 'MS_2',
      milestone: { title: 'v1.33' } as unknown as Milestone,
    });
    const itemWithoutMilestone = createMockItem({
      id: 'MS_NONE',
    });

    const msItems = [itemWithMilestone1, itemWithMilestone2, itemWithoutMilestone];
    const filtered = applyFilters(msItems, {
      ...DEFAULT_FILTER_STATE,
      triage: 'all',
      state: 'all',
      milestone: 'v1.32',
    });
    expect(filtered.map(i => i.id)).toEqual(['MS_1']);
  });

  it('filters by search term matching title, repo, body, milestone, or number', () => {
    const itemWithMilestone = createMockItem({
      id: 'MS_SEARCH',
      title: 'Normal title',
      milestone: { title: 'release-2026' } as unknown as Milestone,
    });

    expect(
      applyFilters(allItems, { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'all', q: 'refactor' }).map(i => i.id)
    ).toEqual(['PR_1']);

    expect(
      applyFilters(allItems, { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'all', q: 'driver' }).map(i => i.id)
    ).toEqual(['ISSUE_2']);

    expect(
      applyFilters(allItems, { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'all', q: '303' }).map(i => i.id)
    ).toEqual(['PR_3']);

    expect(
      applyFilters([itemWithMilestone], { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'all', q: 'release-2026' }).map(i => i.id)
    ).toEqual(['MS_SEARCH']);
  });

  it('sorts by latest activity (updated) desc and asc using non-noise activity', () => {
    const itemHumanLater = createMockItem({
      id: 'HUMAN_LATER',
      createdAt: { seconds: BigInt(1700000100), nanos: 0 },
      updatedAt: { seconds: BigInt(1700000200), nanos: 0 },
      comments: [
        {
          commentId: BigInt(1),
          bodyText: 'Human review',
          author: { login: 'alice', avatarUrl: '' } as unknown as User,
          createdAt: { seconds: BigInt(1700000500), nanos: 0 },
          noiseType: 0,
        },
      ],
    });

    const itemBotLater = createMockItem({
      id: 'BOT_LATER',
      createdAt: { seconds: BigInt(1700000100), nanos: 0 },
      updatedAt: { seconds: BigInt(1700000900), nanos: 0 }, // Bot comment happened at 900
      comments: [
        {
          commentId: BigInt(2),
          bodyText: 'Bot build success',
          author: { login: 'k8s-ci-robot', avatarUrl: '' } as unknown as User,
          createdAt: { seconds: BigInt(1700000900), nanos: 0 },
          noiseType: 1, // BOT_AUTHOR
        },
      ],
    });

    // HUMAN_LATER has non-noise activity at 500. BOT_LATER has non-noise activity at 100 (creation time).
    // Therefore, HUMAN_LATER is newer in non-noise activity sorting than BOT_LATER.
    const sorted = applyFilters([itemBotLater, itemHumanLater], { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'all', sort: 'updated', order: 'desc' });
    expect(sorted.map(i => i.id)).toEqual(['HUMAN_LATER', 'BOT_LATER']);
  });

  it('sorts by last acked by me (acked) desc and asc', () => {
    const itemAcked1 = createMockItem({
      id: 'ACK_1',
      updatedAt: { seconds: BigInt(1700000100), nanos: 0 },
      local: { computedStatus: ProtoItemStatus.ACKED, ackedAt: { seconds: BigInt(1700000500), nanos: 0 } },
    });
    const itemAcked2 = createMockItem({
      id: 'ACK_2',
      updatedAt: { seconds: BigInt(1700000200), nanos: 0 },
      local: { computedStatus: ProtoItemStatus.ACKED, ackedAt: { seconds: BigInt(1700000400), nanos: 0 } },
    });
    const itemUnacked = createMockItem({
      id: 'UNACK_3',
      updatedAt: { seconds: BigInt(1700000300), nanos: 0 },
      local: { computedStatus: ProtoItemStatus.NEW },
    });

    const items = [itemAcked2, itemUnacked, itemAcked1];

    const desc = applyFilters(items, { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'all', sort: 'acked', order: 'desc' });
    expect(desc.map(i => i.id)).toEqual(['ACK_1', 'ACK_2', 'UNACK_3']);

    const asc = applyFilters(items, { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'all', sort: 'acked', order: 'asc' });
    expect(asc.map(i => i.id)).toEqual(['UNACK_3', 'ACK_2', 'ACK_1']);
  });

  it('sorts by creation date (created) desc and asc', () => {
    const itemA = createMockItem({
      id: 'A',
      createdAt: { seconds: BigInt(1700000100), nanos: 0 },
      updatedAt: { seconds: BigInt(1700000900), nanos: 0 },
    });
    const itemB = createMockItem({
      id: 'B',
      createdAt: { seconds: BigInt(1700000300), nanos: 0 },
      updatedAt: { seconds: BigInt(1700000200), nanos: 0 },
    });
    const itemC = createMockItem({
      id: 'C',
      createdAt: { seconds: BigInt(1700000200), nanos: 0 },
      updatedAt: { seconds: BigInt(1700000500), nanos: 0 },
    });

    const items = [itemA, itemB, itemC];

    const desc = applyFilters(items, { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'all', sort: 'created', order: 'desc' });
    expect(desc.map(i => i.id)).toEqual(['B', 'C', 'A']);

    const asc = applyFilters(items, { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'all', sort: 'created', order: 'asc' });
    expect(asc.map(i => i.id)).toEqual(['A', 'C', 'B']);
  });

  it('always sorts starred items to the top of lists', () => {
    const itemNormal1 = createMockItem({
      id: 'NORM_1',
      updatedAt: { seconds: BigInt(1700000900), nanos: 0 },
      local: { starred: false },
    });
    const itemStarred1 = createMockItem({
      id: 'STAR_1',
      updatedAt: { seconds: BigInt(1700000100), nanos: 0 },
      local: { starred: true },
    });
    const itemNormal2 = createMockItem({
      id: 'NORM_2',
      updatedAt: { seconds: BigInt(1700000800), nanos: 0 },
      local: { starred: false },
    });
    const itemStarred2 = createMockItem({
      id: 'STAR_2',
      updatedAt: { seconds: BigInt(1700000300), nanos: 0 },
      local: { starred: true },
    });

    const items = [itemNormal1, itemStarred1, itemNormal2, itemStarred2];

    const sorted = applyFilters(items, { ...DEFAULT_FILTER_STATE, triage: 'all', state: 'all', sort: 'updated', order: 'desc' });
    expect(sorted.map(i => i.id)).toEqual(['STAR_2', 'STAR_1', 'NORM_1', 'NORM_2']);
  });
});

describe('filterEngine - extractUniqueOrgsAndRepos, extractUniqueAuthors & extractUniqueMilestones', () => {
  const items: Item[] = [
    createMockItem({
      repo: 'kubernetes/kubernetes',
      author: { login: 'Bob' } as unknown as User,
      milestone: { title: 'v1.32' } as unknown as Milestone,
    }),
    createMockItem({
      repo: 'kubernetes/minikube',
      author: { login: 'alice' } as unknown as User,
      milestone: { title: 'v1.31' } as unknown as Milestone,
    }),
    createMockItem({
      repo: 'golang/go',
      author: { login: 'Charlie' } as unknown as User,
      milestone: { title: 'v1.32' } as unknown as Milestone,
    }),
    createMockItem({
      repo: 'golang/go',
      author: { login: 'Dave' } as unknown as User,
    }),
  ];

  it('extracts orgs and repos grouped by org with pinned list', () => {
    const { orgs, reposByOrg, pinnedList, otherList } = extractUniqueOrgsAndRepos(items, [
      'kubernetes/kubernetes',
    ]);
    expect(orgs).toEqual(['golang', 'kubernetes']);
    expect(reposByOrg['kubernetes']).toEqual(['kubernetes/kubernetes', 'kubernetes/minikube']);
    expect(reposByOrg['golang']).toEqual(['golang/go']);
    expect(pinnedList).toEqual(['kubernetes/kubernetes']);
    expect(otherList).toEqual(['golang/go', 'kubernetes/minikube']);
  });

  it('partitions otherList into activeOtherList and hiddenOtherList based on 30-day non-noise activity', () => {
    const now = 1700000000000;
    const thirtyOneDaysAgoSeconds = BigInt(Math.floor((now - 31 * 86400 * 1000) / 1000));
    const fiveDaysAgoSeconds = BigInt(Math.floor((now - 5 * 86400 * 1000) / 1000));
    const oneDayAgoSeconds = BigInt(Math.floor((now - 1 * 86400 * 1000) / 1000));

    const testItems: Item[] = [
      // Pinned repo (stale activity > 30 days, but pinned)
      createMockItem({
        repo: 'kubernetes/kubernetes',
        createdAt: { seconds: thirtyOneDaysAgoSeconds, nanos: 0 },
        updatedAt: { seconds: thirtyOneDaysAgoSeconds, nanos: 0 },
      }),
      // Active repo (human activity 5 days ago)
      createMockItem({
        repo: 'kubernetes/minikube',
        createdAt: { seconds: thirtyOneDaysAgoSeconds, nanos: 0 },
        updatedAt: { seconds: fiveDaysAgoSeconds, nanos: 0 },
        comments: [
          {
            commentId: BigInt(1),
            bodyText: 'Human review',
            author: { login: 'alice', avatarUrl: '' } as unknown as User,
            createdAt: { seconds: fiveDaysAgoSeconds, nanos: 0 },
            noiseType: 0,
          },
        ],
      }),
      // Stale repo (created 31 days ago, only bot comment 1 day ago)
      createMockItem({
        repo: 'golang/go',
        createdAt: { seconds: thirtyOneDaysAgoSeconds, nanos: 0 },
        updatedAt: { seconds: oneDayAgoSeconds, nanos: 0 },
        comments: [
          {
            commentId: BigInt(2),
            bodyText: 'Bot build green',
            author: { login: 'k8s-ci-robot', avatarUrl: '' } as unknown as User,
            createdAt: { seconds: oneDayAgoSeconds, nanos: 0 },
            noiseType: 1, // BOT_AUTHOR
          },
        ],
      }),
      // Another stale repo (no activity within 30 days)
      createMockItem({
        repo: 'octocat/Hello-World',
        createdAt: { seconds: thirtyOneDaysAgoSeconds, nanos: 0 },
        updatedAt: { seconds: thirtyOneDaysAgoSeconds, nanos: 0 },
      }),
    ];

    const result = extractUniqueOrgsAndRepos(testItems, ['kubernetes/kubernetes'], now);

    expect(result.pinnedList).toEqual(['kubernetes/kubernetes']);
    expect(result.otherList).toEqual(['golang/go', 'kubernetes/minikube', 'octocat/Hello-World']);
    expect(result.activeOtherList).toEqual(['kubernetes/minikube']);
    expect(result.hiddenOtherList).toEqual(['golang/go', 'octocat/Hello-World']);
  });

  it('extracts sorted unique authors', () => {
    expect(extractUniqueAuthors(items)).toEqual(['alice', 'Bob', 'Charlie', 'Dave']);
  });

  it('extracts sorted unique milestones', () => {
    expect(extractUniqueMilestones(items)).toEqual(['v1.31', 'v1.32']);
  });

  it('extracts sorted unique labels', () => {
    const itemWithLabels: Item[] = [
      createMockItem({
        id: '1',
        labels: [
          { name: 'kind/bug', color: 'd73a4a' } as Label,
          { name: 'size/L', color: '0075ca' } as Label,
        ],
      }),
      createMockItem({
        id: '2',
        labels: [
          { name: 'area/api', color: 'ededed' } as Label,
          { name: 'kind/bug', color: 'd73a4a' } as Label, // Duplicate
        ],
      }),
    ];

    const uniqueLabels = extractUniqueLabels(itemWithLabels);
    expect(uniqueLabels.map(l => l.name)).toEqual(['area/api', 'kind/bug', 'size/L']);
  });
});

describe('filterEngine - applyFilters with labels', () => {
  const item1 = createMockItem({
    id: 'PR_1',
    title: 'Bugfix in scheduler',
    labels: [
      { name: 'kind/bug', color: 'd73a4a' } as Label,
      { name: 'size/small', color: '0075ca' } as Label,
    ],
  });
  const item2 = createMockItem({
    id: 'PR_2',
    title: 'Feature addition',
    labels: [
      { name: 'kind/feature', color: 'a2eeef' } as Label,
      { name: 'size/large', color: 'e11d48' } as Label,
    ],
  });

  it('filters items by exact label (case-insensitive)', () => {
    const res = applyFilters([item1, item2], {
      ...DEFAULT_FILTER_STATE,
      triage: 'all',
      state: 'all',
      label: 'KIND/BUG',
    });
    expect(res.map(i => i.id)).toEqual(['PR_1']);
  });

  it('matches label names in free-text search query', () => {
    const res = applyFilters([item1, item2], {
      ...DEFAULT_FILTER_STATE,
      triage: 'all',
      state: 'all',
      q: 'feature',
    });
    expect(res.map(i => i.id)).toEqual(['PR_2']);
  });
});
