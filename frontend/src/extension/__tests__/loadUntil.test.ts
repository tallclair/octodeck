import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoadUntil, isUserTyping } from '../content/capabilities/loadUntil';
import type { HiddenItemsInfo, LoadUntilOptions, TimelineItem } from '../content/capabilities/types';
import type { BusEvents } from '../content/engine/types';
import type { LoadOutcome, TimelineLoadAdapter } from '../content/variants/types';
import type { Diagnostic } from '../types';
import { createFakeTimelineItem } from './fakes/capabilities';
import { createFakeBus } from './fakes/context';

/** A scripted timeline: each loadOne call pops the next step and appends that many items. */
function setup(steps: Array<{ outcome: LoadOutcome; add?: number; keepSegment?: boolean }>, initialRanges = 1) {
  const root = document.body.appendChild(document.createElement('div'));
  const items: TimelineItem[] = [];
  let ranges: HiddenItemsInfo[] = Array.from({ length: initialRanges }, (_, i) => ({
    kind: 'range' as const,
    segment: root.appendChild(document.createElement('form')),
    count: 10 * (i + 1),
  }));
  const calls: HiddenItemsInfo[] = [];
  let n = 0;
  const adapter: TimelineLoadAdapter = {
    supportsLoadMore: () => true,
    hidden: () => ranges,
    loadOne: vi.fn(async (seg: HiddenItemsInfo) => {
      calls.push(seg);
      const step = steps.shift() ?? { outcome: 'failed' as const };
      for (let i = 0; i < (step.add ?? 0); i++) {
        const item = createFakeTimelineItem({ nodeId: `IC_${n++}` });
        root.appendChild(item.el);
        items.push(item);
      }
      if (!step.keepSegment && (step.outcome === 'loaded' || step.outcome === 'ended')) {
        ranges = ranges.slice(1);
      }
      return step.outcome;
    }),
    reveal: async () => false,
  };
  const reports: Diagnostic[] = [];
  const events: Array<{ name: keyof BusEvents; value: unknown }> = [];
  const busFactory = createFakeBus();
  const controller = new AbortController();
  const bus = busFactory.forSignal(controller.signal);
  for (const name of ['timeline:loading', 'timeline:changed'] as const) {
    bus.on(name, (value) => events.push({ name, value }));
  }
  const loadUntil = createLoadUntil({
    items: () => items,
    hidden: () => ranges,
    adapter,
    bus,
    doc: document,
    report: (d) => reports.push(d),
  });
  return { loadUntil, adapter, calls, reports, events, items, setRanges: (r: HiddenItemsInfo[]) => (ranges = r) };
}

const opts = (over: Partial<LoadUntilOptions> = {}): LoadUntilOptions => ({
  signal: new AbortController().signal,
  maxBatches: 25,
  batchTimeoutMs: 1000,
  interBatchDelayMs: 0,
  ...over,
});

