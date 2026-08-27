import { describe, it, expect } from 'vitest';
import {
  matchWildcard,
  parseFilterPatterns,
  serializeFilterPatterns,
  validateBasePattern,
  validatePatterns,
  validateFilterPatterns,
  matchesFilter,
  filterByPatterns,
} from '../patterns';

describe('patterns utils', () => {
  describe('matchWildcard', () => {
    it('matches exact strings case-insensitively', () => {
      expect(matchWildcard('foo', 'foo')).toBe(true);
      expect(matchWildcard('FOO', 'foo')).toBe(true);
      expect(matchWildcard('foo', 'FOO')).toBe(true);
      expect(matchWildcard('foo', 'bar')).toBe(false);
    });

    it('matches * wildcards', () => {
      expect(matchWildcard('*', 'anything')).toBe(true);
      expect(matchWildcard('kubernetes/*', 'kubernetes/kubernetes')).toBe(true);
      expect(matchWildcard('kubernetes/*', 'kubernetes/community')).toBe(true);
      expect(matchWildcard('kubernetes/*', 'golang/go')).toBe(false);
      expect(matchWildcard('*bug*', 'kind/bug/fix')).toBe(true);
      expect(matchWildcard('*bug*', 'kind/feature')).toBe(false);
    });

    it('matches ? single character wildcards', () => {
      expect(matchWildcard('size/?', 'size/s')).toBe(true);
      expect(matchWildcard('size/?', 'size/m')).toBe(true);
      expect(matchWildcard('size/?', 'size/xxl')).toBe(false);
    });
  });

  describe('parseFilterPatterns', () => {
    it('parses multi-line includes and excludes', () => {
      const input = 'kubernetes/*\n!kubernetes/steering\ngolang/*\n!golang/proposal\n  \n';
      const result = parseFilterPatterns(input);
      expect(result).toEqual({
        includes: ['kubernetes/*', 'golang/*'],
        excludes: ['kubernetes/steering', 'golang/proposal'],
      });
    });

    it('ignores empty lines and whitespace', () => {
      expect(parseFilterPatterns('')).toEqual({ includes: [], excludes: [] });
      expect(parseFilterPatterns('   \n\n  ')).toEqual({ includes: [], excludes: [] });
    });
  });

  describe('serializeFilterPatterns', () => {
    it('serializes includes and excludes to multi-line string', () => {
      const serialized = serializeFilterPatterns(
        ['kubernetes/*', 'golang/*'],
        ['kubernetes/steering', 'golang/proposal']
      );
      expect(serialized).toBe('kubernetes/*\ngolang/*\n!kubernetes/steering\n!golang/proposal');
    });

    it('handles empty or missing arrays', () => {
      expect(serializeFilterPatterns(undefined, undefined)).toBe('');
      expect(serializeFilterPatterns(['kubernetes/*'], undefined)).toBe('kubernetes/*');
      expect(serializeFilterPatterns(undefined, ['kubernetes/test'])).toBe('!kubernetes/test');
    });
  });

  describe('validateBasePattern', () => {
    it('validates standard patterns and handles ! prefix', () => {
      const validInclude = validateBasePattern('kubernetes/*', 'Test');
      expect(validInclude.valid).toBe(true);
      if (validInclude.valid) {
        expect(validInclude.cleanPattern).toBe('kubernetes/*');
        expect(validInclude.isExclude).toBe(false);
      }

      const validExclude = validateBasePattern('!kubernetes/steering', 'Test');
      expect(validExclude.valid).toBe(true);
      if (validExclude.valid) {
        expect(validExclude.cleanPattern).toBe('kubernetes/steering');
        expect(validExclude.isExclude).toBe(true);
      }
    });

    it('errors on empty pattern or empty exclude', () => {
      expect(validateBasePattern('', 'Test').error).toBe('Test pattern cannot be empty');
      expect(validateBasePattern('   ', 'Test').error).toBe('Test pattern cannot be empty');
      expect(validateBasePattern('!', 'Test').error).toBe('Test pattern cannot be empty');
      expect(validateBasePattern('!  ', 'Test').error).toBe('Test pattern cannot be empty');
    });

    it('errors on control characters or excessive length', () => {
      expect(validateBasePattern('test\x00pattern', 'Test').error).toContain('contains invalid control characters');
      expect(validateBasePattern('a'.repeat(101), 'Test').error).toContain('exceeds maximum length');
    });
  });

  describe('validatePatterns and validateFilterPatterns', () => {
    it('validates pattern arrays and strings using validator callback', () => {
      const validator = (p: string) => (p.includes('invalid') ? 'Invalid pattern' : null);

      expect(validatePatterns(['good', 'valid', ''], validator)).toBeNull();
      expect(validatePatterns(['good', 'invalid', 'valid'], validator)).toBe('Invalid pattern');

      expect(validateFilterPatterns('good\nvalid\n', validator)).toBeNull();
      expect(validateFilterPatterns('good\ninvalid\nvalid', validator)).toBe('Invalid pattern');
    });
  });

  describe('matchesFilter', () => {
    it('returns true when no filters are set', () => {
      expect(matchesFilter('anything', undefined, undefined)).toBe(true);
      expect(matchesFilter('anything', [], [])).toBe(true);
    });

    it('handles includes and excludes with exclude precedence', () => {
      const includes = ['kubernetes/*', 'golang/*'];
      const excludes = ['kubernetes/steering'];

      expect(matchesFilter('kubernetes/kubernetes', includes, excludes)).toBe(true);
      expect(matchesFilter('golang/go', includes, excludes)).toBe(true);
      expect(matchesFilter('kubernetes/steering', includes, excludes)).toBe(false);
      expect(matchesFilter('rust-lang/rust', includes, excludes)).toBe(false);
    });
  });

  describe('filterByPatterns', () => {
    it('filters items using identifier callback', () => {
      const items = [
        { id: 1, name: 'kubernetes/kubernetes' },
        { id: 2, name: 'kubernetes/steering' },
        { id: 3, name: 'golang/go' },
        { id: 4, name: 'rust-lang/rust' },
      ];

      const result = filterByPatterns(
        items,
        item => item.name,
        ['kubernetes/*', 'golang/*'],
        ['kubernetes/steering']
      );

      expect(result).toEqual([
        { id: 1, name: 'kubernetes/kubernetes' },
        { id: 3, name: 'golang/go' },
      ]);
    });
  });
});
