import { describe, it, expect } from 'vitest';
import { Field } from '../../../api/octodeck/v1/query_pb';
import { DEFAULT_QUERY_STATE, type DashboardQueryState, type FilterPredicate } from '../../../types/filters';
import { parseQueryParams, serializeQueryParams } from '../urlCodec';

const p = (field: Field, values: string[], negated = false): FilterPredicate => ({ field, values, negated });
const preds = (search: string) => parseQueryParams(search).predicates;
const state = (overrides: Partial<DashboardQueryState>): DashboardQueryState => ({ ...DEFAULT_QUERY_STATE, ...overrides });

const AC_URL = 'repo=a/b&author=x&triage=acked&state=closed&label=bug';

describe('parseQueryParams', () => {
  it('returns the default state for empty input', () => {
    expect(parseQueryParams('')).toEqual(DEFAULT_QUERY_STATE);
    expect(parseQueryParams('?')).toEqual(DEFAULT_QUERY_STATE);
    expect(parseQueryParams(new URLSearchParams())).toEqual(DEFAULT_QUERY_STATE);
  });

  it('parses the legacy example URL into predicates in URL order', () => {
    expect(preds(`?${AC_URL}`)).toEqual([
      p(Field.REPO, ['a/b']),
      p(Field.AUTHOR, ['x']),
      p(Field.TRIAGE, ['acked']),
      p(Field.STATE, ['closed']),
      p(Field.LABEL, ['bug']),
    ]);
  });

  it('accepts percent-encoded slashes in legacy links', () => {
    expect(preds('?repo=kubernetes%2Fkubernetes')).toEqual([p(Field.REPO, ['kubernetes/kubernetes'])]);
  });

  it('maps the triage tabs', () => {
    expect(preds('?triage=inbox')).toEqual([]);
    expect(preds('?triage=acked')).toEqual([p(Field.TRIAGE, ['acked'])]);
    expect(preds('?triage=all')).toEqual([p(Field.TRIAGE, ['all'])]);
    expect(preds('?triage=ACKED')).toEqual([p(Field.TRIAGE, ['acked'])]);
    expect(preds('?triage=bogus')).toEqual([]);
    expect(preds('?triage=')).toEqual([]);
  });

  it('maps triage=activity to new:any with no triage predicate', () => {
    expect(preds('?triage=activity')).toEqual([p(Field.NEW, ['any'])]);
  });

  it('parses state, ignoring the legacy all sentinel and invalid values', () => {
    expect(preds('?state=open')).toEqual([p(Field.STATE, ['open'])]);
    expect(preds('?state=closed')).toEqual([p(Field.STATE, ['closed'])]);
    expect(preds('?state=merged')).toEqual([p(Field.STATE, ['merged'])]);
    expect(preds('?state=all')).toEqual([]);
    expect(preds('?state=invalid')).toEqual([]);
  });

  it('parses type', () => {
    expect(preds('?type=pr')).toEqual([p(Field.TYPE, ['pr'])]);
    expect(preds('?type=issue')).toEqual([p(Field.TYPE, ['issue'])]);
    expect(preds('?type=all')).toEqual([]);
    expect(preds('?type=other')).toEqual([]);
  });

  it('maps assigned=me to assignee:@me and reads assignee= verbatim', () => {
    expect(preds('?assigned=me')).toEqual([p(Field.ASSIGNEE, ['@me'])]);
    expect(preds('?assigned=all')).toEqual([]);
    expect(preds('?assigned=other')).toEqual([]);
    expect(preds('?assignee=bob')).toEqual([p(Field.ASSIGNEE, ['bob'])]);
    expect(preds('?assignee=bob&assigned=me')).toEqual([p(Field.ASSIGNEE, ['bob']), p(Field.ASSIGNEE, ['@me'])]);
    expect(preds('?assigned=me&assignee=@me')).toEqual([p(Field.ASSIGNEE, ['@me'])]);
  });

  it('maps tracking to a boolean', () => {
    expect(preds('?tracking=tracked')).toEqual([p(Field.TRACKING, ['true'])]);
    expect(preds('?tracking=untracked')).toEqual([p(Field.TRACKING, ['false'])]);
    expect(preds('?tracking=TRACKED')).toEqual([p(Field.TRACKING, ['true'])]);
    expect(preds('?tracking=UnTracked')).toEqual([p(Field.TRACKING, ['false'])]);
    expect(preds('?tracking=true')).toEqual([p(Field.TRACKING, ['true'])]);
    expect(preds('?tracking=all')).toEqual([]);
    expect(preds('?tracking=invalid')).toEqual([]);
    expect(preds('?tracking=')).toEqual([]);
  });

  it('strips one leading @ from author (author=@me is the login "me")', () => {
    expect(preds('?author=@alice')).toEqual([p(Field.AUTHOR, ['alice'])]);
    expect(preds('?author=@me')).toEqual([p(Field.AUTHOR, ['me'])]);
    expect(preds('?author=@')).toEqual([]);
  });

  it('lets repo win over org, and keeps org alone', () => {
    expect(preds('?repo=a/b&org=a')).toEqual([p(Field.REPO, ['a/b'])]);
    expect(preds('?org=a')).toEqual([p(Field.ORG, ['a'])]);
  });

  it('trims open values and drops empty ones', () => {
    const s = parseQueryParams('?milestone=%20v1.32%20&label=%20&repo=%20a/b&item=%20PR_1%20');
    expect(s.predicates).toEqual([p(Field.MILESTONE, ['v1.32']), p(Field.REPO, ['a/b'])]);
    expect(s.item).toBe('PR_1');
  });

  it('turns repeated parameters into one OR predicate, without duplicates', () => {
    expect(preds('?label=a&label=b&label=a')).toEqual([p(Field.LABEL, ['a', 'b'])]);
  });

  it('turns a -key= prefix into negation', () => {
    expect(preds('?-label=bug')).toEqual([p(Field.LABEL, ['bug'], true)]);
    expect(preds('?label=a&-label=b')).toEqual([p(Field.LABEL, ['a']), p(Field.LABEL, ['b'], true)]);
    expect(preds('?-label=a&-label=b')).toEqual([p(Field.LABEL, ['a', 'b'], true)]);
    expect(preds('?-triage=acked')).toEqual([p(Field.TRIAGE, ['acked'], true)]);
  });

  it('drops invalid closed values inside a multi-value predicate', () => {
    expect(preds('?state=open&state=bogus')).toEqual([p(Field.STATE, ['open'])]);
    expect(preds('?state=bogus&state=nope')).toEqual([]);
  });

  it('ignores unknown keys and meaningless negations', () => {
    expect(preds('?utm=1&--label=x&-triage=activity&-in=title')).toEqual([]);
  });

  it('parses the query keys that have no control', () => {
    expect(preds('?draft=true&starred=FALSE&new=mention&no=label&in=title')).toEqual([
      p(Field.DRAFT, ['true']),
      p(Field.STARRED, ['false']),
      p(Field.NEW, ['mention']),
      p(Field.NO, ['label']),
      p(Field.IN, ['title']),
    ]);
  });

  it('keeps triage=activity and other new: values as separate predicates', () => {
    expect(preds('?triage=activity&new=mention')).toEqual([p(Field.NEW, ['any']), p(Field.NEW, ['mention'])]);
    expect(preds('?triage=activity&new=any')).toEqual([p(Field.NEW, ['any'])]);
  });

  it('keeps the raw search text, trimmed', () => {
    expect(parseQueryParams('?q=flaky+%22big+test%22').q).toBe('flaky "big test"');
    expect(parseQueryParams('?q=%20scheduler%20').q).toBe('scheduler');
  });

  it('validates sort and order case-insensitively and keeps the item', () => {
    const s = parseQueryParams('?sort=CREATED&order=Asc&item=PR_123');
    expect([s.sort, s.order, s.item]).toEqual(['created', 'asc', 'PR_123']);
    const d = parseQueryParams('?sort=bogus&order=sideways');
    expect([d.sort, d.order, d.item]).toEqual(['updated', 'desc', null]);
  });
});

