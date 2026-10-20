import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sidebarWidget, pausedFeatures } from '../../content/features/sidebarWidget';
import { createFakeSidebar } from '../fakes/capabilities';
import { createFakeBus, createFakeContext } from '../fakes/context';
import { OWN_ATTR } from '../../content/engine/constants';
import type { ExtensionMessage } from '../../types';
import { backend, capsWith, flush, makeItem } from './helpers';

function setup(opts: { handlers?: Parameters<typeof backend>[0]; bus?: ReturnType<typeof createFakeBus>; hideEvents?: boolean } = {}) {
  document.body.innerHTML = '<aside id="side"><div id="first">GitHub section</div></aside>';
  const first = document.getElementById('first')!;
  const onSend = backend(opts.handlers ?? { GET_ITEM: () => ({ ok: true, data: makeItem() }) });
  const handle = createFakeContext({
    id: 'sidebarWidget',
    caps: capsWith({ sidebar: createFakeSidebar({ before: first }) }),
    onSend,
    bus: opts.bus,
    prefs: { hideEvents: opts.hideEvents ?? false },
  });
  const feature = sidebarWidget.create();
  feature.mount(handle.ctx);
  const root = () => document.querySelector<HTMLElement>('.octodeck-gh-sidebar-section');
  return { ...handle, first, onSend, root };
}

