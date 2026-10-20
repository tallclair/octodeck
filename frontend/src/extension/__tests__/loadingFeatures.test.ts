import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPAND_BATCH_TIMEOUT_MS,
  EXPAND_INTER_BATCH_DELAY_MS,
  EXPAND_MAX_BATCHES,
  EXPAND_RESULT_TOAST_MS,
  EXPAND_TEXT,
  LOAD_ALL_CLASS,
  expandAllFeature,
} from '../content/features/expandAll';
import {
  ANCHOR_MAX_BATCHES,
  ANCHOR_NOT_FOUND_TOAST_MS,
  ANCHOR_TOAST_LOADING,
  ANCHOR_TOAST_NOT_FOUND,
  anchorNavFeature,
} from '../content/features/anchorNav';
import type { HiddenItemsInfo, LoadResult, LoadUntilOptions } from '../content/capabilities/types';
import {
  createFakeCapabilities,
  createFakeNavigation,
  createFakeTimeline,
  createFakeTimelineItem,
  type FakeNavigation,
  type FakeTimeline,
  type FakeTimelineOptions,
} from './fakes/capabilities';
import { createFakeBus, createFakeContext } from './fakes/context';

/** A hidden range whose segment is attached to the document (the inline button goes inside it). */
const range = (count: number | null = 40): HiddenItemsInfo => ({
  kind: 'range',
  segment: document.body.appendChild(document.createElement('form')),
  count,
});
const timelineChange = { scope: 'timeline' as const, addedElements: [], removedOwn: [], rootReplaced: false };

