import { describe, expect, it } from 'vitest';
import { parseQuery, suggest, summarize } from './parser';

describe('prototype query parser', () => {
  it('parses qualifiers, negation, quoted values and text', () => {
    const s = summarize('is:open repo:a/b label:"good first issue" -author:bot flaky "exact phrase"');
    expect(s.predicates).toEqual([
      { field: 'state', values: ['open'], negated: false },
      { field: 'repo', values: ['a/b'], negated: false },
      { field: 'label', values: ['good first issue'], negated: false },
      { field: 'author', values: ['bot'], negated: true },
      { field: 'text', values: ['flaky'], negated: false },
      { field: 'text', values: ['exact phrase'], negated: false },
    ]);
    expect(s.implicitInbox).toBe(true);
  });

  it('flags mixed is: dimensions, unknown keys and illegal closed values', () => {
    const [mixed, unknown, bad] = parseQuery('is:open,pr typ:pr state:opne');
    expect(mixed.status).toBe('error');
    expect(unknown.status).toBe('error');
    expect(bad.status).toBe('error');
    expect(bad.values[0].invalid).toBe(true);
  });

  it('suggests keys and values', () => {
    expect(suggest('lab', 3, false)?.items[0].insert).toBe('label:');
    const r = suggest('label:good', 10, false);
    expect(r?.items[0].insert).toBe('"good first issue"');
    expect(r?.start).toBe(6);
  });
});
