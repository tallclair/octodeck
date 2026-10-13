import { describe, it, expect } from 'vitest';
import { Field } from '../../../api/octodeck/v1/query_pb';
import {
  DEFAULT_FILTER_CONTROLS,
  DEFAULT_QUERY_STATE,
  type DashboardQueryState,
  type FilterPredicate,
} from '../../../types/filters';
import { parseQueryParams, serializeQueryParams } from '../urlCodec';
import {
  activeQueryCount,
  applyControls,
  clearSecondary,
  formatPredicateChip,
  getTriageTab,
  hasActiveFilterChips,
  isDefaultQuery,
  projectControls,
  removePredicate,
  setActivity,
  setControl,
  setOrgOrRepo,
  setTriageTab,
  toggleAssignedToMe,
  toggleRepo,
  workflowState,
} from '../predicates';

const p = (field: Field, values: string[], negated = false): FilterPredicate => ({ field, values, negated });
const controls = (search: string) => projectControls(parseQueryParams(search)).controls;
const extras = (search: string) => projectControls(parseQueryParams(search)).extras.map((e) => e.predicate);
const url = (s: DashboardQueryState) => serializeQueryParams(s);
const AC = parseQueryParams('?repo=a/b&author=x&triage=acked&state=closed&label=bug');

describe('projectControls', () => {
  it('shows the defaults for the empty state', () => {
    expect(projectControls(DEFAULT_QUERY_STATE)).toEqual({
      controls: DEFAULT_FILTER_CONTROLS,
      owners: {},
      extras: [],
    });
  });

  // Same expectations as the former parseFilterParams tests: legacy URLs show the same controls.
  it('shows each legacy parameter on its control', () => {
    expect(controls('?triage=activity').triage).toBe('activity');
    expect(controls('?triage=activity').activity).toEqual(['any']);
    expect(controls('?triage=acked').triage).toBe('acked');
    expect(controls('?triage=all').triage).toBe('all');
    expect(controls('?triage=inbox').triage).toBe('inbox');
    expect(controls('?triage=unknown').triage).toBe('inbox');
    expect(controls('?state=closed').state).toBe('closed');
    expect(controls('?state=open').state).toBe('open');
    expect(controls('?state=merged').state).toBe('merged');
    expect(controls('?state=invalid').state).toBe('all');
    expect(controls('?type=pr').type).toBe('pr');
    expect(controls('?type=issue').type).toBe('issue');
    expect(controls('?type=other').type).toBe('all');
    expect(controls('?assigned=me').assignee).toEqual(['@me']);
    expect(controls('?assigned=other').assignee).toEqual([]);
    expect(controls('?tracking=tracked').tracking).toBe('tracked');
    expect(controls('?tracking=UnTracked').tracking).toBe('untracked');
    expect(controls('?tracking=invalid').tracking).toBe('all');
  });

  it('shows multi-value repo, org, author, assignee, milestone, label, q, sort, order and item', () => {
    expect(
      controls(
        '?repo=kubernetes/kubernetes&repo=kubernetes/website&author=@alice&author=bob&assignee=@me&assignee=carol&milestone=v1.32&label=kind/bug&label=area/api&q=scheduler&sort=acked&order=asc&item=PR_123'
      )
    ).toEqual({
      ...DEFAULT_FILTER_CONTROLS,
      repo: ['kubernetes/kubernetes', 'kubernetes/website'],
      author: ['alice', 'bob'],
      assignee: ['@me', 'carol'],
      milestone: ['v1.32'],
      label: ['kind/bug', 'area/api'],
      q: 'scheduler',
      sort: 'acked',
      order: 'asc',
      item: 'PR_123',
    });
    expect(controls('?org=kubernetes&org=golang')).toMatchObject({
      org: ['kubernetes', 'golang'],
      repo: [],
    });
  });

  it('projects both org and repo when a constructed state holds both predicates', () => {
    const state: DashboardQueryState = {
      ...DEFAULT_QUERY_STATE,
      predicates: [p(Field.ORG, ['kubernetes']), p(Field.REPO, ['golang/go'])],
    };
    const projected = projectControls(state);
    expect(projected.controls.org).toEqual(['kubernetes']);
    expect(projected.controls.repo).toEqual(['golang/go']);
    expect(projected.owners).toEqual({ org: 0, repo: 1 });
  });

  it('reports predicates no control can show as extras and leaves the control at its default', () => {
    expect(extras('?-label=bug')).toEqual([p(Field.LABEL, ['bug'], true)]);
    expect(extras('?-triage=acked')).toEqual([p(Field.TRIAGE, ['acked'], true)]);
    expect(extras('?draft=true')).toEqual([p(Field.DRAFT, ['true'])]);
    // Single-select state cannot display a multi-value state predicate
    const multiState: DashboardQueryState = {
      ...DEFAULT_QUERY_STATE,
      predicates: [p(Field.STATE, ['open', 'closed'])],
    };
    expect(projectControls(multiState).controls.state).toBe('all');
    expect(projectControls(multiState).extras).toEqual([
      { predicate: p(Field.STATE, ['open', 'closed']), index: 0 },
    ]);
  });

  it('derives the New tab when there is no triage predicate and activity is exactly [any], and projects activity on other tabs', () => {
    const newTab = projectControls(parseQueryParams('?triage=activity'));
    expect(newTab.controls.triage).toBe('activity');
    expect(newTab.controls.activity).toEqual(['any']);
    expect(newTab.owners).toEqual({ triage: 0, activity: 0 });
    expect(newTab.extras).toEqual([]);

    const ackedWithNewAny = projectControls(parseQueryParams('?triage=acked&new=any'));
    expect(ackedWithNewAny.controls.triage).toBe('acked');
    expect(ackedWithNewAny.controls.activity).toEqual(['any']);
    expect(ackedWithNewAny.owners).toEqual({ triage: 0, activity: 1 });
    expect(ackedWithNewAny.extras).toEqual([]);
  });

  it('keeps the list index of each owner and extra', () => {
    const { owners, extras: found } = projectControls(parseQueryParams('?-label=bug&repo=a/b&draft=true'));
    expect(owners).toEqual({ repo: 1 });
    expect(found.map((e) => e.index)).toEqual([0, 2]);
  });
});

