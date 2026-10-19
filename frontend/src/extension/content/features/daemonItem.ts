/**
 * Daemon item state shared by the sidebar widget and the Ack button (WP4-internal helper).
 *
 * Both features can fetch the current item so that each fails independently (design section 8);
 * the result is published on the bus as 'item:updated' for every consumer.
 */
import { ItemStatus, type Item } from '../../../api/octodeck/v1/resources_pb';
import { isLocalAcked } from '../../../logic/ackState';
import type { ExtensionMessage } from '../../types';
import type { ItemRef } from '../dom/types';
import type { BusEvents, FeatureContext } from '../engine/types';

/** Daemon availability for the current item, as published on 'item:updated'. */
export type DaemonState = BusEvents['item:updated']['daemon'];

export interface ItemSnapshot {
  /** Last known daemon item (kept across offline/error so the UI can keep showing it). */
  item: Item | null;
  daemon: DaemonState;
  error?: string;
}

/** Reconnect backoff while the daemon is offline or erroring. */
export const RECONNECT_MIN_MS = 2000;
export const RECONNECT_MAX_MS = 30000;
export const RECONNECT_MULTIPLIER = 1.5;

export function isItemAcked(item: Item | null | undefined): boolean {
  if (!item || !item.local) return false;

  // computedStatus may arrive as a proto enum number or a Connect-RPC JSON string.
  const rawStatus = (item.local as { computedStatus?: unknown }).computedStatus;
  if (
    rawStatus === ItemStatus.ACKED ||
    rawStatus === 'ITEM_STATUS_ACKED' ||
    rawStatus === 'ACKED' ||
    rawStatus === 5 ||
    rawStatus === '5'
  ) {
    return true;
  }

  // If computedStatus is explicitly specified (and not ACKED), trust it over historical ack fields.
  if (
    rawStatus !== undefined &&
    rawStatus !== null &&
    rawStatus !== ItemStatus.UNSPECIFIED &&
    rawStatus !== 0 &&
    rawStatus !== '0' &&
    rawStatus !== 'ITEM_STATUS_UNSPECIFIED' &&
    rawStatus !== 'UNSPECIFIED'
  ) {
    return false;
  }

  return isLocalAcked(item.local);
}

/** Maps a failed daemon response to the state the UI shows. */
export function classifyDaemonError(detail: string): Exclude<DaemonState, 'ok'> {
  const lower = detail.toLowerCase();
  if (lower.includes('not found') || detail.includes('404')) return 'notFound';
  if (
    detail.includes('Failed to fetch') ||
    detail.includes('NetworkError') ||
    lower.includes('connection refused') ||
    detail.includes('ERR_CONNECTION_REFUSED') ||
    detail.includes('ECONNREFUSED') ||
    lower.includes('offline')
  ) {
    return 'offline';
  }
  return 'error';
}

/** Offline and error states disable the daemon-backed controls; "not found" (untracked) doesn't. */
export function isUnavailable(daemon: DaemonState): boolean {
  return daemon === 'offline' || daemon === 'error';
}

export function unavailableReason(snapshot: ItemSnapshot): string {
  if (snapshot.daemon === 'offline') return 'Octodeck is offline';
  if (snapshot.daemon === 'error') return `Octodeck error: ${snapshot.error ?? 'unknown'}`;
  return '';
}

