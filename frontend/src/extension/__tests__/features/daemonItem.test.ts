import { describe, it, expect } from 'vitest';
import {
  candidateIds,
  classifyDaemonError,
  isItemAcked,
  itemMatchesPage,
  toItemUpdated,
  withLocal,
} from '../../content/features/daemonItem';
import { makeItem, REF } from './helpers';

describe('daemonItem helpers', () => {
  it('isItemAcked accepts proto enums, Connect-RPC JSON strings and legacy ack fields', () => {
    expect(isItemAcked(makeItem({}, { computedStatus: 5 }))).toBe(true);
    expect(isItemAcked(makeItem({}, { computedStatus: 'ITEM_STATUS_ACKED' }))).toBe(true);
    expect(isItemAcked(makeItem({}, { computedStatus: 'ITEM_STATUS_NEW' }))).toBe(false);
    expect(isItemAcked(makeItem({}, { ackedAt: '2026-08-12T10:00:00Z' }))).toBe(true);
    expect(isItemAcked(makeItem({}, { ackedActivityAt: { seconds: 1n, nanos: 0 } }))).toBe(true);
    expect(isItemAcked(null)).toBe(false);
  });

  it('classifies daemon errors', () => {
    expect(classifyDaemonError('item not found')).toBe('notFound');
    expect(classifyDaemonError('HTTP 404')).toBe('notFound');
    expect(classifyDaemonError('TypeError: Failed to fetch')).toBe('offline');
    expect(classifyDaemonError('connect ECONNREFUSED')).toBe('offline');
    expect(classifyDaemonError('403 Forbidden')).toBe('error');
  });

  it('matches daemon items to the page identity (section 7.4)', () => {
    expect(itemMatchesPage(makeItem(), REF)).toBe(true);
    expect(itemMatchesPage(makeItem({ repo: 'Octo/Deck' }), REF)).toBe(true);
    expect(itemMatchesPage(makeItem({ repo: 'octo/other' }), REF)).toBe(false);
    expect(itemMatchesPage(makeItem({ number: 2 }), REF)).toBe(false);
    expect(itemMatchesPage(makeItem({ repo: '', number: 0 }), REF)).toBe(true);
  });

  it('orders candidate ids from most to least specific without duplicates', () => {
    expect(candidateIds(REF, makeItem({ id: 'I_node1' }))).toEqual(['I_node1', 'octo/deck#1']);
    expect(candidateIds({ ...REF, nodeId: undefined }, null)).toEqual(['octo/deck#1']);
  });

  it('publishes an item only when the daemon answered', () => {
    const item = makeItem();
    expect(toItemUpdated({ item, daemon: 'ok' })).toEqual({ item, daemon: 'ok' });
    expect(toItemUpdated({ item, daemon: 'offline' })).toEqual({ item: null, daemon: 'offline' });
    expect(toItemUpdated({ item: null, daemon: 'error', error: 'x' })).toEqual({ item: null, daemon: 'error', error: 'x' });
  });

  it('withLocal copies instead of mutating', () => {
    const item = makeItem();
    const next = withLocal(item, { starred: true });
    expect(next.local?.starred).toBe(true);
    expect(item.local?.starred).toBe(false);
  });
});
