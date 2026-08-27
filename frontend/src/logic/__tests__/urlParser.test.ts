import { describe, it, expect } from 'vitest';
import { UrlParser } from '../urlParser';

describe('UrlParser', () => {
  it('should parse valid pull request URLs', () => {
    const url = 'https://github.com/kubernetes/kubernetes/pull/123';
    const result = UrlParser.parse(url);
    expect(result).toEqual({
      owner: 'kubernetes',
      repo: 'kubernetes',
      number: 123,
    });
  });

  it('should parse valid issue URLs', () => {
    const url = 'https://github.com/kubernetes/website/issues/456';
    const result = UrlParser.parse(url);
    expect(result).toEqual({
      owner: 'kubernetes',
      repo: 'website',
      number: 456,
    });
  });

  it('should return null for invalid URLs', () => {
    expect(UrlParser.parse('https://github.com/org/repo/pulls')).toBeNull();
    expect(UrlParser.parse('https://google.com')).toBeNull();
    expect(UrlParser.parse('invalid-url')).toBeNull();
  });

  it('should ignore extra path segments', () => {
     const url = 'https://github.com/kubernetes/kubernetes/pull/123/files';
     const result = UrlParser.parse(url);
     expect(result).toEqual({
       owner: 'kubernetes',
       repo: 'kubernetes',
       number: 123,
     });
  });
});
