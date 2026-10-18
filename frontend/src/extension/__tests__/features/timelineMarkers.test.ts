import { describe, it, expect, afterEach, vi } from 'vitest';
import { timelineMarkers } from '../../content/features/timelineMarkers';
import { createFakeTimeline, createFakeTimelineItem } from '../fakes/capabilities';
import { createFakeBus, createFakeContext } from '../fakes/context';
import type { TimelineItem } from '../../content/capabilities/types';
import { OWN_ATTR } from '../../content/engine/constants';
import { capsWith, makeItem } from './helpers';

const T = (iso: string) => Date.parse(iso);
const entry = (id: string, iso: string | null) => createFakeTimelineItem({ nodeId: id, timestamp: iso ? T(iso) : null, text: id });

function setup(items: TimelineItem[], bus = createFakeBus()) {
  document.body.innerHTML = '';
  const timeline = createFakeTimeline({ items });
  const before = document.body.innerHTML;
  const handle = createFakeContext({ id: 'timelineMarkers', caps: capsWith({ timeline }), bus });
  timelineMarkers.create().mount(handle.ctx);
  return { ...handle, timeline, before };
}

const marker = (type: 'acked' | 'viewed') => document.querySelector<HTMLElement>(`[data-testid="octodeck-timeline-marker-${type}"]`);

const daemonItem = (local: Record<string, unknown>) => makeItem({}, local);

