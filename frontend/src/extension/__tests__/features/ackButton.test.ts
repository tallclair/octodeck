import { describe, it, expect, afterEach, vi } from 'vitest';
import { ackButton, ACK_FALLBACK_FETCH_MS } from '../../content/features/ackButton';
import { createFakeComposer } from '../fakes/capabilities';
import { createFakeBus, createFakeContext } from '../fakes/context';
import { OWN_ATTR } from '../../content/engine/constants';
import { backend, capsWith, flush, makeItem } from './helpers';

const COMPOSER_HTML = '<div id="footer" class="gh-footer"><button id="submit">Comment</button></div>';

function setup(opts: { handlers?: Parameters<typeof backend>[0]; bus?: ReturnType<typeof createFakeBus>; variant?: string } = {}) {
  document.body.innerHTML = COMPOSER_HTML;
  const submit = document.getElementById('submit')!;
  const onSend = backend(opts.handlers ?? {});
  const handle = createFakeContext({
    id: 'ackButton',
    caps: capsWith({ composer: createFakeComposer(submit) }),
    onSend,
    bus: opts.bus,
    session: opts.variant
      ? { facts: { ...capsWith().page.facts(), variants: { composer: opts.variant } } }
      : undefined,
  });
  ackButton.create().mount(handle.ctx);
  const btn = () => document.querySelector<HTMLButtonElement>('.octodeck-gh-comment-ack-btn');
  return { ...handle, submit, onSend, btn };
}

