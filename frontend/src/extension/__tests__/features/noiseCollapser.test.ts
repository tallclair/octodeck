import { describe, it, expect, afterEach, vi } from 'vitest';
import { noiseCollapser, COLLAPSED_CLASS, HIDDEN_EVENT_CLASS } from '../../content/features/noiseCollapser';
import { createFakeTimeline, createFakeTimelineItem } from '../fakes/capabilities';
import { createFakeBus, createFakeContext } from '../fakes/context';
import type { TimelineItem, TimelineItemKind } from '../../content/capabilities/types';
import type { PrefsSnapshot } from '../../content/engine/types';
import { OWN_ATTR } from '../../content/engine/constants';
import { capsWith } from './helpers';

const human = (id: string, text = 'looks good') =>
  createFakeTimelineItem({ nodeId: id, kind: 'comment', author: { login: 'alice', isBotHint: false, isApp: false }, body: true, text });
const bot = (id: string, text = 'CI passed', login = 'k8s-ci-robot') =>
  createFakeTimelineItem({ nodeId: id, kind: 'comment', author: { login, isBotHint: false, isApp: false }, body: true, text });
const event = (id: string, kind: TimelineItemKind = 'event') => createFakeTimelineItem({ nodeId: id, kind, text: `${kind} ${id}` });

function group(id: string, kinds: TimelineItemKind[]): TimelineItem {
  return createFakeTimelineItem({
    nodeId: id,
    kind: 'event',
    rows: kinds.map((kind, i) => {
      const el = document.createElement('div');
      el.textContent = `${kind} row ${i}`;
      return { el, kind };
    }),
  });
}

function setup(items: TimelineItem[], prefs: Partial<PrefsSnapshot> = {}, bus = createFakeBus()) {
  document.body.innerHTML = '';
  const timeline = createFakeTimeline({ items });
  const before = document.body.innerHTML;
  const handle = createFakeContext({
    id: 'noiseCollapser',
    caps: capsWith({ timeline }, { viewerLogin: 'me' }),
    prefs,
    bus,
  });
  noiseCollapser.create().mount(handle.ctx);
  return { ...handle, timeline, before };
}

const boxes = () => Array.from(document.querySelectorAll<HTMLElement>('.octodeck-gh-dense-timeline-item'));
const collapsed = (item: TimelineItem) => item.el.classList.contains(COLLAPSED_CLASS);
const hidden = (el: Element) => el.classList.contains(HIDDEN_EVENT_CLASS);