describe('expandAll feature', () => {
  const handles: Array<ReturnType<typeof createFakeContext>> = [];
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const h of handles.splice(0)) h.abort();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  function setup(timelineOpts: FakeTimelineOptions = {}) {
    const timeline = createFakeTimeline({ supportsLoadMore: true, hidden: [range()], ...timelineOpts });
    const navigation = createFakeNavigation();
    const h = createFakeContext({ id: 'expandAll', bus: createFakeBus(), caps: createFakeCapabilities({ timeline, navigation }) });
    handles.push(h);
    expandAllFeature.create().mount(h.ctx);
    const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(`button.${LOAD_ALL_CLASS}`));
    return { h, timeline, navigation, buttons, click: () => buttons()[0].click() };
  }

  /** A loadUntil that stays pending until its signal aborts, exposing the options it was given. */
  function pendingLoad() {
    const calls: LoadUntilOptions[] = [];
    const loadUntil = vi.fn(
      (_p: () => boolean, o: LoadUntilOptions) =>
        new Promise<LoadResult>((resolve) => {
          calls.push(o);
          o.signal.addEventListener('abort', () => resolve({ status: 'aborted', added: 0, batches: 0 }));
        })
    );
    return { loadUntil, calls };
  }

  it('fails closed for variants without a verified loader: no inline control', () => {
    const s = setup({ supportsLoadMore: false });
    expect(s.buttons()).toEqual([]);
    expect(s.h.ledger.created).toEqual([]);
    expect(s.h.statuses.at(-1)).toEqual({ health: 'notApplicable', detail: 'unsupported-variant' });
  });

  it('renders "Load all" at the insertion point of each native Load more control', () => {
    const a = range(10);
    const b = range(20);
    const s = setup({ hidden: [a, b] });
    expect(s.buttons().map((btn) => btn.parentElement)).toEqual([a.segment, b.segment]);
    for (const btn of s.buttons()) {
      expect(btn.type).toBe('button');
      expect(btn.textContent).toBe(EXPAND_TEXT.start);
      expect(btn.getAttribute('data-octodeck')).toBe('expandAll');
    }
    expect(s.h.statuses.at(-1)).toEqual({ health: 'ok' });
  });

  it('renders nothing when ranges have no recognized control', () => {
    const s = setup({ loadMoreControls: () => [] });
    expect(s.buttons()).toEqual([]);
  });

  it('follows hidden ranges as the timeline changes, and disappears when nothing is hidden', () => {
    const first = range();
    const s = setup({ hidden: [first] });
    expect(s.buttons()).toHaveLength(1);

    s.timeline.setHidden([]);
    s.h.emitScopeChange(timelineChange);
    expect(s.buttons()).toEqual([]);

    const next = range(5);
    s.timeline.setHidden([next]);
    s.timeline.addItems([createFakeTimelineItem({ nodeId: 'IC_live' })]);
    expect(s.buttons().map((btn) => btn.parentElement)).toEqual([next.segment]);
  });

  it('re-inserts a button removed from a still-present segment (budgeted); a replaced segment is not a re-insert', () => {
    const first = range();
    const s = setup({ hidden: [first] });
    s.buttons()[0].remove(); // someone else detached it
    s.h.emitScopeChange({ ...timelineChange, removedOwn: [] });
    expect(s.buttons().map((btn) => btn.parentElement)).toEqual([first.segment]);
    expect(s.h.ledger.reinserts).toBe(1);

    // GitHub replaces the form (and our button with it) after a native Load more.
    first.segment.remove();
    s.timeline.setHidden([range()]);
    s.h.emitScopeChange(timelineChange);
    expect(s.buttons()).toHaveLength(1);
    expect(s.h.ledger.reinserts).toBe(1);
  });

  it('starts a bounded, polite run with a progress toast and withdraws the inline control', async () => {
    const { loadUntil, calls } = pendingLoad();
    const s = setup({ hidden: [range(104)], loadUntil });
    s.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls[0]).toMatchObject({
      kinds: ['range'],
      maxBatches: EXPAND_MAX_BATCHES,
      batchTimeoutMs: EXPAND_BATCH_TIMEOUT_MS,
      interBatchDelayMs: EXPAND_INTER_BATCH_DELAY_MS,
    });
    expect(s.buttons()).toEqual([]);
    expect(s.navigation.toasts).toHaveLength(1);
    expect(s.navigation.toasts[0]).toMatchObject({ text: EXPAND_TEXT.starting(104), dismissed: false });
    expect(s.navigation.toasts[0].action?.label).toBe(EXPAND_TEXT.cancel);

    calls[0].onProgress?.({ batches: 1, added: 30, remaining: 74 });
    expect(s.navigation.toasts[0].text).toBe(EXPAND_TEXT.progress({ added: 30, remaining: 74 }));
    expect(s.navigation.toasts[0].text).toContain('74 remaining');
    calls[0].onProgress?.({ batches: 2, added: 60, remaining: null });
    expect(s.navigation.toasts[0].text).toContain('60 items loaded');
  });

  it('reports completion briefly, then removes the toast; nothing left to load means no control', async () => {
    const ref = {} as { timeline: FakeTimeline };
    const s = setup({
      loadUntil: async (_p, o) => {
        o.onProgress?.({ batches: 1, added: 30, remaining: 10 });
        ref.timeline.setHidden([]);
        return { status: 'exhausted', added: 40, batches: 2 };
      },
    });
    ref.timeline = s.timeline;
    s.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(s.navigation.toasts.map((t) => t.dismissed)).toEqual([true, false]);
    expect(s.navigation.toasts[1].text).toBe(EXPAND_TEXT.done(40));
    expect(s.navigation.toasts[1].action).toBeUndefined();
    expect(s.buttons()).toEqual([]);
    await vi.advanceTimersByTimeAsync(EXPAND_RESULT_TOAST_MS);
    expect(s.navigation.toasts[1].dismissed).toBe(true);
    expect(s.h.statuses.at(-1)).toEqual({ health: 'ok' });
  });

  it('Cancel aborts the run, removes the toast at once and restores the inline control', async () => {
    const { loadUntil, calls } = pendingLoad();
    const s = setup({ loadUntil });
    s.click();
    await vi.advanceTimersByTimeAsync(0);
    s.navigation.toasts[0].action!.onClick();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls[0].signal.aborted).toBe(true);
    expect(s.navigation.toasts).toHaveLength(1);
    expect(s.navigation.toasts[0].dismissed).toBe(true);
    expect(s.buttons().map((btn) => btn.textContent)).toEqual([EXPAND_TEXT.start]);
    expect(s.h.errors).toEqual([]);
  });

  it('ignores a second start while running', async () => {
    const { loadUntil } = pendingLoad();
    const s = setup({ loadUntil });
    const btn = s.buttons()[0];
    btn.click();
    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(loadUntil).toHaveBeenCalledTimes(1);
    expect(s.navigation.toasts).toHaveLength(1);
  });

  it('offers to continue when the batch cap is reached, and continues on click', async () => {
    const results: LoadResult[] = [
      { status: 'loaded', added: 25, batches: 25 },
      { status: 'exhausted', added: 5, batches: 1 },
    ];
    const ref = {} as { timeline: FakeTimeline };
    const loadUntil = vi.fn(async () => {
      const r = results.shift()!;
      if (r.status === 'exhausted') ref.timeline.setHidden([]);
      return r;
    });
    const s = setup({ loadUntil });
    ref.timeline = s.timeline;
    s.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(s.navigation.toasts.at(-1)!.text).toBe(EXPAND_TEXT.bounded(25));
    expect(s.buttons().map((btn) => btn.textContent)).toEqual([EXPAND_TEXT.continue]);

    s.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(loadUntil).toHaveBeenCalledTimes(2);
    expect(s.buttons()).toEqual([]);
    expect(s.navigation.toasts.at(-1)!.text).toBe(EXPAND_TEXT.done(5));
    // Starting the second run replaced the first run's result toast.
    expect(s.navigation.toasts.filter((t) => !t.dismissed)).toHaveLength(1);
  });

  it('surfaces failures in the toast and as degraded health; the control stays for a retry', async () => {
    const s = setup({ loadUntil: async () => ({ status: 'timeout', added: 0, batches: 0 }) });
    s.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.navigation.toasts.at(-1)).toMatchObject({ text: EXPAND_TEXT.failed, dismissed: false });
    expect(s.h.statuses.at(-1)).toEqual({ health: 'degraded', detail: 'load-timeout' });
    expect(s.buttons().map((btn) => btn.textContent)).toEqual([EXPAND_TEXT.start]);
    await vi.advanceTimersByTimeAsync(EXPAND_RESULT_TOAST_MS);
    expect(s.navigation.toasts.every((t) => t.dismissed)).toBe(true);
  });

  it('removes the toast and restores the control even when the loader throws', async () => {
    const s = setup({ loadUntil: async () => Promise.reject(new Error('boom')) });
    s.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.navigation.toasts.map((t) => t.dismissed)).toEqual([true]);
    expect(s.buttons()).toHaveLength(1);
    expect(s.h.errors).toHaveLength(1);
  });

  it('session end aborts the run, removes the toast and leaves no own nodes', async () => {
    const { loadUntil, calls } = pendingLoad();
    const s = setup({ loadUntil });
    s.click();
    await vi.advanceTimersByTimeAsync(0);
    s.h.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0].signal.aborted).toBe(true);
    expect(s.navigation.toasts.map((t) => t.dismissed)).toEqual([true]);
    expect(document.querySelector('[data-octodeck]')).toBeNull();
  });
});