describe('serializeQueryParams', () => {
  it('writes nothing for the default state', () => {
    expect(serializeQueryParams(DEFAULT_QUERY_STATE)).toBe('');
  });

  it('writes predicates in list order, then q, sort, order and item', () => {
    expect(
      serializeQueryParams(
        state({
          predicates: [p(Field.LABEL, ['bug']), p(Field.TRIAGE, ['acked'])],
          q: 'x',
          sort: 'acked',
          order: 'asc',
          item: 'PR_1',
        })
      )
    ).toBe('label=bug&triage=acked&q=x&sort=acked&order=asc&item=PR_1');
  });

  it('writes new:any as triage=activity only when there is no triage predicate', () => {
    expect(serializeQueryParams(state({ predicates: [p(Field.NEW, ['any'])] }))).toBe('triage=activity');
    expect(serializeQueryParams(state({ predicates: [p(Field.TRIAGE, ['acked']), p(Field.NEW, ['any'])] }))).toBe(
      'triage=acked&new=any'
    );
  });

  it('writes the assigned-to-me predicate with the legacy key', () => {
    expect(serializeQueryParams(state({ predicates: [p(Field.ASSIGNEE, ['@me'])] }))).toBe('assigned=me');
    expect(serializeQueryParams(state({ predicates: [p(Field.ASSIGNEE, ['@me'], true)] }))).toBe('-assigned=me');
    expect(serializeQueryParams(state({ predicates: [p(Field.ASSIGNEE, ['@me', 'bob'])] }))).toBe(
      'assignee=@me&assignee=bob'
    );
  });

  it('writes tracking as tracked/untracked', () => {
    expect(serializeQueryParams(state({ predicates: [p(Field.TRACKING, ['true'])] }))).toBe('tracking=tracked');
    expect(serializeQueryParams(state({ predicates: [p(Field.TRACKING, ['false'])] }))).toBe('tracking=untracked');
  });

  it('leaves / : @ readable and percent-encodes other reserved and non-ASCII characters', () => {
    expect(
      serializeQueryParams(
        state({ predicates: [p(Field.REPO, ['a/b']), p(Field.LABEL, ['area:x', 'a&b=c#d,e+f', 'ラベル'], true)], q: 'a b' })
      )
    ).toBe('repo=a/b&-label=area:x&-label=a%26b%3Dc%23d%2Ce%2Bf&-label=%E3%83%A9%E3%83%99%E3%83%AB&q=a+b');
  });

  it('omits default sort and order and blank search text, and trims q', () => {
    expect(serializeQueryParams(state({ q: '   ' }))).toBe('');
    expect(serializeQueryParams(state({ q: ' foo ' }))).toBe('q=foo');
  });

  it('writes repeated parameters for multiple values and -key= for negation', () => {
    expect(serializeQueryParams(state({ predicates: [p(Field.LABEL, ['a', 'b']), p(Field.AUTHOR, ['bot'], true)] }))).toBe(
      'label=a&label=b&-author=bot'
    );
  });
});

