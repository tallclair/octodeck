import { describe, it, expect } from 'vitest';
import { DEFAULT_QUERY_STATE, type DashboardQueryState } from '../../../types/filters';
import { parseDashboardUrl, serializeDashboardUrl } from '../urlCodec';

const state = (overrides: Partial<DashboardQueryState>): DashboardQueryState => ({
  ...DEFAULT_QUERY_STATE,
  ...overrides,
});

describe('parseDashboardUrl', () => {
  it('returns the default state and empty canonicalSearch for empty input', () => {
    expect(parseDashboardUrl('')).toEqual({ state: DEFAULT_QUERY_STATE, canonicalSearch: '' });
    expect(parseDashboardUrl('?')).toEqual({ state: DEFAULT_QUERY_STATE, canonicalSearch: '' });
    expect(parseDashboardUrl(new URLSearchParams())).toEqual({
      state: DEFAULT_QUERY_STATE,
      canonicalSearch: '',
    });
  });

  it.each([
    [
      '?repo=a/b&author=x&triage=acked&state=closed&label=bug',
      'repo:a/b author:x triage:acked state:closed label:bug',
      'q=repo:a/b+author:x+triage:acked+state:closed+label:bug',
    ],
    ['?triage=activity&repo=k/k', 'new:any repo:k/k', 'q=new:any+repo:k/k'],
    [
      '?assigned=me&-label=bug&label=a&label=b',
      'assignee:@me -label:bug label:a,b',
      'q=assignee:@me+-label:bug+label:a,b',
    ],
    [
      '?tracking=untracked&q=flaky+test',
      'tracking:false flaky test',
      'q=tracking:false+flaky+test',
    ],
    ['?label=good%20first%20issue', 'label:"good first issue"', 'q=label:%22good+first+issue%22'],
    ['?triage=inbox&sort=created&item=k/k%2312', '', 'sort=created&item=k/k%2312'],
    ['?q=is:open+++label:bug', 'is:open label:bug', 'q=is:open+label:bug'],
    ['?triage=inbox', '', ''],
    ['?triage=activity', 'new:any', 'q=new:any'],
    ['?assigned=me', 'assignee:@me', 'q=assignee:@me'],
    ['?tracking=tracked', 'tracking:true', 'q=tracking:true'],
    ['?tracking=untracked', 'tracking:false', 'q=tracking:false'],
    ['?author=@alice', 'author:alice', 'q=author:alice'],
    ['?author=@me', 'author:me', 'q=author:me'],
    [
      '?label=a&label=b&-label=wontfix',
      'label:a,b -label:wontfix',
      'q=label:a,b+-label:wontfix',
    ],
    [
      '?repo=a/b&q=flaky+"big+test"',
      'repo:a/b flaky "big test"',
      'q=repo:a/b+flaky+%22big+test%22',
    ],
    [
      '?repo=a/b&q=state:open+panic',
      'repo:a/b state:open panic',
      'q=repo:a/b+state:open+panic',
    ],
    [
      '?q=repo:a/b+is:open+panic',
      'repo:a/b is:open panic',
      'q=repo:a/b+is:open+panic',
    ],
  ])('migrates %s to text %j and canonical %j', (input, expectedText, expectedCanonical) => {
    const res = parseDashboardUrl(input);
    expect(res.state.text).toBe(expectedText);
    expect(res.canonicalSearch).toBe(expectedCanonical);
  });

  it('normalizes inter-clause whitespace via scan while preserving spaces inside quotes', () => {
    const res = parseDashboardUrl('?q=%20%20repo:a/b%20%20%20label:%22good%20%20first%22%20%20');
    expect(res.state.text).toBe('repo:a/b label:"good  first"');
    expect(res.canonicalSearch).toBe('q=repo:a/b+label:%22good++first%22');
  });

  it('preserves incomplete and error clauses in state.text', () => {
    const res = parseDashboardUrl('?q=state:bogus+repo:+foo:bar');
    expect(res.state.text).toBe('state:bogus repo: foo:bar');
    expect(res.canonicalSearch).toBe('q=state:bogus+repo:+foo:bar');
  });

  it('validates sort and order case-insensitively and trims item', () => {
    const { state: s, canonicalSearch } = parseDashboardUrl(
      '?q=is:pr&sort=CREATED&order=Asc&item=%20PR_123%20'
    );
    expect(s).toEqual({
      text: 'is:pr',
      sort: 'created',
      order: 'asc',
      item: 'PR_123',
    });
    expect(canonicalSearch).toBe('q=is:pr&sort=created&order=asc&item=PR_123');

    const { state: d } = parseDashboardUrl('?sort=bogus&order=sideways&item=%20');
    expect([d.sort, d.order, d.item]).toEqual(['updated', 'desc', null]);
  });
});

describe('serializeDashboardUrl', () => {
  it('writes nothing for the default state or whitespace-only text', () => {
    expect(serializeDashboardUrl(DEFAULT_QUERY_STATE)).toBe('');
    expect(serializeDashboardUrl(state({ text: '   ' }))).toBe('');
  });

  it('writes q, sort, order, and item in canonical order', () => {
    expect(
      serializeDashboardUrl(
        state({
          text: 'label:bug triage:acked x',
          sort: 'acked',
          order: 'asc',
          item: 'PR_1',
        })
      )
    ).toBe('q=label:bug+triage:acked+x&sort=acked&order=asc&item=PR_1');
  });

  it('leaves / : @ , readable and percent-encodes other reserved and non-ASCII characters', () => {
    expect(
      serializeDashboardUrl(
        state({
          text: 'repo:a/b -label:area:x,"a&b=c#d,e+f",ラベル assignee:@me',
        })
      )
    ).toBe(
      'q=repo:a/b+-label:area:x,%22a%26b%3Dc%23d,e%2Bf%22,%E3%83%A9%E3%83%99%E3%83%AB+assignee:@me'
    );
  });
});

describe('round trip', () => {
  it.each([
    '',
    'q=new:any',
    'q=triage:acked',
    'q=triage:all',
    'q=state:open',
    'q=is:open+type:pr+assignee:@me',
    'q=repo:kubernetes/kubernetes+label:kind/bug,area/apiserver+-author:bot',
    'q=flaky+%22big+test%22',
    'q=repo:a/b&sort=created&order=asc&item=PR_123',
  ])('canonical URL %j round-trips idempotently', (url) => {
    const first = parseDashboardUrl(url);
    expect(first.canonicalSearch).toBe(url);
    const second = parseDashboardUrl(first.canonicalSearch);
    expect(second).toEqual(first);
  });
});