describe('timelineMarkers', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const items = () => [
    entry('IC_1', '2026-08-10T10:00:00Z'),
    entry('IC_2', '2026-08-11T10:00:00Z'),
    entry('IC_3', '2026-08-12T10:00:00Z'),
    entry('IC_4', '2026-08-13T10:00:00Z'),
  ];

  it('declares itself as a timeline-gated mutator', () => {
    const f = timelineMarkers.create();
    expect(f.kind).toBe('mutator');
    expect(f.requires).toEqual(['timeline']);
  });

  it('inserts Acknowledged and Last Viewed markers before the first newer items', () => {
    const list = items();
    const { ctx } = setup(list);
    ctx.bus.emit('item:updated', {
      item: daemonItem({ ackedAt: '2026-08-10T12:00:00Z', lastViewedAt: '2026-08-11T12:00:00Z' }),
      daemon: 'ok',
    });
    const acked = marker('acked')!;
    const viewed = marker('viewed')!;
    expect(acked.getAttribute(OWN_ATTR)).toBe('timelineMarkers');
    expect(acked.nextElementSibling).toBe(list[1].el);
    expect(viewed.nextElementSibling).toBe(list[2].el);
    expect(acked.textContent).toBe('Acknowledged');
    expect(viewed.textContent).toBe('Last Viewed');
    expect(acked.getAttribute('role')).toBe('separator');
  });

  it('shows only Acknowledged when both fall at the same position', () => {
    const list = items();
    const { ctx } = setup(list);
    ctx.bus.emit('item:updated', {
      item: daemonItem({ ackedAt: '2026-08-11T12:00:00Z', lastViewedAt: '2026-08-11T13:00:00Z' }),
      daemon: 'ok',
    });
    expect(marker('acked')!.nextElementSibling).toBe(list[2].el);
    expect(marker('viewed')).toBeNull();
  });

  it('uses daemon state published before it mounted', () => {
    const bus = createFakeBus();
    bus.forSignal(new AbortController().signal).emit('item:updated', {
      item: daemonItem({ ackedAt: '2026-08-10T12:00:00Z' }),
      daemon: 'ok',
    });
    const list = items();
    setup(list, bus);
    expect(marker('acked')!.nextElementSibling).toBe(list[1].el);
  });

  it('keeps markers while the daemon is unavailable', () => {
    const { ctx } = setup(items());
    ctx.bus.emit('item:updated', { item: daemonItem({ ackedAt: '2026-08-10T12:00:00Z' }), daemon: 'ok' });
    ctx.bus.emit('item:updated', { item: null, daemon: 'offline' });
    expect(marker('acked')).not.toBeNull();
  });

  it('holds the initial Last Viewed position when this visit is recorded', () => {
    const list = items();
    const { ctx } = setup(list);
    ctx.bus.emit('item:updated', { item: daemonItem({ lastViewedAt: '2026-08-11T12:00:00Z' }), daemon: 'ok' });
    const viewed = marker('viewed')!;
    expect(viewed.nextElementSibling).toBe(list[2].el);
    // The view tracker records this visit: last viewed moves to "now".
    ctx.bus.emit('item:updated', { item: daemonItem({ lastViewedAt: '2026-08-14T12:00:00Z' }), daemon: 'ok' });
    expect(marker('viewed')).toBe(viewed);
    expect(viewed.nextElementSibling).toBe(list[2].el);
  });

  it('moves the marker when an ack arrives and removes it when un-acked', () => {
    const list = items();
    const { ctx } = setup(list);
    ctx.bus.emit('item:updated', { item: daemonItem({ ackedAt: '2026-08-10T12:00:00Z' }), daemon: 'ok' });
    const acked = marker('acked')!;
    ctx.bus.emit('item:updated', { item: daemonItem({ ackedAt: '2026-08-12T12:00:00Z' }), daemon: 'ok' });
    expect(marker('acked')).toBe(acked);
    expect(acked.nextElementSibling).toBe(list[3].el);
    ctx.bus.emit('item:updated', { item: daemonItem({}), daemon: 'ok' });
    expect(marker('acked')).toBeNull();
  });

  it('ignores items without a timestamp', () => {
    const list = [entry('IC_1', '2026-08-10T10:00:00Z'), entry('LE_1', null), entry('IC_2', '2026-08-12T10:00:00Z')];
    const { ctx } = setup(list);
    ctx.bus.emit('item:updated', { item: daemonItem({ ackedAt: '2026-08-10T12:00:00Z' }), daemon: 'ok' });
    expect(marker('acked')!.nextElementSibling).toBe(list[2].el);
  });

  it('goes in front of other OctoDeck nodes attached before the target item', () => {
    const list = items();
    const { ctx } = setup(list);
    // A collapsed-noise box (any own node) standing in front of the target item.
    const box = document.createElement('div');
    box.setAttribute(OWN_ATTR, 'noiseCollapser');
    list[1].el.before(box);
    ctx.bus.emit('item:updated', { item: daemonItem({ ackedAt: '2026-08-10T12:00:00Z' }), daemon: 'ok' });
    expect(marker('acked')!.nextElementSibling).toBe(box);
  });

  it('recomputes after load-more batches add older history', async () => {
    vi.useFakeTimers();
    const bus = createFakeBus();
    const list = [entry('IC_1', '2026-08-10T10:00:00Z'), entry('IC_4', '2026-08-13T10:00:00Z')];
    const { ctx, timeline } = setup(list, bus);
    ctx.bus.emit('item:updated', { item: daemonItem({ ackedAt: '2026-08-11T12:00:00Z' }), daemon: 'ok' });
    expect(marker('acked')!.nextElementSibling).toBe(list[1].el);

    // GitHub splices a hidden range back in between the two items.
    const loaded = entry('IC_3', '2026-08-12T10:00:00Z');
    list[1].el.before(loaded.el);
    timeline.setItems([list[0], loaded, list[1]]);
    ctx.bus.emit('timeline:loading', { phase: 'batch', loaded: 1, remaining: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(marker('acked')!.nextElementSibling).toBe(loaded.el);
  });

  it('uses list items inside list timelines and restores the DOM on unmount', () => {
    document.body.innerHTML = '';
    const ol = document.body.appendChild(document.createElement('ol'));
    const list = [0, 1].map((i) =>
      createFakeTimelineItem({ el: document.createElement('li'), nodeId: `IC_${i}`, timestamp: T(`2026-08-1${i}T10:00:00Z`) })
    );
    const timeline = createFakeTimeline({ items: list, root: ol });
    const before = document.body.innerHTML;
    const handle = createFakeContext({ id: 'timelineMarkers', caps: capsWith({ timeline }) });
    timelineMarkers.create().mount(handle.ctx);
    handle.ctx.bus.emit('item:updated', { item: daemonItem({ ackedAt: '2026-08-10T12:00:00Z' }), daemon: 'ok' });
    expect(marker('acked')!.tagName).toBe('LI');
    handle.abort();
    expect(document.body.innerHTML).toBe(before);
  });
});
