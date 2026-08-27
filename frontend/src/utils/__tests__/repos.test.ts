import { describe, it, expect } from 'vitest';
import {
  validateRepoPattern,
  validateRepoPatterns,
  validateRepoFilterPatterns,
  filterRepos,
  parseFilterPatterns,
  serializeFilterPatterns,
} from '../repos';

describe('repos utility functions', () => {
  describe('validateRepoPattern', () => {
    it('accepts valid exact and wildcard patterns', () => {
      expect(validateRepoPattern('kubernetes/kubernetes')).toBeNull();
      expect(validateRepoPattern('kubernetes/*')).toBeNull();
      expect(validateRepoPattern('*/website')).toBeNull();
      expect(validateRepoPattern('*/*')).toBeNull();
      expect(validateRepoPattern('kubernetes/test-*')).toBeNull();
      expect(validateRepoPattern('k8s.io/release-1.28')).toBeNull();
      expect(validateRepoPattern('!kubernetes/steering')).toBeNull();
    });

    it('rejects empty or whitespace-only patterns', () => {
      expect(validateRepoPattern('')).toBe('Repository pattern cannot be empty');
      expect(validateRepoPattern('   ')).toBe('Repository pattern cannot be empty');
      expect(validateRepoPattern('!')).toBe('Repository pattern cannot be empty');
      expect(validateRepoPattern('!  ')).toBe('Repository pattern cannot be empty');
    });

    it('rejects patterns missing slash or with multiple slashes', () => {
      expect(validateRepoPattern('kubernetes')).toContain('must be in "owner/repo" format');
      expect(validateRepoPattern('!kubernetes')).toContain('must be in "owner/repo" format');
      expect(validateRepoPattern('a/b/c')).toContain('must be in "owner/repo" format');
      expect(validateRepoPattern('/kubernetes')).toContain('must be in "owner/repo" format');
      expect(validateRepoPattern('kubernetes/')).toContain('must be in "owner/repo" format');
    });

    it('rejects invalid characters', () => {
      expect(validateRepoPattern('kubernetes/foo$bar')).toContain('contains invalid character "$"');
      expect(validateRepoPattern('kubernetes / kubernetes')).toContain('contains invalid character " "');
    });

    it('rejects patterns exceeding 100 characters', () => {
      const longPattern = 'kubernetes/' + 'a'.repeat(95);
      expect(validateRepoPattern(longPattern)).toContain('exceeds maximum length of 100 characters');
    });
  });

  describe('validateRepoPatterns and validateRepoFilterPatterns', () => {
    it('validates a list of patterns', () => {
      expect(validateRepoPatterns(['kubernetes/*', 'golang/go', '!kubernetes/steering'])).toBeNull();
      expect(validateRepoPatterns(['', '  '])).toBeNull();
      expect(validateRepoPatterns(['valid/repo', 'invalid'])).toContain('must be in "owner/repo" format');
    });

    it('validates multiline text', () => {
      expect(validateRepoFilterPatterns('kubernetes/*\n!kubernetes/steering\ngolang/*')).toBeNull();
      expect(validateRepoFilterPatterns('kubernetes/*\n!\n')).toContain('cannot be empty');
      expect(validateRepoFilterPatterns('kubernetes/*\ninvalid_repo\n')).toContain('must be in "owner/repo" format');
    });
  });

  describe('parseFilterPatterns and serializeFilterPatterns', () => {
    it('parses mixed include and exclude lines', () => {
      const input = `
        kubernetes/*
        !kubernetes/steering
        golang/*
        !golang/proposal
      `;
      const parsed = parseFilterPatterns(input);
      expect(parsed.includes).toEqual(['kubernetes/*', 'golang/*']);
      expect(parsed.excludes).toEqual(['kubernetes/steering', 'golang/proposal']);
    });

    it('serializes includes and excludes to multi-line string', () => {
      const serialized = serializeFilterPatterns(
        ['kubernetes/*', 'golang/*'],
        ['kubernetes/steering', 'golang/proposal']
      );
      expect(serialized).toBe('kubernetes/*\ngolang/*\n!kubernetes/steering\n!golang/proposal');
    });
  });

  describe('filterRepos', () => {
    const repos = ['kubernetes/kubernetes', 'kubernetes/website', 'golang/go', 'kubernetes/test-infra'];

    it('returns all repos when patterns are empty', () => {
      expect(filterRepos(repos, [], [])).toEqual(repos);
    });

    it('filters repos by include wildcard pattern', () => {
      expect(filterRepos(repos, ['kubernetes/*'], [])).toEqual([
        'kubernetes/kubernetes',
        'kubernetes/website',
        'kubernetes/test-infra',
      ]);
    });

    it('filters repos by exclude wildcard pattern', () => {
      expect(filterRepos(repos, [], ['kubernetes/test-infra', 'golang/*'])).toEqual([
        'kubernetes/kubernetes',
        'kubernetes/website',
      ]);
    });

    it('filters repos by combined include and exclude patterns with exclude precedence', () => {
      expect(filterRepos(repos, ['kubernetes/*'], ['kubernetes/test-infra'])).toEqual([
        'kubernetes/kubernetes',
        'kubernetes/website',
      ]);
    });
  });
});
