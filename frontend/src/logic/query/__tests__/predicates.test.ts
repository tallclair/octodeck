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
  isDefaultQuery,
  projectControls,
  removePredicate,
  setControl,
  setTriageTab,
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
    expect(projectControls(DEFAULT_QUERY_STATE)).toEqual({ controls: DEFAULT_FILTER_CONTROLS, extras: [] });
  });

  // Same expectations as the former parseFilterParams tests: legacy URLs show the same controls.
  it('shows each legacy parameter on its control', () => {
    expect(controls('?triage=activity').triage).toBe('activity');
    expect(controls('?triage=acked').triage).toBe('acked');
    expect(controls('?triage=all').triage).toBe('all');
    expect(controls('?triage=inbox').triage).toBe('inbox');
    expect(controls('?triage=unknown').triage).toBe('inbox');
    expect(controls('?state=closed').state).toBe('closed');
    expect(controls('?state=open').state).toBe('open');
    expect(controls('?state=invalid').state).toBe('all');
    expect(controls('?type=pr').type).toBe('pr');
    expect(controls('?type=issue').type).toBe('issue');
    expect(controls('?type=other').type).toBe('all');
    expect(controls('?assigned=me').assigned).toBe('me');
    expect(controls('?assigned=other').assigned).toBe('all');
    expect(controls('?tracking=tracked').tracking).toBe('tracked');
    expect(controls('?tracking=UnTracked').tracking).toBe('untracked');
    expect(controls('?tracking=invalid').tracking).toBe('all');
  });

  it('shows repo, author, milestone, label, q, sort, order and item', () => {
    expect(
      controls('?repo=kubernetes/kubernetes&author=@alice&milestone=v1.32&label=kind/bug&q=scheduler&sort=acked&order=asc&item=PR_123')
    ).toEqual({
      ...DEFAULT_FILTER_CONTROLS,
      repo: 'kubernetes/kubernetes',
      author: 'alice',
      milestone: 'v1.32',
      label: 'kind/bug',
      q: 'scheduler',
      sort: 'acked',
      order: 'asc',
      item: 'PR_123',
    });
    expect(controls('?org=kubernetes')).toMatchObject({ org: 'kubernetes', repo: null });
  });

  it('reports predicates no control can show as extras and leaves the control at its default', () => {
    expect(controls('?label=a&label=b').label).toBeNull();
    expect(extras('?label=a&label=b')).toEqual([p(Field.LABEL, ['a', 'b'])]);
    expect(extras('?-label=bug')).toEqual([p(Field.LABEL, ['bug'], true)]);
    expect(controls('?state=merged').state).toBe('all');
    expect(extras('?state=merged')).toEqual([p(Field.STATE, ['merged'])]);
    expect(extras('?-triage=acked')).toEqual([p(Field.TRIAGE, ['acked'], true)]);
    expect(extras('?assignee=bob')).toEqual([p(Field.ASSIGNEE, ['bob'])]);
    expect(extras('?draft=true')).toEqual([p(Field.DRAFT, ['true'])]);
  });

  it('shows new:any as an extra when a triage predicate is present', () => {
    expect(controls('?triage=acked&new=any').triage).toBe('acked');
    expect(extras('?triage=acked&new=any')).toEqual([p(Field.NEW, ['any'])]);
  });

  it('keeps the list index of each extra', () => {
    const { extras: found } = projectControls(parseQueryParams('?-label=bug&repo=a/b&draft=true'));
    expect(found.map((e) => e.index)).toEqual([0, 2]);
  });
});

describe('getTriageTab', () => {
  it('derives the tab from the predicates', () => {
    expect(getTriageTab([])).toBe('inbox');
    expect(getTriageTab([p(Field.NEW, ['any'])])).toBe('activity');
    expect(getTriageTab([p(Field.TRIAGE, ['acked'])])).toBe('acked');
    expect(getTriageTab([p(Field.TRIAGE, ['all'])])).toBe('all');
    expect(getTriageTab([p(Field.TRIAGE, ['acked'], true)])).toBe('inbox');
  });
});

