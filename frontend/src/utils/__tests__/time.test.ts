import { describe, it, expect } from 'vitest';
import { formatFuzzyTime, formatCompactTime, formatExactDateTime } from '../time';

describe('time utils', () => {
  describe('formatFuzzyTime', () => {
    it('returns Never for falsy or 0 timestamp', () => {
      expect(formatFuzzyTime(null)).toBe('Never');
      expect(formatFuzzyTime(0)).toBe('Never');
    });

    it('returns seconds ago for recent diffs', () => {
      const now = Date.now();
      expect(formatFuzzyTime(now - 30000)).toBe('30 seconds ago');
    });

    it('returns minutes ago', () => {
      const now = Date.now();
      expect(formatFuzzyTime(now - 5 * 60 * 1000)).toBe('5 minutes ago');
      expect(formatFuzzyTime(now - 60 * 1000)).toBe('1 minute ago');
    });

    it('returns hours ago', () => {
      const now = Date.now();
      expect(formatFuzzyTime(now - 2 * 3600 * 1000)).toBe('2 hours ago');
      expect(formatFuzzyTime(now - 3600 * 1000)).toBe('1 hour ago');
    });

    it('returns days ago', () => {
      const now = Date.now();
      expect(formatFuzzyTime(now - 5 * 86400 * 1000)).toBe('5 days ago');
      expect(formatFuzzyTime(now - 86400 * 1000)).toBe('1 day ago');
    });

    it('returns local date string for older timestamps', () => {
      const oldTime = new Date('2020-01-01T00:00:00Z').getTime();
      expect(formatFuzzyTime(oldTime)).toBe(new Date(oldTime).toLocaleDateString());
    });
  });

  describe('formatCompactTime', () => {
    it('returns Never for falsy, 0, or null input', () => {
      expect(formatCompactTime(null)).toBe('Never');
      expect(formatCompactTime(undefined)).toBe('Never');
      expect(formatCompactTime(0)).toBe('Never');
      expect(formatCompactTime('')).toBe('Never');
    });

    it('returns seconds ago in compact format', () => {
      const now = Date.now();
      expect(formatCompactTime(now - 30000)).toBe('30s ago');
    });

    it('returns minutes ago in compact format', () => {
      const now = Date.now();
      expect(formatCompactTime(now - 5 * 60 * 1000)).toBe('5m ago');
      expect(formatCompactTime(now - 60 * 1000)).toBe('1m ago');
    });

    it('returns hours ago in compact format', () => {
      const now = Date.now();
      expect(formatCompactTime(now - 2 * 3600 * 1000)).toBe('2h ago');
      expect(formatCompactTime(now - 3600 * 1000)).toBe('1h ago');
    });

    it('returns days ago in compact format', () => {
      const now = Date.now();
      expect(formatCompactTime(now - 5 * 86400 * 1000)).toBe('5d ago');
      expect(formatCompactTime(now - 86400 * 1000)).toBe('1d ago');
    });

    it('handles proto Timestamp object and Date objects', () => {
      const proto = { seconds: BigInt(Math.floor(Date.now() / 1000) - 120), nanos: 0 };
      expect(formatCompactTime(proto)).toBe('2m ago');

      const date = new Date(Date.now() - 300000);
      expect(formatCompactTime(date)).toBe('5m ago');
    });

    it('returns Invalid Date for bad strings or NaN', () => {
      expect(formatCompactTime('invalid-date')).toBe('Invalid Date');
      expect(formatCompactTime(new Date('invalid'))).toBe('Invalid Date');
    });
  });

  describe('formatExactDateTime', () => {
    it('returns undefined for falsy or 0 input', () => {
      expect(formatExactDateTime(null)).toBeUndefined();
      expect(formatExactDateTime(undefined)).toBeUndefined();
      expect(formatExactDateTime(0)).toBeUndefined();
      expect(formatExactDateTime('')).toBeUndefined();
    });

    it('formats epoch millisecond number', () => {
      const ms = 1700000000000;
      expect(formatExactDateTime(ms)).toBe(new Date(ms).toLocaleString());
    });

    it('formats ISO string', () => {
      const iso = '2026-08-14T20:30:00Z';
      expect(formatExactDateTime(iso)).toBe(new Date(iso).toLocaleString());
    });

    it('formats Date instance', () => {
      const date = new Date(1700000000000);
      expect(formatExactDateTime(date)).toBe(date.toLocaleString());
    });

    it('formats proto Timestamp object', () => {
      const proto = { seconds: BigInt(1700000000), nanos: 500000000 };
      expect(formatExactDateTime(proto)).toBe(new Date(1700000000500).toLocaleString());
    });

    it('returns undefined for invalid date string or NaN', () => {
      expect(formatExactDateTime('invalid-date')).toBeUndefined();
      expect(formatExactDateTime(NaN)).toBeUndefined();
      expect(formatExactDateTime(new Date('invalid'))).toBeUndefined();
    });
  });
});
