import { describe, it, expect } from 'vitest';
import { Field } from '../../../api/octodeck/v1/query_pb';
import {
  DEFAULT_FILTER_CONTROLS,
  DEFAULT_QUERY_STATE,
  type FilterPredicate,
} from '../../../types/filters';
import { parseDashboardUrl, serializeDashboardUrl } from '../urlCodec';
import {
  activeQueryCount,
  formatPredicateChip,
  hasActiveFilterChips,
  isDefaultQuery,
  projectClauses,
  resolveActivityValues,
  resolveQueryErrors,
  workflowState,
} from '../predicates';
import { parseQuery } from '../syntax';

const p = (field: Field, values: string[], negated = false): FilterPredicate => ({ field, values, negated });
const projectUrl = (search: string) => {
  const { state } = parseDashboardUrl(search);
  return projectClauses(parseQuery(state.text), state);
};
const controls = (search: string) => projectUrl(search).controls;
const extras = (search: string) => projectUrl(search).extras.map((e) => e.predicate);

describe('projectClauses', () => {
  it('shows the defaults for the empty query', () => {
    expect(projectClauses(parseQuery(''))).toEqual({
      controls: DEFAULT_FILTER_CONTROLS,
      owners: {},
      extras: [],
    });
  });

  it('shows each legacy or ?q= parameter on its control', () => {
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

  it('shows multi-value repo, org, author, assignee, milestone, label, sort, order and item', () => {
    expect(
      controls(
        '?repo=kubernetes/kubernetes&repo=kubernetes/website&author=@alice&author=bob&assignee=@me&assignee=carol&milestone=v1.32&label=kind/bug&label=area/api&sort=acked&order=asc&item=PR_123'
      )
    ).toEqual({
      ...DEFAULT_FILTER_CONTROLS,
      repo: ['kubernetes/kubernetes', 'kubernetes/website'],
      author: ['alice', 'bob'],
      assignee: ['@me', 'carol'],
      milestone: ['v1.32'],
      label: ['kind/bug', 'area/api'],
      sort: 'acked',
      order: 'asc',
      item: 'PR_123',
    });
    expect(controls('?org=kubernetes&org=golang')).toMatchObject({
      org: ['kubernetes', 'golang'],
      repo: [],
    });
  });

  it('projects both org and repo when query text holds both clauses', () => {
    const projected = projectClauses(parseQuery('org:kubernetes repo:golang/go'));
    expect(projected.controls.org).toEqual(['kubernetes']);
    expect(projected.controls.repo).toEqual(['golang/go']);
    expect(projected.owners).toEqual({ org: 0, repo: 1 });
  });

  it('reports predicates no control can show as extras and leaves the control at its default', () => {
    expect(extras('?-label=bug')).toEqual([p(Field.LABEL, ['bug'], true)]);
    expect(extras('?-triage=acked')).toEqual([p(Field.TRIAGE, ['acked'], true)]);
    expect(extras('?draft=true')).toEqual([p(Field.DRAFT, ['true'])]);
    // Single-select state cannot display a multi-value state predicate
    const multiState = projectClauses(parseQuery('state:open,closed'));
    expect(multiState.controls.state).toBe('all');
    expect(multiState.extras).toEqual([
      { predicate: p(Field.STATE, ['open', 'closed']), index: 0 },
    ]);
  });

  it('derives the New tab when there is no triage predicate and activity is exactly [any], and projects activity on other tabs', () => {
    const newTab = projectUrl('?triage=activity');
    expect(newTab.controls.triage).toBe('activity');
    expect(newTab.controls.activity).toEqual(['any']);
    expect(newTab.owners).toEqual({ triage: 0, activity: 0 });
    expect(newTab.extras).toEqual([]);

    const ackedWithNewAny = projectUrl('?triage=acked&new=any');
    expect(ackedWithNewAny.controls.triage).toBe('acked');
    expect(ackedWithNewAny.controls.activity).toEqual(['any']);
    expect(ackedWithNewAny.owners).toEqual({ triage: 0, activity: 1 });
    expect(ackedWithNewAny.extras).toEqual([]);
  });

  it('projects is: shorthands and records clause indices (skipping error/incomplete clauses)', () => {
    const parsed = parseQuery('lable:bad is:open -label:wontfix is:pr label: display');
    const projected = projectClauses(parsed);

    expect(projected.controls.state).toBe('open');
    expect(projected.controls.type).toBe('pr');
    // Clauses: 0=lable:bad (error), 1=is:open (ok), 2=-label:wontfix (ok extra), 3=is:pr (ok), 4=label: (incomplete), 5=display (ok term extra)
    expect(projected.owners).toEqual({ state: 1, type: 3 });
    expect(projected.extras).toEqual([
      { predicate: p(Field.LABEL, ['wontfix'], true), index: 2 },
      { predicate: p(Field.TEXT, ['display'], false), index: 5 },
    ]);
  });
});

describe('resolveActivityValues', () => {
  it('enforces Any vs specific activity exclusivity while allowing noise to combine with Any', () => {
    expect(resolveActivityValues([], ['mention', 'code'])).toEqual(['mention', 'code']);
    expect(resolveActivityValues(['mention', 'noise'], ['mention', 'noise', 'any'])).toEqual([
      'noise',
      'any',
    ]);
    expect(resolveActivityValues(['any'], ['any', 'comment'])).toEqual(['comment']);
    expect(resolveActivityValues(['any'], ['any', 'noise'])).toEqual(['any', 'noise']);
  });
});

describe('workflowState', () => {
  it('is the default state on the given tab', () => {
    expect(workflowState('inbox')).toEqual(DEFAULT_QUERY_STATE);
    expect(serializeDashboardUrl(workflowState('activity'))).toBe('q=new:any');
    expect(serializeDashboardUrl(workflowState('acked'))).toBe('q=triage:acked');
    expect(serializeDashboardUrl(workflowState('all'))).toBe('q=triage:all');
  });
});

describe('isDefaultQuery and activeQueryCount', () => {
  it('detects the default state', () => {
    expect(isDefaultQuery(DEFAULT_QUERY_STATE)).toBe(true);
    expect(isDefaultQuery(parseDashboardUrl('?triage=acked').state)).toBe(false);
    expect(isDefaultQuery(parseDashboardUrl('?milestone=v1.32').state)).toBe(false);
    expect(isDefaultQuery(parseDashboardUrl('?tracking=tracked').state)).toBe(false);
    expect(isDefaultQuery(parseDashboardUrl('?tracking=all').state)).toBe(true);
  });

  it('counts active filter dimensions like the legacy filter count', () => {
    expect(activeQueryCount(DEFAULT_QUERY_STATE)).toBe(0);
    expect(
      activeQueryCount(
        parseDashboardUrl('?triage=activity&repo=kubernetes/kubernetes&milestone=v1.32&assigned=me').state
      )
    ).toBe(4);
    expect(activeQueryCount(parseDashboardUrl('?tracking=untracked').state)).toBe(1);
    expect(activeQueryCount(parseDashboardUrl('?q=x+y&sort=created&order=asc').state)).toBe(2);
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
    const empty = projectClauses(parseQuery(''));
    expect(hasActiveFilterChips(empty.controls, empty.extras)).toBe(false);

    // On the New tab, new:any is represented by the tab itself and does not produce a chip
    const newTab = projectUrl('?triage=activity');
    expect(newTab.controls.triage).toBe('activity');
    expect(newTab.controls.activity).toEqual(['any']);
    expect(hasActiveFilterChips(newTab.controls, newTab.extras)).toBe(false);

    // On Acked or Inbox, activity selections (including new:any or new:any,noise) do produce chips
    const ackedNewAny = projectUrl('?triage=acked&new=any');
    expect(hasActiveFilterChips(ackedNewAny.controls, ackedNewAny.extras)).toBe(true);

    const anyPlusNoise = projectUrl('?new=any&new=noise');
    expect(hasActiveFilterChips(anyPlusNoise.controls, anyPlusNoise.extras)).toBe(true);

    // Extra predicates (such as negated filters) also count as active chips
    const negated = projectUrl('?-label=bug');
    expect(hasActiveFilterChips(negated.controls, negated.extras)).toBe(true);
  });
});

describe('resolveQueryErrors', () => {
  it('formats singular and plural summary messages from parse issues and excludes excludedClauseIndex', () => {
    const single = parseQuery('lable:bug is:open');
    const resolvedSingle = resolveQueryErrors(single);
    expect(resolvedSingle.summary).toBe(
      '1 part of the query is ignored: lable is not a known filter. Quote it to search for the text: "lable:bug"'
    );

    const multiple = parseQuery('lable:bug state:bogus label:');
    const resolvedMulti = resolveQueryErrors(multiple);
    expect(resolvedMulti.summary).toBe(
      '3 parts of the query are ignored: lable is not a known filter. Quote it to search for the text: "lable:bug"'
    );

    // Excluding the trailing incomplete clause while editing reduces the count to 2
    const resolvedExcluded = resolveQueryErrors(multiple, null, { excludedClauseIndex: 2 });
    expect(resolvedExcluded.summary).toBe(
      '2 parts of the query are ignored: lable is not a known filter. Quote it to search for the text: "lable:bug"'
    );
  });

  it('maps server ExprError paths via clauseOfPredicate across skipped invalid clauses', () => {
    // Clause 0 is invalid (skipped from predicates); Clause 1 is predicate[0]; Clause 2 is predicate[1]
    const parsed = parseQuery('lable:bug state:open label:bad');
    const resolved = resolveQueryErrors(parsed, {
      path: 'and.exprs[1]',
      message: 'label "bad" is not supported',
    });

    expect(resolved.serverClauseErrors.get(2)).toBe('label "bad" is not supported');
    expect(resolved.serverRootError).toBeNull();
    expect(resolved.messages).toEqual([
      'lable is not a known filter. Quote it to search for the text: "lable:bug"',
      'label "bad" is not supported',
    ]);
    expect(resolved.summary).toBe(
      '2 parts of the query are ignored: lable is not a known filter. Quote it to search for the text: "lable:bug"'
    );
  });

  it('reports root-level or unmatched server ExprError paths in the summary line', () => {
    const parsed = parseQuery('state:open');
    const resolved = resolveQueryErrors(parsed, {
      path: 'and',
      message: 'root query rejected',
    });
    expect(resolved.serverClauseErrors.size).toBe(0);
    expect(resolved.serverRootError).toBe('root query rejected');
    expect(resolved.summary).toBe('1 part of the query is ignored: root query rejected');
  });
});