describe('ackButton', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('declares itself as a composer-gated mutator', () => {
    const f = ackButton.create();
    expect(f.kind).toBe('mutator');
    expect(f.requires).toEqual(['composer']);
  });

  it('inserts an own button before the submit button and marks the parent with an OctoDeck class', () => {
    const { btn, submit } = setup();
    const b = btn()!;
    expect(b.getAttribute(OWN_ATTR)).toBe('ackButton');
    expect(b.nextElementSibling).toBe(submit);
    expect(b.textContent).toBe('✓ Ack');
    expect(b.getAttribute('style')).toBeNull();
    expect(document.getElementById('footer')!.classList.contains('octodeck-gh-comment-actions-clean')).toBe(true);
  });

  it('tags the button with the composer variant for layout CSS', () => {
    const { btn } = setup({ variant: 'react' });
    expect(btn()!.getAttribute('data-octodeck-variant')).toBe('react');
  });

  it('follows item:updated from the sidebar widget', () => {
    const bus = createFakeBus();
    const { btn, ctx } = setup({ bus });
    ctx.bus.emit('item:updated', { item: makeItem({}, { computedStatus: 'ITEM_STATUS_ACKED' }), daemon: 'ok' });
    expect(btn()!.textContent).toBe('✓ Acked');
    expect(btn()!.classList.contains('octodeck-gh-btn-acked')).toBe(true);
    ctx.bus.emit('item:updated', { item: null, daemon: 'offline' });
    expect(btn()!.disabled).toBe(true);
    expect(btn()!.title).toBe('Octodeck is offline');
    // The last known item is kept while offline.
    expect(btn()!.textContent).toBe('✓ Acked');
  });

  it('uses state published before it mounted', () => {
    const bus = createFakeBus();
    bus
      .forSignal(new AbortController().signal)
      .emit('item:updated', { item: makeItem({}, { computedStatus: 5 }), daemon: 'ok' });
    const { btn, sent } = setup({ bus });
    expect(btn()!.textContent).toBe('✓ Acked');
    expect(sent).toEqual([]);
  });

  it('acks optimistically, publishes the change, and adopts the daemon response', async () => {
    const bus = createFakeBus();
    const acked = makeItem({}, { computedStatus: 'ITEM_STATUS_ACKED', ackedAt: '2026-08-12T10:00:00Z' });
    const { btn, ctx, sent } = setup({ bus, handlers: { ACK_ITEM: () => ({ ok: true, data: acked }) } });
    const original = makeItem();
    ctx.bus.emit('item:updated', { item: original, daemon: 'ok' });
    const published: unknown[] = [];
    ctx.bus.on('item:updated', (v) => published.push(v.item));

    btn()!.click();
    expect(btn()!.textContent).toBe('✓ Acked');
    // The shared item object is never mutated in place.
    expect(original.local?.computedStatus).toBeUndefined();
    await flush();
    expect(sent).toContainEqual({ type: 'ACK_ITEM', itemId: 'I_node1', acked: true });
    expect(published).toHaveLength(2);
    expect(published[1]).toBe(acked);
  });

  it('rolls back when every ack attempt fails', async () => {
    const bus = createFakeBus();
    const { btn, ctx, sent } = setup({ bus, handlers: { ACK_ITEM: () => ({ ok: false, error: 'boom' }) } });
    ctx.bus.emit('item:updated', { item: makeItem(), daemon: 'ok' });
    btn()!.click();
    await flush();
    // Tried the daemon id, then owner/repo#n.
    expect(sent.filter((m) => m.type === 'ACK_ITEM').map((m) => (m as { itemId: string }).itemId)).toEqual([
      'I_node1',
      'octo/deck#1',
    ]);
    expect(btn()!.textContent).toBe('✓ Ack');
  });

  it('does nothing when clicked while offline', async () => {
    const bus = createFakeBus();
    const { btn, ctx, sent } = setup({ bus });
    ctx.bus.emit('item:updated', { item: null, daemon: 'offline' });
    btn()!.click();
    await flush();
    expect(sent).toEqual([]);
  });

  it('fetches the item itself when no sidebar widget publishes it', async () => {
    vi.useFakeTimers();
    const { btn, sent, ctx } = setup({
      handlers: { GET_ITEM: () => ({ ok: true, data: makeItem({}, { computedStatus: 5 }) }) },
    });
    await vi.advanceTimersByTimeAsync(ACK_FALLBACK_FETCH_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent[0]).toEqual({ type: 'GET_ITEM', itemId: 'I_node1' });
    expect(btn()!.textContent).toBe('✓ Acked');
    expect(ctx.bus.last('item:updated')?.daemon).toBe('ok');
  });

  it('re-inserts when the composer re-renders and drops it; reverts cleanly', () => {
    const { btn, emitScopeChange, submit, abort } = setup();
    const b = btn()!;
    b.remove();
    emitScopeChange({ scope: 'composer', addedElements: [], removedOwn: [b], rootReplaced: false });
    expect(b.nextElementSibling).toBe(submit);
    abort();
    expect(document.body.innerHTML).toBe(COMPOSER_HTML);
  });

  it('waits without reporting drift while the composer is collapsed, then places on expand', () => {
    document.body.innerHTML = COMPOSER_HTML;
    const submit = document.getElementById('submit')!;
    let collapsed = true;
    const handle = createFakeContext({
      id: 'ackButton',
      caps: capsWith({ composer: createFakeComposer(submit, undefined, { collapsed: () => collapsed }) }),
    });
    ackButton.create().mount(handle.ctx);
    expect(document.querySelector('.octodeck-gh-comment-ack-btn')).toBeNull();
    expect(handle.statuses).toEqual([{ health: 'notApplicable', detail: 'composer-collapsed' }]);
    expect(handle.reports).toEqual([]);

    // The user clicks into the compact input; GitHub renders the full composer.
    collapsed = false;
    handle.emitScopeChange({ scope: 'composer', addedElements: [submit], removedOwn: [], rootReplaced: false });
    const btn = document.querySelector('.octodeck-gh-comment-ack-btn')!;
    expect(btn.nextElementSibling).toBe(submit);
    expect(handle.statuses.at(-1)).toEqual({ health: 'ok' });

    // Collapsing again drops our button with GitHub's footer: back to waiting, still not drift.
    collapsed = true;
    btn.remove();
    handle.emitScopeChange({ scope: 'composer', addedElements: [], removedOwn: [btn], rootReplaced: false });
    expect(handle.statuses.at(-1)).toEqual({ health: 'notApplicable', detail: 'composer-collapsed' });
  });

  it('reports unrecognized when the composer has no insertion point', () => {
    document.body.innerHTML = '';
    const handle = createFakeContext({ id: 'ackButton', caps: capsWith({ composer: createFakeComposer(null, null) }) });
    ackButton.create().mount(handle.ctx);
    expect(handle.statuses).toContainEqual({ health: 'unrecognized', detail: 'composer-insertion-point' });
    expect(document.querySelector('.octodeck-gh-comment-ack-btn')).toBeNull();
  });
});