describe('sidebarWidget', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('declares itself as a sidebar-gated mutator', () => {
    const f = sidebarWidget.create();
    expect(f.kind).toBe('mutator');
    expect(f.requires).toEqual(['sidebar']);
  });

  it('inserts an own node at the sidebar insertion point with header, star and Tracked badge', async () => {
    const { root, first, sent, ctx } = setup();
    await flush();
    const el = root()!;
    expect(el.getAttribute(OWN_ATTR)).toBe('sidebarWidget');
    expect(el.nextElementSibling).toBe(first);
    // No GitHub class names on our nodes.
    expect(el.className).toBe('octodeck-gh-sidebar-section');
    expect(el.querySelector('.octodeck-gh-header-title')?.textContent).toBe('Octodeck');
    expect(el.querySelector('.octodeck-gh-star-btn')).not.toBeNull();
    expect(el.querySelector('.octodeck-gh-badge')?.textContent).toBe('Tracked');
    // GraphQL node id first.
    expect(sent[0]).toEqual({ type: 'GET_ITEM', itemId: 'I_node1' });
    expect(ctx.bus.last('item:updated')).toMatchObject({ daemon: 'ok', item: { id: 'I_node1' } });
  });

  it('falls back to owner/repo#n when the node id is unknown to the daemon', async () => {
    const { sent, root } = setup({
      handlers: {
        GET_ITEM: (m) =>
          (m as { itemId: string }).itemId === 'octo/deck#1'
            ? { ok: true, data: makeItem() }
            : { ok: false, error: 'not found' },
      },
    });
    await flush();
    expect(sent.map((m) => (m as { itemId: string }).itemId)).toEqual(['I_node1', 'octo/deck#1']);
    expect(root()!.querySelector('.octodeck-gh-badge')?.textContent).toBe('Tracked');
  });

  it('shows Untracked with controls enabled when the item is not in the database', async () => {
    const { root, ctx } = setup({ handlers: { GET_ITEM: () => ({ ok: false, error: 'item not found' }) } });
    await flush();
    const el = root()!;
    expect(el.querySelector('.octodeck-gh-badge')?.textContent).toBe('Untracked');
    expect(el.querySelector<HTMLButtonElement>('.octodeck-gh-star-btn')!.disabled).toBe(false);
    expect(ctx.bus.last('item:updated')).toEqual({ item: null, daemon: 'notFound' });
  });

  it('shows Untracked when the viewer is unsubscribed on GitHub', async () => {
    const { root } = setup({
      handlers: { GET_ITEM: () => ({ ok: true, data: makeItem({ viewerSubscription: 'UNSUBSCRIBED' }) }) },
    });
    await flush();
    expect(root()!.querySelector('.octodeck-gh-badge')?.textContent).toBe('Untracked');
  });

  it('goes Offline, disables controls and retries with exponential backoff', async () => {
    vi.useFakeTimers();
    let online = false;
    const { root, onSend, ctx } = setup({
      handlers: {
        GET_ITEM: () => (online ? { ok: true, data: makeItem() } : { ok: false, error: 'Failed to fetch' }),
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const el = root()!;
    expect(el.querySelector('.octodeck-gh-badge')?.textContent).toBe('Offline');
    expect(el.querySelector<HTMLButtonElement>('.octodeck-gh-star-btn')!.disabled).toBe(true);
    expect(ctx.bus.last('item:updated')).toEqual({ item: null, daemon: 'offline' });
    const callsAfterFirst = onSend.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1999);
    expect(onSend.mock.calls.length).toBe(callsAfterFirst);
    await vi.advanceTimersByTimeAsync(1);
    const callsAfterSecond = onSend.mock.calls.length;
    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);

    // Second delay is 2000 * 1.5.
    online = true;
    await vi.advanceTimersByTimeAsync(2999);
    expect(onSend.mock.calls.length).toBe(callsAfterSecond);
    await vi.advanceTimersByTimeAsync(1);
    expect(root()!.querySelector('.octodeck-gh-badge')?.textContent).toBe('Tracked');
    expect(ctx.bus.last('item:updated')?.daemon).toBe('ok');
  });

  it('shows an Error badge with the daemon error as tooltip', async () => {
    const { root } = setup({ handlers: { GET_ITEM: () => ({ ok: false, error: '403 Forbidden' }) } });
    await flush();
    const badge = root()!.querySelector<HTMLElement>('.octodeck-gh-badge')!;
    expect(badge.textContent).toBe('Error');
    expect(badge.title).toBe('403 Forbidden');
  });

  it('rejects a daemon item for another repository and reports the identity mismatch', async () => {
    const { reports, ctx } = setup({
      handlers: { GET_ITEM: () => ({ ok: true, data: makeItem({ repo: 'evil/other' }) }) },
    });
    await flush();
    expect(reports.some((r) => r.code === 'DOM_IDENTITY_MISMATCH')).toBe(true);
    expect(ctx.bus.last('item:updated')?.item).toBeNull();
  });

  it('falls back to the URL item id when a stale node id resolves to another item', async () => {
    // After an in-page navigation GitHub may still expose the previous item's node id in the DOM;
    // the URL-derived owner/repo#n must still find the right item.
    const { reports, ctx, sent } = setup({
      handlers: {
        GET_ITEM: (m) =>
          (m as { itemId: string }).itemId === 'octo/deck#1'
            ? { ok: true, data: makeItem() }
            : { ok: true, data: makeItem({ id: 'I_previous', number: 2 }) },
      },
    });
    await flush();
    expect(sent.filter((m) => m.type === 'GET_ITEM').map((m) => (m as { itemId: string }).itemId)).toEqual([
      'I_node1',
      'octo/deck#1',
    ]);
    expect(reports.some((r) => r.code === 'DOM_IDENTITY_MISMATCH')).toBe(true);
    expect(ctx.bus.last('item:updated')?.daemon).toBe('ok');
    expect(ctx.bus.last('item:updated')?.item?.number).toBe(1);
  });

  it('stars optimistically and adopts the daemon response', async () => {
    const { root, sent, ctx } = setup({
      handlers: {
        GET_ITEM: () => ({ ok: true, data: makeItem() }),
        STAR_ITEM: () => ({ ok: true, data: makeItem({}, { starred: true }) }),
      },
    });
    await flush();
    root()!.querySelector<HTMLButtonElement>('.octodeck-gh-star-btn')!.click();
    expect(root()!.querySelector('.octodeck-gh-star-btn')!.classList.contains('octodeck-gh-star-active')).toBe(true);
    await flush();
    expect(sent.find((m) => m.type === 'STAR_ITEM')).toEqual({ type: 'STAR_ITEM', itemId: 'I_node1', starred: true });
    expect(ctx.bus.last('item:updated')?.item?.local?.starred).toBe(true);
  });

  it('rolls the star back when the daemon rejects it', async () => {
    const { root } = setup({
      handlers: { GET_ITEM: () => ({ ok: true, data: makeItem() }), STAR_ITEM: () => ({ ok: false, error: 'boom' }) },
    });
    await flush();
    root()!.querySelector<HTMLButtonElement>('.octodeck-gh-star-btn')!.click();
    await flush();
    expect(root()!.querySelector('.octodeck-gh-star-btn')!.classList.contains('octodeck-gh-star-active')).toBe(false);
  });

  it('edits and saves private notes', async () => {
    const { root, sent } = setup({
      handlers: {
        GET_ITEM: () => ({ ok: true, data: makeItem() }),
        SET_NOTES: (m) => ({ ok: true, data: makeItem({}, { privateNotes: (m as { notes: string }).notes }) }),
      },
    });
    await flush();
    expect(root()!.querySelector('.octodeck-gh-notes-title')).toBeNull();
    root()!.querySelector<HTMLButtonElement>('.octodeck-gh-notes-add-btn')!.click();
    const textarea = root()!.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(textarea.placeholder).toBe('Private notes are only visible to you.');
    textarea.value = 'remember <b>this</b>';
    textarea.dispatchEvent(new Event('input'));
    root()!.querySelector<HTMLButtonElement>('.octodeck-gh-notes-save-btn')!.click();
    await flush();
    expect(sent.find((m) => m.type === 'SET_NOTES')).toEqual({
      type: 'SET_NOTES',
      itemId: 'I_node1',
      notes: 'remember <b>this</b>',
    });
    const text = root()!.querySelector('.octodeck-gh-notes-text')!;
    // Rendered as text, never as markup.
    expect(text.textContent).toBe('remember <b>this</b>');
    expect(text.querySelector('b')).toBeNull();
  });

  it('cancels note editing with Escape', async () => {
    const { root } = setup();
    await flush();
    root()!.querySelector<HTMLButtonElement>('.octodeck-gh-notes-add-btn')!.click();
    root()!.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(root()!.querySelector('textarea')).toBeNull();
  });

  it('opens the dashboard for the item', async () => {
    const { root, sent } = setup();
    await flush();
    root()!.querySelector<HTMLButtonElement>('.octodeck-gh-jump-btn')!.click();
    expect(sent).toContainEqual({ type: 'OPEN_DASHBOARD', itemId: 'octo/deck#1' } satisfies ExtensionMessage);
  });

  it('writes the Hide events preference and follows external changes', async () => {
    const { root, hideEventsWrites, setPrefs } = setup({ hideEvents: true });
    await flush();
    const box = root()!.querySelector<HTMLInputElement>('.octodeck-gh-filter-checkbox')!;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(hideEventsWrites).toEqual([false]);
    setPrefs({ hideEvents: true });
    expect(box.checked).toBe(true);
  });

  it('renders no Expand all control (it lives inline in the timeline)', async () => {
    const bus = createFakeBus();
    const { root, ctx } = setup({ bus });
    await flush();
    ctx.bus.emit('expand:state', { available: true, count: 104, running: false, bounded: false });
    expect(root()!.querySelector('.octodeck-gh-expand-row')).toBeNull();
    expect(root()!.textContent).not.toContain('Expand all');
  });

  describe('Limited chip', () => {
    it('lists paused features only (unrecognized/disabled), not drifted or not-applicable ones', async () => {
      const { root, ctx } = setup();
      await flush();
      expect(root()!.querySelector('.octodeck-gh-limited-chip')).toBeNull();
      ctx.bus.emit('host:health', {
        sidebarWidget: { health: 'ok' },
        ackButton: { health: 'unrecognized' },
        noiseCollapser: { health: 'disabled' },
        timelineMarkers: { health: 'degraded' },
        expandAll: { health: 'notApplicable' },
      });
      const chip = root()!.querySelector<HTMLElement>('.octodeck-gh-limited-chip')!;
      expect(chip.textContent).toBe('Limited');
      expect(chip.title).toContain('Ack button');
      expect(chip.title).toContain('Bot comment collapsing');
      expect(chip.title).not.toContain('Timeline markers');
      expect(chip.title).not.toContain('Expand all');

      ctx.bus.emit('host:health', { ackButton: { health: 'ok' } });
      expect(root()!.querySelector('.octodeck-gh-limited-chip')).toBeNull();
    });

    it('pausedFeatures ignores the widget itself', () => {
      expect(pausedFeatures({ sidebarWidget: { health: 'disabled' } }, 'sidebarWidget')).toEqual([]);
    });
  });

  it('adopts item changes published by other features without re-emitting them', async () => {
    const { root, ctx } = setup();
    await flush();
    const seen: unknown[] = [];
    ctx.bus.on('item:updated', (v) => seen.push(v));
    ctx.bus.emit('item:updated', { item: makeItem({}, { starred: true }), daemon: 'ok' });
    expect(seen).toHaveLength(1);
    expect(root()!.querySelector('.octodeck-gh-star-btn')!.classList.contains('octodeck-gh-star-active')).toBe(true);
  });

  it('re-inserts its node when GitHub drops it, and reverts cleanly on unmount', async () => {
    const before = '<aside id="side"><div id="first">GitHub section</div></aside>';
    const { root, emitScopeChange, abort, first } = setup();
    await flush();
    const node = root()!;
    node.remove();
    emitScopeChange({ scope: 'sidebar', addedElements: [], removedOwn: [node], rootReplaced: false });
    expect(root()).toBe(node);
    expect(node.nextElementSibling).toBe(first);
    abort();
    expect(document.body.innerHTML).toBe(before);
  });

  it('ignores daemon responses that arrive after unmount', async () => {
    let resolveGet: (v: unknown) => void = () => {};
    document.body.innerHTML = '<aside><div id="first"></div></aside>';
    const handle = createFakeContext({
      id: 'sidebarWidget',
      caps: capsWith({ sidebar: createFakeSidebar({ before: document.getElementById('first')! }) }),
      onSend: () => new Promise((r) => (resolveGet = r as (v: unknown) => void)),
    });
    sidebarWidget.create().mount(handle.ctx);
    handle.abort();
    resolveGet({ ok: true, data: makeItem() });
    await flush();
    expect(handle.ctx.bus.last('item:updated')).toBeUndefined();
    expect(document.querySelector(`[${OWN_ATTR}]`)).toBeNull();
  });

  it('reports not-applicable without an item', () => {
    document.body.innerHTML = '';
    const handle = createFakeContext({ id: 'sidebarWidget', caps: capsWith({ sidebar: createFakeSidebar(null) }, { item: null }) });
    sidebarWidget.create().mount(handle.ctx);
    expect(handle.statuses).toContainEqual({ health: 'notApplicable', detail: 'no-item' });
    expect(handle.sent).toEqual([]);
  });
});
