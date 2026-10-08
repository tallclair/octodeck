import type { AckStateLike } from '../types';

/**
 * Parses a timestamp in any of the shapes it can take on items (see TimestampLike: protobuf
 * message, JSON string or { seconds, nanos } object, Date, or epoch milliseconds) into epoch
 * milliseconds. Returns null for missing, unparseable, or non-positive values.
 */
export function parseLocalTimestampMs(timestamp: unknown): number | null {
  if (!timestamp) return null;
  if (typeof timestamp === 'object') {
    if (timestamp instanceof Date) {
      const ms = timestamp.getTime();
      return isNaN(ms) ? null : ms;
    }
    const anyTs = timestamp as { seconds?: number | string | bigint; nanos?: number | string };
    if (anyTs.seconds !== undefined) {
      const sec = Number(anyTs.seconds);
      const nanos = Number(anyTs.nanos || 0);
      if (!isNaN(sec) && sec > 0) {
        return sec * 1000 + Math.round(nanos / 1e6);
      }
    }
  }
  if (typeof timestamp === 'string') {
    const ms = Date.parse(timestamp);
    if (!isNaN(ms) && ms > 0) return ms;
  }
  if (typeof timestamp === 'number') {
    return isNaN(timestamp) || timestamp <= 0 ? null : timestamp;
  }
  return null;
}

/** Whether the item has been acknowledged (explicitly or via auto-ack). */
export function isLocalAcked(local?: AckStateLike | null): boolean {
  return parseLocalTimestampMs(local?.ackedAt) !== null || parseLocalTimestampMs(local?.ackedActivityAt) !== null;
}

/**
 * The activity watermark in epoch ms: activity at or before it is acknowledged. Falls back to
 * ackedAt for items acked before the watermark was stored separately. Use this, never ackedAt,
 * when comparing against timeline activity.
 */
export function getAckedActivityMs(local?: AckStateLike | null): number | null {
  return parseLocalTimestampMs(local?.ackedActivityAt) ?? parseLocalTimestampMs(local?.ackedAt);
}

/** When the item was acknowledged, in epoch ms. Used for "Last Acked" ordering. */
export function getAckedActionMs(local?: AckStateLike | null): number | null {
  return parseLocalTimestampMs(local?.ackedAt);
}

/**
 * Whether a timeline entry at entryMs is newer than the watermark. GitHub timestamps have
 * second precision, so the comparison is on whole seconds: an entry in the same second as the
 * watermark (e.g. a DOM datetime with milliseconds) is not newer.
 */
export function isAfterWatermark(entryMs: number, watermarkMs: number): boolean {
  return Math.floor(entryMs / 1000) > Math.floor(watermarkMs / 1000);
}