describe('noiseCollapser', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('declares itself as a timeline-gated mutator', () => {
    const f = noiseCollapser.create();
    expect(f.kind).toBe('mutator');
    expect(f.requires).toEqual(['timeline']);
  });

  it('collapses adjacent bot comments into one own box in front of the run', () => {
    const items = [human('IC_1'), bot('IC_2', 'first line\nsecond'), bot('IC_3', '/retest', 'someone-bot'), human('IC_4')];
    setup(items);
    const [box] = boxes();
    expect(boxes()).toHaveLength(1);
    expect(box.getAttribute(OWN_ATTR)).toBe('noiseCollapser');
    expect(box.nextElementSibling).toBe(items[1].el);
    expect(box.className).toBe('octodeck-gh-dense-timeline-item');
    expect(items.map(collapsed)).toEqual([false, true, true, false]);
    const rows = box.querySelectorAll('.octodeck-gh-dense-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.octodeck-gh-dense-author')?.textContent).toBe('@k8s-ci-robot');
    expect(rows[0].querySelector('.octodeck-gh-dense-text')?.textContent).toBe('first line');
    expect(box.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('Collapsed activity');
  });

  it('collapses slash-command comments and /apps/ authors (decision 13), but never the viewer', () => {
    const app = createFakeTimelineItem({
      nodeId: 'IC_2',
      kind: 'comment',
      author: { login: 'some-app', isBotHint: false, isApp: true },
      body: true,
      text: 'report',
    });
    const viewer = createFakeTimelineItem({
      nodeId: 'IC_4',
      kind: 'comment',
      author: { login: 'Me', isBotHint: true, isApp: false },
      body: true,
      text: 'mine',
    });
    const items = [human('IC_1', '/lgtm'), app, human('IC_3'), viewer];
    setup(items);
    expect(items.map(collapsed)).toEqual([true, true, false, false]);
    expect(boxes()).toHaveLength(1);
  });

  it('never collapses reviews, even bot reviews with comments', () => {
    const review = createFakeTimelineItem({
      nodeId: 'PRR_1',
      kind: 'review',
      author: { login: 'copilot[bot]', isBotHint: true, isApp: true },
      body: true,
      text: 'Review summary\nwith comments',
    });
    const items = [bot('IC_1'), review, bot('IC_2')];
    setup(items);
    expect(collapsed(review)).toBe(false);
    expect(boxes()).toHaveLength(2);
  });

  it('honors known bots from prefs and updates when they change', () => {
    const items = [human('IC_1'), bot('IC_2', 'beep', 'prow'), human('IC_3')];
    const { setPrefs } = setup(items, { knownBots: [] });
    expect(collapsed(items[1])).toBe(false);
    setPrefs({ knownBots: ['prow'] });
    expect(collapsed(items[1])).toBe(true);
  });

  describe('Hide events', () => {
    it('with events shown, events split runs and are never boxed', () => {
      const items = [human('IC_0'), bot('IC_1'), event('LE_1'), bot('IC_2'), human('IC_3')];
      setup(items);
      expect(boxes()).toHaveLength(2);
      expect(hidden(items[2].el)).toBe(false);
      expect(collapsed(items[2])).toBe(false);
    });

    it('hides allowlisted rows and lets hidden events join runs', () => {
      const items = [human('IC_0'), bot('IC_1'), event('LE_1'), event('C_1', 'commit'), bot('IC_2'), human('IC_3')];
      setup(items, { hideEvents: true });
      expect(hidden(items[2].el)).toBe(true);
      expect(hidden(items[3].el)).toBe(true);
      expect(boxes()).toHaveLength(1);
      expect(boxes()[0].querySelectorAll('.octodeck-gh-dense-row')).toHaveLength(2);
    });

    it('never hides unknown, other events, close/reopen, references, reviews or rows with a body', () => {
      // A row with a body (inside an event group) is never hidden.
      const bodyEl = document.createElement('div');
      bodyEl.textContent = 'has text';
      const withBody = createFakeTimelineItem({ nodeId: 'LE_9', kind: 'event', rows: [{ kind: 'event', body: bodyEl }] });
      const keep = [
        event('X_1', 'unknown'),
        event('HRFPE_1', 'otherEvent'),
        event('CE_1', 'closeReopen'),
        event('CRE_1', 'reference'),
        event('PRR_1', 'review'),
        event('PR_1', 'description'),
        withBody,
      ];
      const items = [human('IC_0'), human('IC_00'), ...keep, event('LE_1'), event('LE_2')];
      setup(items, { hideEvents: true });
      for (const item of keep) expect(hidden(item.el)).toBe(false);
      expect(hidden(items[items.length - 1].el)).toBe(true);
    });

    it('hides a grouped item only when every row is hideable, otherwise per row', () => {
      const allNoise = group('LE_g1', ['event', 'event', 'commit']);
      const mixed = group('LE_g2', ['event', 'closeReopen', 'event']);
      const items = [human('IC_1'), human('IC_2'), human('IC_3'), allNoise, mixed];
      setup(items, { hideEvents: true });
      expect(hidden(allNoise.el)).toBe(true);
      expect(hidden(mixed.el)).toBe(false);
      expect(mixed.rows().map((r) => hidden(r.el))).toEqual([true, false, true]);
    });

    it('hides normally on bot PRs with no comments and mostly events', () => {
      const items = [event('PR_1', 'description'), event('C_1', 'commit'), event('LE_1'), event('LE_2'), event('LE_3'), event('PRR_1', 'review')];
      const { reports } = setup(items, { hideEvents: true });
      expect(items.map((i) => hidden(i.el))).toEqual([false, true, true, true, true, false]);
      expect(reports).toEqual([]);
    });

    it('skips hiding and reports once when classification looks drifted (sanity check)', () => {
      // User content inside an item classified as a bodiless event kind.
      const drifted = createFakeTimelineItem({ nodeId: 'LE_x', kind: 'event', body: true, text: 'real comment text' });
      const items = [human('IC_1'), event('LE_1'), drifted, event('LE_2')];
      const { reports, setPrefs, statuses } = setup(items, { hideEvents: true });
      expect(items.some((i) => hidden(i.el))).toBe(false);
      setPrefs({ hideEvents: true });
      expect(reports.filter((r) => r.code === 'DOM_CLASSIFY_ANOMALY')).toHaveLength(1);
      expect(statuses).toContainEqual({ health: 'degraded', detail: 'classify-anomaly' });
    });

    it('follows the preference both ways', () => {
      const items = [human('IC_1'), bot('IC_2'), event('LE_1'), bot('IC_3'), human('IC_4')];
      const { setPrefs } = setup(items);
      expect(boxes()).toHaveLength(2);
      setPrefs({ hideEvents: true });
      expect(hidden(items[2].el)).toBe(true);
      expect(boxes()).toHaveLength(1);
      setPrefs({ hideEvents: false });
      expect(hidden(items[2].el)).toBe(false);
      expect(boxes()).toHaveLength(2);
      expect(items.map(collapsed)).toEqual([false, true, false, true, false]);
    });
  });

  it('expands multi-line rows in place with a sanitized clone of the body', () => {
    const body = document.createElement('div');
    body.innerHTML = '<p id="user-content-x">Summary line</p>\n<p>See <a href="https://example.com/x" onclick="evil()">details</a></p>';
    const item = createFakeTimelineItem({
      nodeId: 'IC_2',
      kind: 'comment',
      author: { login: 'ci[bot]', isBotHint: false, isApp: false },
      body,
    });
    item.el.appendChild(body);
    const items = [human('IC_1'), item, human('IC_3')];
    const { setPrefs } = setup(items);
    const btn = () => boxes()[0].querySelector<HTMLButtonElement>('.octodeck-gh-dense-expand-btn')!;
    const rest = () => boxes()[0].querySelector<HTMLElement>('.octodeck-gh-dense-rest')!;
    expect(btn().textContent).toBe('[+]');
    expect(rest().hidden).toBe(true);
    expect(boxes()[0].querySelector('.octodeck-gh-dense-text')?.textContent).toBe('Summary line');

    btn().click();
    expect(btn().textContent).toBe('[-]');
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    expect(rest().hidden).toBe(false);
    expect(rest().textContent).not.toContain('Summary line');
    const link = rest().querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com/x');
    expect(link.hasAttribute('onclick')).toBe(false);
    expect(rest().querySelector('[id]')).toBeNull();

    // Expanded state survives a regroup that rebuilds the box (the humans become known bots).
    const oldBox = boxes()[0];
    setPrefs({ knownBots: ['alice'] });
    expect(boxes()[0]).not.toBe(oldBox);
    expect(boxes()[0].querySelectorAll('.octodeck-gh-dense-row')).toHaveLength(3);
    expect(btn().textContent).toBe('[-]');
  });

  it('regroups after items are added (debounced), reusing unchanged boxes', async () => {
    vi.useFakeTimers();
    const items = [human('IC_1'), bot('IC_2'), human('IC_3'), bot('IC_4')];
    const { timeline } = setup(items);
    const firstBox = boxes()[0];
    expect(boxes()).toHaveLength(2);
    timeline.addItems([bot('IC_5')]);
    expect(boxes()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(boxes()).toHaveLength(2);
    expect(boxes()[0]).toBe(firstBox);
    expect(boxes()[1].querySelectorAll('.octodeck-gh-dense-row')).toHaveLength(2);
  });

  it('defers regrouping while timeline batches load and regroups once at the end', async () => {
    vi.useFakeTimers();
    const bus = createFakeBus();
    const items = [human('IC_1'), bot('IC_2')];
    const { timeline, ctx } = setup(items, {}, bus);
    ctx.bus.emit('timeline:loading', { phase: 'start', loaded: 0, remaining: 3 });
    timeline.addItems([bot('IC_3')]);
    ctx.bus.emit('timeline:changed', { added: [], reason: 'loadMore' });
    await vi.advanceTimersByTimeAsync(200);
    expect(boxes()[0].querySelectorAll('.octodeck-gh-dense-row')).toHaveLength(1);
    ctx.bus.emit('timeline:loading', { phase: 'end', loaded: 1, remaining: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(boxes()[0].querySelectorAll('.octodeck-gh-dense-row')).toHaveLength(2);
  });

  it('puts its box back when GitHub re-renders and drops it', () => {
    const items = [human('IC_1'), bot('IC_2'), human('IC_3')];
    const { emitScopeChange } = setup(items);
    vi.useFakeTimers();
    const box = boxes()[0];
    box.remove();
    emitScopeChange({ scope: 'timeline', addedElements: [], removedOwn: [box], rootReplaced: false });
    vi.advanceTimersByTime(100);
    expect(box.isConnected).toBe(true);
    expect(box.nextElementSibling).toBe(items[1].el);
  });

  describe('reveal:request', () => {
    it('un-collapses the comment containing the target synchronously and keeps it visible', () => {
      const bus = createFakeBus();
      const items = [human('IC_1'), bot('IC_2'), bot('IC_3'), bot('IC_4'), human('IC_5')];
      const { ctx, setPrefs } = setup(items, {}, bus);
      const target = items[2].body()!;
      ctx.bus.emit('reveal:request', { target });
      expect(collapsed(items[2])).toBe(false);
      expect(items.map(collapsed)).toEqual([false, true, false, true, false]);
      setPrefs({ knownBots: [] });
      expect(collapsed(items[2])).toBe(false);
    });

    it('un-hides the event row containing the target', () => {
      const bus = createFakeBus();
      const g = group('LE_g', ['event', 'event']);
      const items = [human('IC_1'), human('IC_2'), human('IC_3'), g];
      const { ctx } = setup(items, { hideEvents: true }, bus);
      expect(hidden(g.el)).toBe(true);
      ctx.bus.emit('reveal:request', { target: g.rows()[1].el });
      expect(hidden(g.el)).toBe(false);
      expect(hidden(g.rows()[1].el)).toBe(false);
    });
  });

  it('restores GitHub DOM exactly on unmount', () => {
    const items = [human('IC_1'), bot('IC_2'), event('LE_1'), bot('IC_3'), human('IC_4'), group('LE_g', ['event', 'reference'])];
    const { abort, before } = setup(items, { hideEvents: true });
    expect(document.body.innerHTML).not.toBe(before);
    abort();
    expect(document.body.innerHTML).toBe(before);
  });

  it('does nothing without a timeline', () => {
    const handle = createFakeContext({ id: 'noiseCollapser', caps: capsWith({ timeline: null }) });
    noiseCollapser.create().mount(handle.ctx);
    expect(handle.statuses).toContainEqual({ health: 'notApplicable', detail: 'scope:timeline' });
  });
});
