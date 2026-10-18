import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPAND_ERROR_LOAD_FAILED,
  EXPAND_INTER_BATCH_DELAY_MS,
  EXPAND_MAX_BATCHES,
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
import type { BusEvents } from '../content/engine/types';
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

const range = (count: number | null = 40): HiddenItemsInfo => ({ kind: 'range', segment: document.createElement('form'), count });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('expandAll feature', () => {
  const handles: Array<{ abort(): void }> = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.abort();
    document.body.innerHTML = '';
  });

  function setup(timelineOpts: FakeTimelineOptions = {}) {
    const timeline = createFakeTimeline({ supportsLoadMore: true, hidden: [range()], ...timelineOpts });
    const bus = createFakeBus();
    const h = createFakeContext({ id: 'expandAll', bus, caps: createFakeCapabilities({ timeline }) });
    handles.push(h);
    const states: Array<BusEvents['expand:state']> = [];
    h.ctx.bus.on('expand:state', (s) => states.push(s));
    expandAllFeature.create().mount(h.ctx);
    return { h, timeline, states, command: (action: BusEvents['expand:command']['action']) => h.ctx.bus.emit('expand:command', { action }) };
  }

  it('fails closed for variants without a verified loader', () => {
    const { states, h } = setup({ supportsLoadMore: false });
    expect(states).toEqual([{ available: false, count: null, running: false, bounded: false }]);
    expect(h.statuses.at(-1)).toEqual({ health: 'notApplicable', detail: 'unsupported-variant' });
  });

  it('publishes availability and the hidden count on mount', () => {
    const { states } = setup();
    expect(states.at(-1)).toEqual({ available: true, count: 40, running: false, bounded: false });
  });

  it('reports unavailable when nothing is hidden', () => {
    const { states } = setup({ hidden: [] });
    expect(states.at(-1)).toMatchObject({ available: false, count: 0 });
  });

  it('runs a bounded, polite load on "start" and becomes unavailable when exhausted', async () => {
    let seen: LoadUntilOptions | null = null;
    const ref = {} as { timeline: FakeTimeline };
    const s = setup({
      loadUntil: async (_pred, o) => {
        seen = o;
        o.onProgress?.({ batches: 1, added: 30, remaining: 10 });
        ref.timeline.setHidden([]);
        return { status: 'exhausted', added: 40, batches: 2 };
      },
    });
    ref.timeline = s.timeline;
    s.command('start');
    await flush();
    expect(seen).toMatchObject({ kinds: ['range'], maxBatches: EXPAND_MAX_BATCHES, interBatchDelayMs: EXPAND_INTER_BATCH_DELAY_MS });
    expect(s.states.some((st) => st.running && st.count === 10)).toBe(true);
    expect(s.states.at(-1)).toEqual({ available: false, count: 0, running: false, bounded: false });
  });

  it('offers "Continue" when the batch cap is reached, and continues on command', async () => {
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
    s.command('start');
    await flush();
    expect(s.states.at(-1)).toMatchObject({ available: true, bounded: true, running: false });
    s.command('continue');
    await flush();
    expect(loadUntil).toHaveBeenCalledTimes(2);
    expect(s.states.at(-1)).toMatchObject({ available: false, bounded: false });
  });

  it('surfaces failures as degraded with an error code', async () => {
    const s = setup({ loadUntil: async () => ({ status: 'timeout', added: 0, batches: 0 }) });
    s.command('start');
    await flush();
    expect(s.states.at(-1)).toMatchObject({ available: true, running: false, error: EXPAND_ERROR_LOAD_FAILED });
    expect(s.h.statuses.at(-1)).toEqual({ health: 'degraded', detail: 'load-timeout' });
  });

  it('"stop" aborts the running load; duplicate "start" is ignored', async () => {
    let signal: AbortSignal | null = null;
    const loadUntil = vi.fn(
      (_p: () => boolean, o: LoadUntilOptions) =>
        new Promise<LoadResult>((resolve) => {
          signal = o.signal;
          o.signal.addEventListener('abort', () => resolve({ status: 'aborted', added: 0, batches: 0 }));
        })
    );
    const s = setup({ loadUntil });
    s.command('start');
    s.command('start');
    await flush();
    expect(loadUntil).toHaveBeenCalledTimes(1);
    s.command('stop');
    await flush();
    expect(signal!.aborted).toBe(true);
    expect(s.states.at(-1)).toMatchObject({ running: false, available: true });
  });

  it('session end aborts the run and publishes nothing afterwards', async () => {
    let signal: AbortSignal | null = null;
    const s = setup({
      loadUntil: (_p, o) =>
        new Promise((resolve) => {
          signal = o.signal;
          o.signal.addEventListener('abort', () => resolve({ status: 'aborted', added: 0, batches: 0 }));
        }),
    });
    s.command('start');
    await flush();
    const count = s.states.length;
    s.h.abort();
    await flush();
    expect(signal!.aborted).toBe(true);
    expect(s.states.length).toBe(count);
  });

  it('refreshes availability when GitHub changes the timeline', () => {
    const s = setup();
    s.timeline.setHidden([]);
    s.timeline.addItems([createFakeTimelineItem({ nodeId: 'IC_live' })]);
    expect(s.states.at(-1)).toMatchObject({ available: false });
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