describe('getTriageTab', () => {
  it('derives the tab from the predicates', () => {
    expect(getTriageTab([])).toBe('inbox');
    expect(getTriageTab([p(Field.NEW, ['any'])])).toBe('activity');
    expect(getTriageTab([p(Field.NEW, ['any', 'noise'])])).toBe('inbox');
    expect(getTriageTab([p(Field.NEW, ['mention'])])).toBe('inbox');
    expect(getTriageTab([p(Field.TRIAGE, ['acked'])])).toBe('acked');
    expect(getTriageTab([p(Field.TRIAGE, ['all'])])).toBe('all');
    expect(getTriageTab([p(Field.TRIAGE, ['acked'], true)])).toBe('inbox');
  });
});

describe('setControl', () => {
  it('inserts new predicates at their canonical position', () => {
    let s = setControl(DEFAULT_QUERY_STATE, 'label', ['bug']);
    s = setControl(s, 'triage', 'acked');
    s = setControl(s, 'repo', ['a/b']);
    expect(url(s)).toBe('triage=acked&repo=a/b&label=bug');
  });

  it('replaces a predicate in place, including single-select state Open/Closed/Merged', () => {
    expect(url(setControl(AC, 'state', 'open'))).toBe('repo=a/b&author=x&triage=acked&state=open&label=bug');
    expect(url(setControl(AC, 'state', 'merged'))).toBe('repo=a/b&author=x&triage=acked&state=merged&label=bug');
    expect(url(setControl(AC, 'triage', 'all'))).toBe('repo=a/b&author=x&triage=all&state=closed&label=bug');
  });

  it('removes the predicate for a default value, preserving the remaining order', () => {
    expect(url(setControl(AC, 'label', []))).toBe('repo=a/b&author=x&triage=acked&state=closed');
    expect(url(setControl(AC, 'state', 'all'))).toBe('repo=a/b&author=x&triage=acked&label=bug');
    expect(url(setControl(AC, 'triage', 'inbox'))).toBe('repo=a/b&author=x&state=closed&label=bug');
  });

  it('keeps negated predicates when selecting, changing or clearing a control', () => {
    const initial = parseQueryParams('?-label=bug');
    const selected = setControl(initial, 'label', ['a']);
    expect(url(selected)).toBe('-label=bug&label=a');
    const changed = setControl(selected, 'label', ['a', 'd']);
    expect(url(changed)).toBe('-label=bug&label=a&label=d');
    const cleared = setControl(changed, 'label', []);
    expect(url(cleared)).toBe('-label=bug');
  });

  it('edits only the displayed predicate when a second predicate for the same field exists', () => {
    const twoLabels: DashboardQueryState = {
      ...DEFAULT_QUERY_STATE,
      predicates: [p(Field.LABEL, ['a']), p(Field.LABEL, ['b'])],
    };
    expect(projectControls(twoLabels).controls.label).toEqual(['a']);
    expect(projectControls(twoLabels).extras).toEqual([{ predicate: p(Field.LABEL, ['b']), index: 1 }]);

    const edited = setControl(twoLabels, 'label', ['d', 'e']);
    expect(edited.predicates).toEqual([p(Field.LABEL, ['d', 'e']), p(Field.LABEL, ['b'])]);

    const cleared = setControl(edited, 'label', []);
    expect(cleared.predicates).toEqual([p(Field.LABEL, ['b'])]);
  });

  it('strips @ from author, preserves @me in assignee, and maps tracking to booleans', () => {
    expect(setControl(DEFAULT_QUERY_STATE, 'author', ['@alice', 'bob']).predicates).toEqual([
      p(Field.AUTHOR, ['alice', 'bob']),
    ]);
    expect(setControl(DEFAULT_QUERY_STATE, 'assignee', ['@me', '@alice']).predicates).toEqual([
      p(Field.ASSIGNEE, ['@me', 'alice']),
    ]);
    expect(setControl(DEFAULT_QUERY_STATE, 'tracking', 'tracked').predicates).toEqual([p(Field.TRACKING, ['true'])]);
    expect(setControl(DEFAULT_QUERY_STATE, 'tracking', 'untracked').predicates).toEqual([p(Field.TRACKING, ['false'])]);
  });

  it('toggles @me within the assignee predicate via toggleAssignedToMe', () => {
    const withBob = parseQueryParams('?assignee=alice');
    const withMeAndAlice = toggleAssignedToMe(withBob);
    expect(withMeAndAlice.predicates).toEqual([p(Field.ASSIGNEE, ['@me', 'alice'])]);
    expect(url(withMeAndAlice)).toBe('assignee=@me&assignee=alice');

    const backToAlice = toggleAssignedToMe(withMeAndAlice);
    expect(backToAlice.predicates).toEqual([p(Field.ASSIGNEE, ['alice'])]);
    expect(url(backToAlice)).toBe('assignee=alice');

    const onlyMe = toggleAssignedToMe(DEFAULT_QUERY_STATE);
    expect(onlyMe.predicates).toEqual([p(Field.ASSIGNEE, ['@me'])]);
    expect(url(onlyMe)).toBe('assigned=me');
  });

  it('sets the tail fields directly', () => {
    const s = applyControls(DEFAULT_QUERY_STATE, { q: 'foo ', sort: 'created', order: 'asc', item: 'PR_1' });
    expect(s).toEqual({ ...DEFAULT_QUERY_STATE, q: 'foo ', sort: 'created', order: 'asc', item: 'PR_1' });
    expect(setControl(s, 'item', null).item).toBeNull();
  });
});

