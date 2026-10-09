import { describe, it, expect } from 'vitest';
import { tokenizeSearch } from '../textTerms';

describe('tokenizeSearch', () => {
  it('returns no terms for empty or blank input', () => {
    expect(tokenizeSearch('')).toEqual([]);
    expect(tokenizeSearch('   ')).toEqual([]);
    expect(tokenizeSearch('\t\n')).toEqual([]);
  });

  it('splits words on any whitespace', () => {
    expect(tokenizeSearch('flaky  test\tnow')).toEqual(['flaky', 'test', 'now']);
  });

  it('keeps a quoted phrase as one term', () => {
    expect(tokenizeSearch('"flaky test"')).toEqual(['flaky test']);
  });

  it('mixes words and phrases in order', () => {
    expect(tokenizeSearch('a "b c" d')).toEqual(['a', 'b c', 'd']);
  });

  it('runs an unterminated quote to the end of the input', () => {
    expect(tokenizeSearch('x "big test')).toEqual(['x', 'big test']);
  });

  it('drops empty phrases', () => {
    expect(tokenizeSearch('"" a "  "')).toEqual(['a']);
  });

  it('trims phrase ends but keeps inner spacing', () => {
    expect(tokenizeSearch('" a  b "')).toEqual(['a  b']);
  });

  it('starts a phrase at a quote inside a word', () => {
    expect(tokenizeSearch('foo"bar baz"')).toEqual(['foo', 'bar baz']);
  });

  it('passes item numbers through unchanged', () => {
    expect(tokenizeSearch('#123 123')).toEqual(['#123', '123']);
  });

  it('does not interpret qualifiers or negation', () => {
    expect(tokenizeSearch('repo:foo -bar')).toEqual(['repo:foo', '-bar']);
  });
});
