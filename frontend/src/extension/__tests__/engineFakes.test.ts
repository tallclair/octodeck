import { describe, it, expect } from 'vitest';
import { createFakeCapabilities, createFakeTimeline, createFakeTimelineItem } from './fakes/capabilities';
import { createFakeBus, createFakeContext } from './fakes/context';
import { ANCHORS } from '../content/dom/anchors';
import { ANCHOR_IDS } from '../content/dom/types';
import { isOwnNode, OWN_ATTR } from '../content/engine/constants';

// Guards the M0 contract fakes that feature work packages build their tests on.
describe('engine fakes', () => {
  it('ledger tags created nodes and revert restores the original DOM', () => {
    document.body.innerHTML = '<div id="gh"><p class="gh-class">GitHub</p></div>';
    const before = document.body.innerHTML;
    const { ctx, abort } = createFakeContext({ id: 'noiseCollapser' });
    const gh = document.getElementById('gh')!;
    const p = gh.querySelector('p')!;

    const node = ctx.ledger.create('div', 'k1');
    ctx.ledger.insert(node, { before: p });
    ctx.ledger.addClass(p, 'octodeck-gh-collapsed-comment');
    ctx.ledger.setData(p, 'octodeck-group', '1');

    expect(node.getAttribute(OWN_ATTR)).toBe('noiseCollapser');
    expect(isOwnNode(node)).toBe(true);
    expect(isOwnNode(p)).toBe(false);
    expect(document.body.innerHTML).not.toBe(before);

    abort();
    expect(document.body.innerHTML).toBe(before);
  });

  it('ledger refuses to insert nodes it did not create', () => {
    const { ctx } = createFakeContext({ id: 'ackButton' });
    const foreign = document.createElement('div');
    expect(() => ctx.ledger.insert(foreign, { appendTo: document.body })).toThrow();
  });

  it('cloneForDisplay strips ids and handlers', () => {
    const { ctx } = createFakeContext();
    const src = document.createElement('div');
    src.innerHTML = '<a id="user-content-x" name="n" onclick="x()">link</a>';
    const clone = ctx.ledger.cloneForDisplay(src);
    const a = clone.querySelector('a')!;
    expect(a.hasAttribute('id')).toBe(false);
    expect(a.hasAttribute('name')).toBe(false);
    expect(a.hasAttribute('onclick')).toBe(false);
  });

  it('bus subscriptions and guards stop after abort', () => {
    const bus = createFakeBus();
    const a = createFakeContext({ id: 'sidebarWidget', bus });
    const b = createFakeContext({ id: 'expandAll', bus });
    const seen: string[] = [];
    b.ctx.bus.on('nav:hash', (v) => seen.push(v.hash));
    a.ctx.bus.emit('nav:hash', { hash: 'start' });
    b.abort();
    a.ctx.bus.emit('nav:hash', { hash: 'stop' });
    expect(seen).toEqual(['start']);
    expect(a.ctx.bus.last('nav:hash')).toEqual({ hash: 'stop' });

    let calls = 0;
    const guarded = b.ctx.guard(() => {
      calls++;
    });
    guarded();
    expect(calls).toBe(0);
  });

  it('guard swallows and records errors', () => {
    const h = createFakeContext();
    h.ctx.guard(() => {
      throw new Error('boom');
    })();
    expect(h.errors).toHaveLength(1);
  });

  it('fake timeline notifies onItemsAdded until the listener aborts', () => {
    document.body.innerHTML = '';
    const timeline = createFakeTimeline({ items: [createFakeTimelineItem({ nodeId: 'IC_1' })] });
    const h = createFakeContext({ caps: createFakeCapabilities({ timeline }) });
    const added: string[] = [];
    h.ctx.caps.timeline!.onItemsAdded((items) => added.push(...items.map((i) => i.nodeId ?? '')), h.ctx.signal);
    timeline.addItems([createFakeTimelineItem({ nodeId: 'IC_2' })]);
    h.abort();
    timeline.addItems([createFakeTimelineItem({ nodeId: 'IC_3' })]);
    expect(added).toEqual(['IC_2']);
    expect(timeline.items()).toHaveLength(3);
  });

  it('anchor registry covers every anchor id exactly once', () => {
    expect(Object.keys(ANCHORS).sort()).toEqual([...ANCHOR_IDS].sort());
    for (const id of ANCHOR_IDS) expect(ANCHORS[id].id).toBe(id);
  });
});