describe('round trip', () => {
  it('round-trips the legacy example URL exactly', () => {
    expect(serializeQueryParams(parseQueryParams(`?${AC_URL}`))).toBe(AC_URL);
  });

  it.each([
    'triage=activity',
    'triage=acked',
    'triage=all',
    'state=open',
    'state=closed',
    'type=pr',
    'type=issue',
    'assigned=me',
    'tracking=tracked',
    'tracking=untracked',
    'repo=a/b',
    'org=a',
    'author=x',
    'milestone=v1.32',
    'label=kind/bug',
    'triage=activity&state=closed&type=pr&assigned=me&tracking=tracked&repo=kubernetes/kubernetes&author=alice&milestone=v1.32&label=kind/bug&q=fix+bug&sort=created&order=asc&item=PR_123',
    'label=a&label=b',
    '-label=bug&-author=bot',
    'label=area:x',
    'label=a%26b%3Dc',
    'label=%E3%83%A9%E3%83%99%E3%83%AB',
    'q=flaky+%22big+test%22',
    'draft=true&starred=false&new=mention&no=label&in=title',
    'state=merged&-triage=acked&assignee=bob',
    'assignee=bob&assigned=me',
  ])('canonical URL %s round-trips exactly', (url) => {
    expect(serializeQueryParams(parseQueryParams(url))).toBe(url);
  });

  it.each([
    ['triage=inbox', ''],
    ['state=all&type=all&assigned=all&tracking=all', ''],
    ['author=@x', 'author=x'],
    ['triage=ACKED', 'triage=acked'],
    ['new=any', 'triage=activity'],
    ['repo=a/b&org=a', 'repo=a/b'],
    ['q=x&repo=a/b', 'repo=a/b&q=x'],
    ['label=a&repo=x&label=b', 'label=a&label=b&repo=x'],
    ['repo=a%2Fb', 'repo=a/b'],
    ['utm=1&label=bug', 'label=bug'],
    ['assignee=@me', 'assigned=me'],
    ['triage=activity&triage=acked', 'new=any&triage=acked'],
  ])('normalizes %s to %s, idempotently', (input, normalized) => {
    expect(serializeQueryParams(parseQueryParams(input))).toBe(normalized);
    expect(serializeQueryParams(parseQueryParams(normalized))).toBe(normalized);
  });
});
