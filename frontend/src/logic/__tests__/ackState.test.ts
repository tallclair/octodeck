import { describe, it, expect } from 'vitest';
import {
  getAckedActionMs,
  getAckedActivityMs,
  isAfterWatermark,
  isLocalAcked,
  parseLocalTimestampMs,
} from '../ackState';

describe('ackState', () => {
  describe('parseLocalTimestampMs', () => {
    it('parses numeric timestamps', () => {
      expect(parseLocalTimestampMs(1700000000000)).toBe(1700000000000);
      expect(parseLocalTimestampMs(0)).toBeNull();
      expect(parseLocalTimestampMs(-100)).toBeNull();
      expect(parseLocalTimestampMs(null)).toBeNull();
    });

    it('parses ISO date strings', () => {
      const ms = Date.parse('2026-08-12T15:30:00.000Z');
      expect(parseLocalTimestampMs('2026-08-12T15:30:00.000Z')).toBe(ms);
      expect(parseLocalTimestampMs('invalid-date')).toBeNull();
    });

    it('parses Date instances', () => {
      const d = new Date('2026-08-12T15:30:00.000Z');
      expect(parseLocalTimestampMs(d)).toBe(d.getTime());
    });

    it('parses protobuf Timestamp objects', () => {
      expect(parseLocalTimestampMs({ seconds: 1700000000n, nanos: 500000000 })).toBe(1700000000500);
      expect(parseLocalTimestampMs({ seconds: 1700000000, nanos: 0 })).toBe(1700000000000);
      expect(parseLocalTimestampMs({ seconds: '1700000000', nanos: 0 })).toBe(1700000000000);
      expect(parseLocalTimestampMs({ seconds: 0, nanos: 0 })).toBeNull();
    });
  });

  describe('ack fields', () => {
    const action = { seconds: BigInt(1700000900), nanos: 0 };
    const watermark = { seconds: BigInt(1700000500), nanos: 0 };

    it('treats neither field as not acked', () => {
      expect(isLocalAcked(undefined)).toBe(false);
      expect(isLocalAcked({})).toBe(false);
      expect(getAckedActivityMs({})).toBeNull();
      expect(getAckedActionMs({})).toBeNull();
    });

    it('falls back to ackedAt for legacy items', () => {
      const local = { ackedAt: watermark };
      expect(isLocalAcked(local)).toBe(true);
      expect(getAckedActivityMs(local)).toBe(1700000500000);
      expect(getAckedActionMs(local)).toBe(1700000500000);
    });

    it('uses ackedActivityAt as the watermark when both are set', () => {
      const local = { ackedAt: action, ackedActivityAt: watermark };
      expect(isLocalAcked(local)).toBe(true);
      expect(getAckedActivityMs(local)).toBe(1700000500000);
      expect(getAckedActionMs(local)).toBe(1700000900000);
    });

    it('treats only ackedActivityAt as acked', () => {
      const local = { ackedActivityAt: watermark };
      expect(isLocalAcked(local)).toBe(true);
      expect(getAckedActivityMs(local)).toBe(1700000500000);
      expect(getAckedActionMs(local)).toBeNull();
    });

    it('accepts JSON string shapes from the extension bridge', () => {
      const local = { ackedAt: '2026-08-12T16:00:00Z', ackedActivityAt: '2026-08-12T15:00:00Z' };
      expect(isLocalAcked(local)).toBe(true);
      expect(getAckedActivityMs(local)).toBe(Date.parse('2026-08-12T15:00:00Z'));
      expect(getAckedActionMs(local)).toBe(Date.parse('2026-08-12T16:00:00Z'));
    });
  });

  describe('isAfterWatermark', () => {
    const wm = 1700000500000;
    it('is false within the same second', () => {
      expect(isAfterWatermark(wm, wm)).toBe(false);
      expect(isAfterWatermark(wm + 999, wm)).toBe(false);
    });
    it('is true one second later', () => {
      expect(isAfterWatermark(wm + 1000, wm)).toBe(true);
    });
    it('is false before the watermark', () => {
      expect(isAfterWatermark(wm - 1000, wm)).toBe(false);
    });
  });
});