describe('anchorNav feature', () => {
  const handles: Array<ReturnType<typeof createFakeContext>> = [];
  beforeAll(() => {
    // jsdom has no CSS.escape; the fake timeline's findByAnchor uses it.
    if (typeof globalThis.CSS?.escape !== 'function') {
      vi.stubGlobal('CSS', { ...(globalThis.CSS ?? {}), escape: (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`) });
    }
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    // Guarded callbacks swallow exceptions; none should have happened.
    for (const h of handles.splice(0)) {
      expect(h.errors).toEqual([]);
      h.abort();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function setup(hash: string, timelineOpts: FakeTimelineOptions = {}, preMount?: (t: FakeTimeline, n: FakeNavigation) => void) {
    const timeline = createFakeTimeline({ supportsLoadMore: true, ...timelineOpts });
    const navigation = createFakeNavigation(hash);
    const bus = createFakeBus();
    const h = createFakeContext({ id: 'anchorNav', bus, caps: createFakeCapabilities({ timeline, navigation }) });
    handles.push(h);
    const revealRequests: Element[] = [];
    h.ctx.bus.on('reveal:request', ({ target }) => revealRequests.push(target));
    preMount?.(timeline, navigation);
    anchorNavFeature.create().mount(h.ctx);
    return { h, timeline, navigation, revealRequests };
  }
  const item = (anchor: string) => createFakeTimelineItem({ nodeId: `IC_${anchor}`, anchors: [anchor] });

  it('does nothing without a hash or for non-timeline hashes', async () => {
    for (const hash of ['', 'diff-0123abcd', 'user-content-install']) {
      const focusedLoad = vi.fn(async () => false);
      const s = setup(hash, { focusedLoad });
      await vi.runAllTimersAsync();
      expect(s.navigation.toasts).toEqual([]);
      expect(focusedLoad).not.toHaveBeenCalled();
    }
  });

  const rendered = (onScreen: boolean) => {
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      (onScreen ? { top: 10, bottom: 110, height: 100 } : { top: 5000, bottom: 5100, height: 100 }) as DOMRect
    );
  };

  it('leaves on-screen targets alone', async () => {
    rendered(true);
    const target = item('issuecomment-1');
    const s = setup('issuecomment-1', { items: [target] });
    await vi.runAllTimersAsync();
    expect(s.navigation.highlighted).toEqual([]);
    expect(s.navigation.toasts).toEqual([]);
  });

  it('scrolls to a present but off-screen target (late partial / router hash link)', async () => {
    rendered(false);
    const target = item('issuecomment-1');
    const s = setup('issuecomment-1', { items: [target] });
    await vi.runAllTimersAsync();
    expect(s.navigation.highlighted).toEqual([target.el]);
    expect(s.navigation.toasts).toEqual([]);
    // Later hash navigations scroll even after the user has scrolled.
    window.dispatchEvent(new Event('wheel'));
    const other = item('issuecomment-2');
    s.timeline.addItems([other]);
    s.navigation.setHash('issuecomment-2');
    await vi.runAllTimersAsync();
    expect(s.navigation.highlighted).toEqual([target.el, other.el]);
  });

  it('does not yank the page on settle when it was already scrolled', async () => {
    rendered(false);
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(800);
    const s = setup('issuecomment-1', { items: [item('issuecomment-1')] });
    await vi.runAllTimersAsync();
    expect(s.navigation.highlighted).toEqual([]);
  });

  it('reveals and scrolls to a present target that is collapsed, without a toast', async () => {
    const reveal = vi.fn(async () => true);
    const target = item('issuecomment-1');
    const s = setup('issuecomment-1', { items: [target], reveal });
    await vi.runAllTimersAsync();
    expect(s.revealRequests).toEqual([target.el]);
    expect(reveal).toHaveBeenCalledWith(target.el);
    expect(s.navigation.highlighted).toEqual([target.el]);
    expect(s.navigation.toasts).toEqual([]);
  });

  it('opens the collapsed thread that holds the comment', async () => {
    const ref = {} as { timeline: FakeTimeline };
    const thread: HiddenItemsInfo = { kind: 'collapsedThread', segment: document.createElement('div'), count: 2, containsCommentIds: ['55'] };
    const target = item('discussion_r55');
    const focusedLoad = vi.fn(async () => false);
    const reveal = vi.fn(async (t: Element | HiddenItemsInfo) => {
      if (t === thread) setTimeout(() => ref.timeline.addItems([target]), 10);
      return true;
    });
    const s = setup('discussion_r55', { hidden: [thread], reveal, focusedLoad });
    ref.timeline = s.timeline;
    await vi.runAllTimersAsync();
    expect(reveal).toHaveBeenCalledWith(thread);
    expect(focusedLoad).not.toHaveBeenCalled();
    expect(s.navigation.highlighted).toEqual([target.el]);
    expect(s.navigation.toasts).toEqual([{ text: ANCHOR_TOAST_LOADING, dismissed: true }]);
  });

  it('uses GitHub\'s focused loader before any Load more batches', async () => {
    const ref = {} as { timeline: FakeTimeline };
    const target = item('issuecomment-9');
    const loadUntil = vi.fn(async () => ({ status: 'exhausted' as const, added: 0, batches: 0 }));
    const s = setup('issuecomment-9', {
      focusedLoad: async () => {
        ref.timeline.addItems([target]);
        return true;
      },
      loadUntil,
    });
    ref.timeline = s.timeline;
    await vi.runAllTimersAsync();
    expect(loadUntil).not.toHaveBeenCalled();
    expect(s.navigation.highlighted).toEqual([target.el]);
    expect(s.navigation.toasts[0]).toEqual({ text: ANCHOR_TOAST_LOADING, dismissed: true });
  });

  it('falls back to bounded Load more until the target appears', async () => {
    const ref = {} as { timeline: FakeTimeline };
    const target = item('issuecomment-9');
    let opts: LoadUntilOptions | null = null;
    const s = setup('issuecomment-9', {
      loadUntil: async (pred, o) => {
        opts = o;
        expect(pred()).toBe(false);
        ref.timeline.addItems([target]);
        expect(pred()).toBe(true);
        return { status: 'loaded', added: 1, batches: 1 };
      },
    });
    ref.timeline = s.timeline;
    await vi.runAllTimersAsync();
    expect(opts).toMatchObject({ kinds: ['range', 'hiddenComments'], maxBatches: ANCHOR_MAX_BATCHES });
    expect(s.navigation.highlighted).toEqual([target.el]);
  });

  it('without any loader: no toast, a quiet focused-load attempt, and an info report', async () => {
    const loadUntil = vi.fn(async () => ({ status: 'exhausted' as const, added: 0, batches: 0 }));
    const focusedLoad = vi.fn(async () => false);
    const s = setup('issuecomment-404', { supportsLoadMore: false, loadUntil, focusedLoad });
    await vi.advanceTimersByTimeAsync(10);
    expect(loadUntil).not.toHaveBeenCalled();
    expect(focusedLoad).toHaveBeenCalledTimes(1);
    expect(s.navigation.toasts).toEqual([]);
    expect(s.h.reports).toEqual([expect.objectContaining({ code: 'ANCHOR_NOT_FOUND', severity: 'info', message: 'issueComment:no-loader' })]);
  });

  it('when loading finds nothing: neutral not-found toast that goes away', async () => {
    const s = setup('issuecomment-404', { loadUntil: async () => ({ status: 'exhausted', added: 0, batches: 0 }) });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.h.reports).toEqual([expect.objectContaining({ code: 'ANCHOR_NOT_FOUND', severity: 'info' })]);
    expect(s.navigation.toasts[0]).toEqual({ text: ANCHOR_TOAST_NOT_FOUND, dismissed: false });
    await vi.advanceTimersByTimeAsync(ANCHOR_NOT_FOUND_TOAST_MS);
    expect(s.navigation.toasts[0].dismissed).toBe(true);
  });

  it('a newer hash aborts the in-flight repair', async () => {
    const signals: AbortSignal[] = [];
    const s = setup('issuecomment-1', {
      loadUntil: (_p, o) =>
        new Promise((resolve) => {
          signals.push(o.signal);
          o.signal.addEventListener('abort', () => resolve({ status: 'aborted', added: 0, batches: 0 }));
        }),
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(signals).toHaveLength(1);
    s.navigation.setHash('issuecomment-2');
    await vi.advanceTimersByTimeAsync(10);
    expect(signals[0].aborted).toBe(true);
    expect(signals).toHaveLength(2);
    // The superseded repair's toast is gone; only the new one is up.
    expect(s.navigation.toasts.map((t) => t.dismissed)).toEqual([true, false]);
  });

  it('does not nudge GitHub\'s focused loader while a Load more run is active', async () => {
    const focusedLoad = vi.fn(async () => false);
    const timeline = createFakeTimeline({ supportsLoadMore: true, focusedLoad });
    const h = createFakeContext({
      id: 'anchorNav',
      bus: createFakeBus(),
      caps: createFakeCapabilities({ timeline, navigation: createFakeNavigation('issuecomment-3') }),
    });
    handles.push(h);
    // expandAll is mid-run on the shared session bus when anchorNav mounts.
    h.ctx.bus.emit('timeline:loading', { phase: 'start', loaded: 0, remaining: 10 });
    anchorNavFeature.create().mount(h.ctx);
    await vi.advanceTimersByTimeAsync(10);
    expect(focusedLoad).not.toHaveBeenCalled();
  });

  it('cleans up the toast when the session ends mid-repair', async () => {
    const s = setup('issuecomment-1', {
      loadUntil: (_p, o) => new Promise((resolve) => o.signal.addEventListener('abort', () => resolve({ status: 'aborted', added: 0, batches: 0 }))),
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.navigation.toasts[0].dismissed).toBe(false);
    s.h.abort();
    await vi.advanceTimersByTimeAsync(10);
    expect(s.navigation.toasts[0].dismissed).toBe(true);
    expect(s.navigation.highlighted).toEqual([]);
  });
});