describe('setActivity and setTriageTab interplay', () => {
  it('enforces Any vs specific activity exclusivity while allowing noise to combine with Any', () => {
    // Ticking specific values
    const s = setActivity(DEFAULT_QUERY_STATE, ['mention', 'code']);
    expect(s.predicates).toEqual([p(Field.NEW, ['mention', 'code'])]);
    expect(projectControls(s).controls.triage).toBe('inbox');
    expect(projectControls(s).controls.activity).toEqual(['mention', 'code']);

    // Ticking Any while specific values and noise are selected removes item/mention/comment/code, keeps noise
    const withNoiseAndSpecific = setActivity(DEFAULT_QUERY_STATE, ['mention', 'noise']);
    const tickedAny = setActivity(withNoiseAndSpecific, ['mention', 'noise', 'any']);
    expect(tickedAny.predicates).toEqual([p(Field.NEW, ['noise', 'any'])]);
    expect(projectControls(tickedAny).controls.triage).toBe('inbox');

    // Ticking a specific value while Any is ticked removes Any
    const newTab = setActivity(DEFAULT_QUERY_STATE, ['any']);
    expect(projectControls(newTab).controls.triage).toBe('activity');
    const tickedComment = setActivity(newTab, ['any', 'comment']);
    expect(tickedComment.predicates).toEqual([p(Field.NEW, ['comment'])]);
    expect(projectControls(tickedComment).controls.triage).toBe('inbox');
    expect(projectControls(tickedComment).controls.activity).toEqual(['comment']);

    // Ticking noise while on the New tab produces new:any,noise and switches triage projection to inbox
    const anyPlusNoise = setActivity(newTab, ['any', 'noise']);
    expect(anyPlusNoise.predicates).toEqual([p(Field.NEW, ['any', 'noise'])]);
    expect(projectControls(anyPlusNoise).controls.triage).toBe('inbox');
    expect(projectControls(anyPlusNoise).controls.activity).toEqual(['any', 'noise']);

    // Diff-based exclusivity is independent of array order
    const fromMention = setActivity(DEFAULT_QUERY_STATE, ['mention']);
    expect(setActivity(fromMention, ['any', 'mention']).predicates).toEqual([p(Field.NEW, ['any'])]);
    expect(setActivity( newTab, ['mention', 'any']).predicates).toEqual([p(Field.NEW, ['mention'])]);
  });

  it('replaces triage predicates (including negated ones) and handles activity predicates on tab switch', () => {
    const s = parseQueryParams('?triage=activity&repo=a/b');
    expect(url(setTriageTab(s, 'acked'))).toBe('triage=acked&repo=a/b');
    expect(url(setTriageTab(s, 'inbox'))).toBe('repo=a/b');
    expect(url(setTriageTab(parseQueryParams('?repo=a/b&-triage=acked'), 'activity'))).toBe('repo=a/b&triage=activity');
    expect(url(setTriageTab(parseQueryParams('?repo=a/b&-triage=acked'), 'inbox'))).toBe('repo=a/b');
    expect(setTriageTab(DEFAULT_QUERY_STATE, 'activity').predicates).toEqual([p(Field.NEW, ['any'])]);

    // Specific activity selections (e.g. new:mention) survive switching to Acked, Inbox or All
    const withMention = parseQueryParams('?new=mention&repo=a/b');
    expect(url(setTriageTab(withMention, 'acked'))).toBe('triage=acked&new=mention&repo=a/b');
    expect(url(setTriageTab(withMention, 'all'))).toBe('triage=all&new=mention&repo=a/b');
    expect(url(setTriageTab(parseQueryParams('?triage=acked&new=mention'), 'inbox'))).toBe('new=mention');

    // Switching to New ('activity') replaces any existing activity selection (e.g. new:mention,code) with new:any
    const withMentionAndCode = parseQueryParams('?triage=acked&new=mention&new=code&repo=a/b');
    expect(url(setTriageTab(withMentionAndCode, 'activity'))).toBe('triage=activity&repo=a/b');
    expect(setTriageTab(withMentionAndCode, 'activity').predicates).toEqual([
      p(Field.NEW, ['any']),
      p(Field.REPO, ['a/b']),
    ]);
  });
});

