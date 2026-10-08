import { describe, it, expect } from 'vitest';
import { getEffectiveLastViewedMs, getOwnActivityViewedMs } from '../viewState';

const VIEW = '2026-08-11T13:00:00Z';
const OWN = '2026-08-12T15:00:00Z';

describe('viewState', () => {
  describe('getEffectiveLastViewedMs', () => {
    it('prefers the server-computed value', () => {
      expect(getEffectiveLastViewedMs({ lastViewedAt: VIEW, computedLastViewedAt: OWN })).toBe(Date.parse(OWN));
    });

    it('falls back to lastViewedAt when the computed value is absent', () => {
      expect(getEffectiveLastViewedMs({ lastViewedAt: VIEW })).toBe(Date.parse(VIEW));
    });

    it('uses the computed value when the item was never viewed', () => {
      expect(getEffectiveLastViewedMs({ computedLastViewedAt: OWN })).toBe(Date.parse(OWN));
    });

    it('is never older than lastViewedAt', () => {
      expect(getEffectiveLastViewedMs({ lastViewedAt: OWN, computedLastViewedAt: VIEW })).toBe(Date.parse(OWN));
    });

    it('accepts protobuf timestamps', () => {
      expect(
        getEffectiveLastViewedMs({
          lastViewedAt: { seconds: BigInt(1700000000), nanos: 0 },
          computedLastViewedAt: { seconds: BigInt(1700000500), nanos: 0 },
        })
      ).toBe(1700000500000);
    });

    it('returns null when neither is set', () => {
      expect(getEffectiveLastViewedMs({})).toBeNull();
      expect(getEffectiveLastViewedMs(undefined)).toBeNull();
    });
  });

  describe('getOwnActivityViewedMs', () => {
    it('returns the computed value when own activity is newer than the last view', () => {
      expect(getOwnActivityViewedMs({ lastViewedAt: VIEW, computedLastViewedAt: OWN })).toBe(Date.parse(OWN));
    });

    it('returns the computed value when the item was never viewed', () => {
      expect(getOwnActivityViewedMs({ computedLastViewedAt: OWN })).toBe(Date.parse(OWN));
    });

    it('returns null when the computed value is just the last view', () => {
      expect(getOwnActivityViewedMs({ lastViewedAt: VIEW, computedLastViewedAt: VIEW })).toBeNull();
    });

    it('returns null without a computed value', () => {
      expect(getOwnActivityViewedMs({ lastViewedAt: VIEW })).toBeNull();
      expect(getOwnActivityViewedMs(null)).toBeNull();
    });
  });
});
