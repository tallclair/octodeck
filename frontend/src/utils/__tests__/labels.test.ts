import { describe, it, expect } from 'vitest';
import {
  getLabelStyle,
  matchWildcard,
  validateLabelPattern,
  validateLabelPatterns,
  validateLabelFilterPatterns,
  filterLabels,
} from '../labels';

describe('labels utility', () => {
  describe('getLabelStyle', () => {
    it('returns readable dark text and solid background for light colors like needs-triage', () => {
      const style = getLabelStyle('ededed');
      expect(style.backgroundColor).toBe('#ededed');
      expect(style.color).toBe('#0f172a');
      expect(style.borderColor).toBe('rgba(0, 0, 0, 0.18)');
    });

    it('returns readable dark text for bright yellow and white labels', () => {
      const yellowStyle = getLabelStyle('#fbca04');
      expect(yellowStyle.backgroundColor).toBe('#fbca04');
      expect(yellowStyle.color).toBe('#0f172a');

      const whiteStyle = getLabelStyle('ffffff');
      expect(whiteStyle.backgroundColor).toBe('#ffffff');
      expect(whiteStyle.color).toBe('#0f172a');
    });

    it('returns readable white text and solid background for dark colors', () => {
      const redStyle = getLabelStyle('d73a4a');
      expect(redStyle.backgroundColor).toBe('#d73a4a');
      expect(redStyle.color).toBe('#ffffff');

      const blueStyle = getLabelStyle('#0075ca');
      expect(blueStyle.backgroundColor).toBe('#0075ca');
      expect(blueStyle.color).toBe('#ffffff');

      const blackStyle = getLabelStyle('000000');
      expect(blackStyle.backgroundColor).toBe('#000000');
      expect(blackStyle.color).toBe('#ffffff');
    });

    it('handles 3-digit shorthand hex colors', () => {
      const style = getLabelStyle('fff');
      expect(style.backgroundColor).toBe('#ffffff');
      expect(style.color).toBe('#0f172a');

      const darkStyle = getLabelStyle('#000');
      expect(darkStyle.backgroundColor).toBe('#000000');
      expect(darkStyle.color).toBe('#ffffff');
    });

    it('returns fallback styling when color is missing or invalid', () => {
      const emptyStyle = getLabelStyle('');
      expect(emptyStyle.backgroundColor).toBe('#64748b');
      expect(emptyStyle.color).toBe('#ffffff');

      const undefStyle = getLabelStyle(undefined);
      expect(undefStyle.backgroundColor).toBe('#64748b');
      expect(undefStyle.color).toBe('#ffffff');

      const invalidStyle = getLabelStyle('not-a-color');
      expect(invalidStyle.backgroundColor).toBe('#64748b');
      expect(invalidStyle.color).toBe('#ffffff');
    });
  });

  describe('matchWildcard', () => {
    it('matches exact strings case-insensitively', () => {
      expect(matchWildcard('size/small', 'size/small')).toBe(true);
      expect(matchWildcard('SIZE/SMALL', 'size/small')).toBe(true);
      expect(matchWildcard('size/small', 'SIZE/SMALL')).toBe(true);
      expect(matchWildcard('size/small', 'size/large')).toBe(false);
    });

    it('matches prefix and suffix wildcards with *', () => {
      expect(matchWildcard('size/*', 'size/small')).toBe(true);
      expect(matchWildcard('size/*', 'size/large')).toBe(true);
      expect(matchWildcard('size/*', 'kind/bug')).toBe(false);
      expect(matchWildcard('*bug', 'kind/bug')).toBe(true);
      expect(matchWildcard('*/*', 'area/api')).toBe(true);
      expect(matchWildcard('*', 'anything')).toBe(true);
    });

    it('matches single characters with ?', () => {
      expect(matchWildcard('v1.?', 'v1.0')).toBe(true);
      expect(matchWildcard('v1.?', 'v1.10')).toBe(false);
    });
  });

  describe('validateLabelPattern, validateLabelPatterns, and validateLabelFilterPatterns', () => {
    it('validates correct patterns', () => {
      expect(validateLabelPattern('size/*')).toBeNull();
      expect(validateLabelPattern('!kind/flake')).toBeNull();
      expect(validateLabelPattern('kind/bug')).toBeNull();
      expect(validateLabelPatterns(['size/*', 'kind/bug', '!needs-triage'])).toBeNull();
    });

    it('rejects empty patterns or invalid control characters', () => {
      expect(validateLabelPattern('')).toContain('cannot be empty');
      expect(validateLabelPattern('   ')).toContain('cannot be empty');
      expect(validateLabelPattern('!')).toContain('cannot be empty');
      expect(validateLabelPattern('!  ')).toContain('cannot be empty');
      expect(validateLabelPattern('a\x00b')).toContain('invalid control characters');
      expect(validateLabelPatterns(['valid/*', '   '])).toBeNull(); // Empty lines ignored in bulk
      expect(validateLabelPatterns(['valid/*', 'a\x00b'])).toContain('invalid control characters');
    });

    it('validates multiline text', () => {
      expect(validateLabelFilterPatterns('size/*\n!kind/flake\nsig/*')).toBeNull();
      expect(validateLabelFilterPatterns('size/*\n!\n')).toContain('cannot be empty');
    });
  });

  describe('filterLabels', () => {
    const labels = [
      { name: 'size/small' },
      { name: 'size/large' },
      { name: 'kind/bug' },
      { name: 'sig/node' },
    ];

    it('returns all labels when patterns are empty', () => {
      expect(filterLabels(labels, [], [])).toEqual(labels);
    });

    it('filters labels with includes', () => {
      expect(filterLabels(labels, ['size/*'], [])).toEqual([
        { name: 'size/small' },
        { name: 'size/large' },
      ]);
    });

    it('filters labels with excludes', () => {
      expect(filterLabels(labels, [], ['size/large', 'kind/*'])).toEqual([
        { name: 'size/small' },
        { name: 'sig/node' },
      ]);
    });

    it('filters labels with combined includes and excludes (exclusion precedence)', () => {
      expect(filterLabels(labels, ['size/*', 'sig/*'], ['size/large'])).toEqual([
        { name: 'size/small' },
        { name: 'sig/node' },
      ]);
    });
  });
});