describe('toggleRepo and org/repo exclusivity', () => {
  it('selects, replaces and clears the repo, always clearing org', () => {
    const selected = toggleRepo(parseQueryParams('?org=k8s&label=x'), 'k8s/a');
    expect(url(selected)).toBe('repo=k8s/a&label=x');
    expect(url(toggleRepo(selected, 'k8s/b'))).toBe('repo=k8s/b&label=x');
    expect(url(toggleRepo(selected, 'k8s/a'))).toBe('label=x');
    expect(url(toggleRepo(selected, 'K8S/A'))).toBe('label=x');

    // When multiple repos are selected, toggleRepo narrows to the clicked repo instead of clearing
    const multiRepo = parseQueryParams('?repo=k8s/a&repo=k8s/b');
    expect(url(toggleRepo(multiRepo, 'k8s/a'))).toBe('repo=k8s/a');
  });

  it('keeps repo and org mutually exclusive via setOrgOrRepo', () => {
    const repos = setOrgOrRepo(DEFAULT_QUERY_STATE, 'repo', ['a/b', 'a/c']);
    expect(url(repos)).toBe('repo=a/b&repo=a/c');

    const orgs = setOrgOrRepo(repos, 'org', ['k8s', 'golang']);
    expect(url(orgs)).toBe('org=k8s&org=golang');

    const backToRepo = setOrgOrRepo(orgs, 'repo', ['a/b']);
    expect(url(backToRepo)).toBe('repo=a/b');

    // If a constructed state has both org and repo, the next setOrgOrRepo clears the other
    const both: DashboardQueryState = {
      ...DEFAULT_QUERY_STATE,
      predicates: [p(Field.ORG, ['k8s']), p(Field.REPO, ['golang/go'])],
    };
    expect(url(setOrgOrRepo(both, 'org', ['k8s', 'cncf']))).toBe('org=k8s&org=cncf');
    expect(url(setOrgOrRepo(both, 'repo', ['golang/go']))).toBe('repo=golang/go');
  });
});