describe('setControl', () => {
  it('inserts new predicates at their canonical position', () => {
    let s = setControl(DEFAULT_QUERY_STATE, 'label', 'bug');
    s = setControl(s, 'triage', 'acked');
    s = setControl(s, 'repo', 'a/b');
    expect(url(s)).toBe('triage=acked&repo=a/b&label=bug');
  });

  it('replaces a predicate in place', () => {
    expect(url(setControl(AC, 'state', 'open'))).toBe('repo=a/b&author=x&triage=acked&state=open&label=bug');
    expect(url(setControl(AC, 'triage', 'all'))).toBe('repo=a/b&author=x&triage=all&state=closed&label=bug');
  });

  it('removes the predicate for a default value, preserving the remaining order', () => {
    expect(url(setControl(AC, 'label', null))).toBe('repo=a/b&author=x&triage=acked&state=closed');
    expect(url(setControl(AC, 'state', 'all'))).toBe('repo=a/b&author=x&triage=acked&label=bug');
    expect(url(setControl(AC, 'triage', 'inbox'))).toBe('repo=a/b&author=x&state=closed&label=bug');
  });

  it('replaces every predicate of the field, including extras', () => {
    expect(url(setControl(parseQueryParams('?label=a&label=b&-label=c'), 'label', 'd'))).toBe('label=d');
  });

  it('strips @ from author and maps tracking to booleans', () => {
    expect(setControl(DEFAULT_QUERY_STATE, 'author', '@alice').predicates).toEqual([p(Field.AUTHOR, ['alice'])]);
    expect(setControl(DEFAULT_QUERY_STATE, 'tracking', 'tracked').predicates).toEqual([p(Field.TRACKING, ['true'])]);
    expect(setControl(DEFAULT_QUERY_STATE, 'tracking', 'untracked').predicates).toEqual([p(Field.TRACKING, ['false'])]);
  });

  it('toggles only the assigned-to-me predicate', () => {
    const s = setControl(parseQueryParams('?assignee=bob'), 'assigned', 'me');
    expect(url(s)).toBe('assignee=bob&assigned=me');
    expect(url(setControl(s, 'assigned', 'all'))).toBe('assignee=bob');
  });

  it('sets the tail fields directly', () => {
    const s = applyControls(DEFAULT_QUERY_STATE, { q: 'foo ', sort: 'created', order: 'asc', item: 'PR_1' });
    expect(s).toEqual({ ...DEFAULT_QUERY_STATE, q: 'foo ', sort: 'created', order: 'asc', item: 'PR_1' });
    expect(setControl(s, 'item', null).item).toBeNull();
  });
});

describe('setTriageTab', () => {
  it('replaces triage predicates and the New tab predicate, keeping everything else', () => {
    const s = parseQueryParams('?triage=activity&repo=a/b');
    expect(url(setTriageTab(s, 'acked'))).toBe('triage=acked&repo=a/b');
    expect(url(setTriageTab(s, 'inbox'))).toBe('repo=a/b');
    expect(url(setTriageTab(parseQueryParams('?repo=a/b&-triage=acked'), 'activity'))).toBe('repo=a/b&triage=activity');
    expect(setTriageTab(DEFAULT_QUERY_STATE, 'activity').predicates).toEqual([p(Field.NEW, ['any'])]);
  });
});

describe('toggleRepo and org/repo exclusivity', () => {
  it('selects, replaces and clears the repo, always clearing org', () => {
    const selected = toggleRepo(parseQueryParams('?org=k8s&label=x'), 'k8s/a');
    expect(url(selected)).toBe('repo=k8s/a&label=x');
    expect(url(toggleRepo(selected, 'k8s/b'))).toBe('repo=k8s/b&label=x');
    expect(url(toggleRepo(selected, 'k8s/a'))).toBe('label=x');
    expect(url(toggleRepo(selected, 'K8S/A'))).toBe('label=x');
  });

  it('keeps repo and org mutually exclusive when set together', () => {
    const repo = applyControls(DEFAULT_QUERY_STATE, { repo: 'a/b', org: null });
    expect(url(applyControls(repo, { org: 'k8s', repo: null }))).toBe('org=k8s');
    expect(url(applyControls(parseQueryParams('?org=k8s'), { repo: 'a/b', org: null }))).toBe('repo=a/b');
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
    expect(formatPredicateChip(p(Field.LABEL, ['a', 'b'], true))).toEqual({ label: 'Label', value: 'a, b', negated: true });
    expect(formatPredicateChip(p(Field.TRACKING, ['false']))).toEqual({ label: 'Tracking', value: 'untracked', negated: false });
    expect(formatPredicateChip(p(Field.STATE, ['merged']))).toEqual({ label: 'State', value: 'merged', negated: false });
  });
});