/** The 'item:updated' payload for a snapshot (the bus carries an item only when the daemon answered). */
export function toItemUpdated(snapshot: ItemSnapshot): BusEvents['item:updated'] {
  return {
    item: snapshot.daemon === 'ok' ? snapshot.item : null,
    daemon: snapshot.daemon,
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
}

/**
 * Rejects daemon items that belong to another repository or number (section 7.4). Items without
 * repo/number information are accepted.
 */
export function itemMatchesPage(item: Item, ref: ItemRef): boolean {
  if (item.repo && item.repo.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase()) return false;
  if (item.number && item.number !== ref.number) return false;
  return true;
}

/** Ids to try for daemon calls, most specific first: daemon id, GraphQL node id, owner/repo#n. */
export function candidateIds(ref: ItemRef, item: Item | null): string[] {
  const ids = [item?.id, ref.nodeId, ref.itemId].filter((v): v is string => Boolean(v));
  return Array.from(new Set(ids));
}

/**
 * Sends an item message, trying each candidate id until one succeeds. Returns the validated item,
 * or a failure detail.
 *
 * A candidate that resolves to a different item (e.g. a node id read from DOM that GitHub had not
 * yet updated after an in-page navigation) is reported and skipped, so the URL-derived id still
 * gets a chance. The page's owner/repo#number always comes from the URL, which is authoritative.
 */
export async function sendItemMessage(
  ctx: FeatureContext,
  ref: ItemRef,
  ids: readonly string[],
  build: (itemId: string) => ExtensionMessage
): Promise<{ ok: true; item: Item } | { ok: false; error: string }> {
  let lastError = 'unknown';
  for (const id of ids) {
    const res = await ctx.send<Item>(build(id));
    if (res.ok) {
      if (res.data && !itemMatchesPage(res.data, ref)) {
        ctx.report({
          code: 'DOM_IDENTITY_MISMATCH',
          severity: 'warn',
          message: 'daemon item does not match the page',
        });
        lastError = 'item mismatch';
        continue;
      }
      return { ok: true, item: res.data };
    }
    lastError = res.error || 'unknown';
  }
  return { ok: false, error: lastError };
}

export async function fetchItemSnapshot(ctx: FeatureContext, ref: ItemRef, previous: Item | null): Promise<ItemSnapshot> {
  // Prefer the GraphQL node id, fall back to owner/repo#n (the daemon knows items by either).
  const ids = candidateIds(ref, null);
  const res = await sendItemMessage(ctx, ref, ids, (itemId) => ({ type: 'GET_ITEM', itemId }));
  if (res.ok) return { item: res.item, daemon: 'ok' };
  const daemon = classifyDaemonError(res.error);
  return { item: daemon === 'notFound' ? null : previous, daemon, error: daemon === 'error' ? res.error : undefined };
}

export interface ItemSync {
  /** Fetch now (cancels a pending reconnect). */
  refresh(): void;
}

/**
 * Fetches the item and keeps retrying with exponential backoff while the daemon is offline or
 * erroring. Everything stops when the feature's signal aborts.
 */
export function startItemSync(
  ctx: FeatureContext,
  ref: ItemRef,
  getPrevious: () => Item | null,
  onResult: (snapshot: ItemSnapshot) => void
): ItemSync {
  let delay = RECONNECT_MIN_MS;
  let cancelTimer: (() => void) | null = null;
  let inFlight = false;

  const run = ctx.guard(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const snapshot = await fetchItemSnapshot(ctx, ref, getPrevious());
      if (ctx.signal.aborted) return;
      onResult(snapshot);
      if (isUnavailable(snapshot.daemon)) {
        const wait = delay;
        delay = Math.min(Math.round(delay * RECONNECT_MULTIPLIER), RECONNECT_MAX_MS);
        cancelTimer = ctx.setTimer(() => {
          cancelTimer = null;
          run();
        }, wait);
      } else {
        delay = RECONNECT_MIN_MS;
      }
    } finally {
      inFlight = false;
    }
  });

  run();
  return {
    refresh: () => {
      cancelTimer?.();
      cancelTimer = null;
      run();
    },
  };
}

/** Returns a copy of the item with local-state fields replaced. */
export function withLocal(item: Item, patch: Partial<NonNullable<Item['local']>>): Item {
  const local = { ...(item.local ?? { starred: false, privateNotes: '' }), ...patch } as NonNullable<Item['local']>;
  return { ...item, local };
}