describe('createLoadUntil', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads batches until no hidden range remains', async () => {
    const { loadUntil, events } = setup([{ outcome: 'loaded', add: 3, keepSegment: true }, { outcome: 'loaded', add: 2 }]);
    const r = await loadUntil(() => false, opts());
    expect(r).toEqual({ status: 'exhausted', added: 5, batches: 2 });
    const phases = events.filter((e) => e.name === 'timeline:loading').map((e) => (e.value as { phase: string }).phase);
    expect(phases).toEqual(['start', 'batch', 'batch', 'end']);
    const changed = events.filter((e) => e.name === 'timeline:changed').map((e) => (e.value as BusEvents['timeline:changed']).added.length);
    expect(changed).toEqual([3, 2]);
  });

  it('stops as soon as the predicate holds', async () => {
    const s = setup([{ outcome: 'loaded', add: 1, keepSegment: true }, { outcome: 'loaded', add: 1, keepSegment: true }]);
    const r = await s.loadUntil(() => s.items.length >= 1, opts());
    expect(r.status).toBe('loaded');
    expect(s.adapter.loadOne).toHaveBeenCalledTimes(1);
  });

  it('never calls the adapter when the predicate already holds', async () => {
    const s = setup([]);
    const r = await s.loadUntil(() => true, opts());
    expect(r).toEqual({ status: 'loaded', added: 0, batches: 0 });
    expect(s.adapter.loadOne).not.toHaveBeenCalled();
  });

  it('is bounded by maxBatches', async () => {
    const steps = Array.from({ length: 10 }, () => ({ outcome: 'loaded' as const, add: 1, keepSegment: true }));
    const s = setup(steps);
    const r = await s.loadUntil(() => false, opts({ maxBatches: 3 }));
    expect(r).toEqual({ status: 'loaded', added: 3, batches: 3 });
  });

  it('stops at the first failure and reports it', async () => {
    const s = setup([{ outcome: 'loaded', add: 1, keepSegment: true }, { outcome: 'timeout' }, { outcome: 'loaded', add: 1 }]);
    const r = await s.loadUntil(() => false, opts());
    expect(r).toEqual({ status: 'timeout', added: 1, batches: 1 });
    expect(s.reports).toEqual([expect.objectContaining({ code: 'LOADMORE_FAILED', anchor: 'timeline.hiddenRange', message: 'loadOne:timeout' })]);
    const end = s.events.filter((e) => e.name === 'timeline:loading').at(-1)?.value as BusEvents['timeline:loading'];
    expect(end).toMatchObject({ phase: 'end', error: 'timeout' });
  });

  it('reports no progress when a range "loads" without adding items', async () => {
    const s = setup([{ outcome: 'loaded', add: 0, keepSegment: true }]);
    const r = await s.loadUntil(() => false, opts());
    expect(r.status).toBe('noProgress');
    expect(s.reports[0]).toMatchObject({ code: 'LOADMORE_NO_PROGRESS' });
  });

  it('treats a control removed without items (404) as the end of that segment', async () => {
    const s = setup([{ outcome: 'ended', add: 0 }]);
    expect((await s.loadUntil(() => false, opts())).status).toBe('exhausted');
  });

  it('reports no progress when "ended" leaves the same control in place', async () => {
    const s = setup([{ outcome: 'ended', add: 0, keepSegment: true }]);
    expect((await s.loadUntil(() => false, opts())).status).toBe('noProgress');
  });

  it('only loads the requested kinds', async () => {
    const s = setup([]);
    s.setRanges([{ kind: 'collapsedThread', segment: document.createElement('div'), count: 2 }]);
    const r = await s.loadUntil(() => false, opts());
    expect(r.status).toBe('exhausted');
    expect(s.adapter.loadOne).not.toHaveBeenCalled();
  });

  it('aborts between batches and keeps the progress made so far', async () => {
    const controller = new AbortController();
    const s = setup([{ outcome: 'loaded', add: 2, keepSegment: true }, { outcome: 'loaded', add: 2, keepSegment: true }]);
    const p = s.loadUntil(() => false, opts({ signal: controller.signal, interBatchDelayMs: 50 }));
    await vi.waitFor(() => expect(s.adapter.loadOne).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await p).toEqual({ status: 'aborted', added: 2, batches: 1 });
  });

  it('serializes concurrent runs (session mutex)', async () => {
    let active = 0;
    let maxActive = 0;
    const s = setup([]);
    s.adapter.loadOne = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return 'failed' as const;
    });
    await Promise.all([s.loadUntil(() => false, opts()), s.loadUntil(() => false, opts())]);
    expect(s.adapter.loadOne).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it('an aborted waiter does not block later runs', async () => {
    const s = setup([]);
    let release!: () => void;
    s.adapter.loadOne = vi.fn(
      () =>
        new Promise<LoadOutcome>((r) => {
          release = () => r('failed');
        })
    );
    const first = s.loadUntil(() => false, opts());
    await vi.waitFor(() => expect(s.adapter.loadOne).toHaveBeenCalledTimes(1));
    const waiter = new AbortController();
    const second = s.loadUntil(() => false, opts({ signal: waiter.signal }));
    waiter.abort();
    expect((await second).status).toBe('aborted');
    release();
    await first;
    s.adapter.loadOne = vi.fn(async () => 'failed' as const);
    expect((await s.loadUntil(() => false, opts())).status).toBe('failed');
  });

  it('waits while the tab is hidden', async () => {
    const s = setup([{ outcome: 'loaded', add: 1 }]);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const p = s.loadUntil(() => false, opts());
    await new Promise((r) => setTimeout(r, 10));
    expect(s.adapter.loadOne).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect((await p).status).toBe('exhausted');
  });

  it('waits while the user is typing', async () => {
    vi.useFakeTimers();
    const s = setup([{ outcome: 'loaded', add: 1 }]);
    const ta = document.body.appendChild(document.createElement('textarea'));
    ta.focus();
    const p = s.loadUntil(() => false, opts());
    await vi.advanceTimersByTimeAsync(2500);
    expect(s.adapter.loadOne).not.toHaveBeenCalled();
    ta.blur();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await p).status).toBe('exhausted');
  });
});

describe('isUserTyping', () => {
  it('detects editable focus only', () => {
    document.body.innerHTML =
      '<textarea></textarea><input type="text"><input type="checkbox"><button>b</button><div contenteditable="true" tabindex="0"><span tabindex="0">x</span></div>';
    const [ta, text, box, button, editor] = Array.from(document.body.children) as HTMLElement[];
    ta.focus();
    expect(isUserTyping(document)).toBe(true);
    text.focus();
    expect(isUserTyping(document)).toBe(true);
    box.focus();
    expect(isUserTyping(document)).toBe(false);
    button.focus();
    expect(isUserTyping(document)).toBe(false);
    (editor.firstElementChild as HTMLElement).focus();
    expect(isUserTyping(document)).toBe(true);
  });
});