describe('clearSecondary', () => {
  it('keeps the triage tab, type, q, sort, order and item and drops the rest', () => {
    const s = parseQueryParams(
      '?triage=acked&state=open&type=pr&assigned=me&tracking=tracked&repo=a/b&author=x&milestone=m&label=l&-label=z&draft=true&q=foo&sort=created&order=asc&item=PR_1'
    );
    expect(url(clearSecondary(s))).toBe('triage=acked&type=pr&q=foo&sort=created&order=asc&item=PR_1');
    expect(url(clearSecondary(parseQueryParams('?triage=activity&repo=a/b')))).toBe('triage=activity');
  });
});

describe('workflowState', () => {
  it('is the default state on the given tab', () => {
    expect(workflowState('inbox')).toEqual(DEFAULT_QUERY_STATE);
    expect(url(workflowState('activity'))).toBe('triage=activity');
    expect(url(workflowState('acked'))).toBe('triage=acked');
  });
});

describe('removePredicate', () => {
  it('removes exactly the predicate at the index', () => {
    expect(url(removePredicate(AC, 1))).toBe('repo=a/b&triage=acked&state=closed&label=bug');
  });
});

describe('isDefaultQuery and activeQueryCount', () => {
  it('detects the default state', () => {
    expect(isDefaultQuery(DEFAULT_QUERY_STATE)).toBe(true);
    expect(isDefaultQuery(parseQueryParams('?triage=acked'))).toBe(false);
    expect(isDefaultQuery(parseQueryParams('?milestone=v1.32'))).toBe(false);
    expect(isDefaultQuery(parseQueryParams('?tracking=tracked'))).toBe(false);
    expect(isDefaultQuery(parseQueryParams('?tracking=all'))).toBe(true);
  });

  it('counts active filter dimensions like the legacy filter count', () => {
    expect(activeQueryCount(DEFAULT_QUERY_STATE)).toBe(0);
    expect(activeQueryCount(parseQueryParams('?triage=activity&repo=kubernetes/kubernetes&milestone=v1.32&assigned=me'))).toBe(4);
    expect(activeQueryCount(parseQueryParams('?tracking=untracked'))).toBe(1);
    expect(activeQueryCount(parseQueryParams('?q=x&sort=created&order=asc'))).toBe(2);
  });
});

describe('formatPredicateChip', () => {
  it('formats negated and multi-value predicates with URL-style values', () => {
    expect(formatPredicateChip(p(Field.LABEL, ['a', 'b'], true))).toEqual({
      label: 'Label',
      values: ['a', 'b'],
      negated: true,
    });
    expect(formatPredicateChip(p(Field.TRACKING, ['false']))).toEqual({
      label: 'Tracking',
      values: ['untracked'],
      negated: false,
    });
    expect(formatPredicateChip(p(Field.STATE, ['merged']))).toEqual({
      label: 'State',
      values: ['merged'],
      negated: false,
    });
  });
});

describe('hasActiveFilterChips', () => {
  it('excludes new:any on the New tab and reports active chips for secondary controls or extras', () => {
    const empty = projectControls(DEFAULT_QUERY_STATE);
    expect(hasActiveFilterChips(empty.controls, empty.extras)).toBe(false);

    // On the New tab, new:any is represented by the tab itself and does not produce a chip
    const newTab = projectControls(parseQueryParams('?triage=activity'));
    expect(newTab.controls.triage).toBe('activity');
    expect(newTab.controls.activity).toEqual(['any']);
    expect(hasActiveFilterChips(newTab.controls, newTab.extras)).toBe(false);

    // On Acked or Inbox, activity selections (including new:any or new:any,noise) do produce chips
    const ackedNewAny = projectControls(parseQueryParams('?triage=acked&new=any'));
    expect(hasActiveFilterChips(ackedNewAny.controls, ackedNewAny.extras)).toBe(true);

    const anyPlusNoise = projectControls(parseQueryParams('?new=any&new=noise'));
    expect(hasActiveFilterChips(anyPlusNoise.controls, anyPlusNoise.extras)).toBe(true);

    // Extra predicates (such as negated filters) also count as active chips
    const negated = projectControls(parseQueryParams('?-label=bug'));
    expect(hasActiveFilterChips(negated.controls, negated.extras)).toBe(true);
  });
});
