import type { ViewStateLike } from '../types';
import { parseLocalTimestampMs } from './ackState';

/**
 * The effective last-viewed time in epoch ms: everything at or before it has been seen. Prefers
 * the server-computed computedLastViewedAt (max of lastViewedAt and the user's latest own activity
 * on the item, since acting on an item implies having seen it), falling back to lastViewedAt for
 * responses that lack it. Never older than lastViewedAt. Use this, not lastViewedAt, for "new
 * since last view" decisions.
 */
export function getEffectiveLastViewedMs(local?: ViewStateLike | null): number | null {
  const computed = parseLocalTimestampMs(local?.computedLastViewedAt);
  const raw = parseLocalTimestampMs(local?.lastViewedAt);
  if (computed === null) return raw;
  if (raw === null) return computed;
  return Math.max(computed, raw);
}

/**
 * The user's latest own activity time in epoch ms, when the server-computed effective last-viewed
 * time is determined by it, i.e. when computedLastViewedAt is later than lastViewedAt (or there is
 * no lastViewedAt). Returns null otherwise. Lets callers that deliberately hold on to an older
 * view time (e.g. so a fresh view doesn't hide what was new on arrival) still never place the
 * "Last Viewed" position before the user's own latest action.
 */
export function getOwnActivityViewedMs(local?: ViewStateLike | null): number | null {
  const computed = parseLocalTimestampMs(local?.computedLastViewedAt);
  if (computed === null) return null;
  const raw = parseLocalTimestampMs(local?.lastViewedAt);
  return raw === null || computed > raw ? computed : null;
}
