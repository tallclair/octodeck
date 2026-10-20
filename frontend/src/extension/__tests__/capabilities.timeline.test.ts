import type { TimelineLoadAdapter, VariantModule } from '../content/variants/types';
import { VARIANTS } from '../content/variants';
import { parseHiddenCount } from '../content/variants/classic/load';
import { LOAD_ALL_CLASS, expandAllFeature } from '../content/features/expandAll';
import { createFakeContext } from './fakes/context';
import { openCapabilitySession } from './capabilitySession';
import { loadFixture, resetFixture } from './fixtureHarness';
import { threadLoader } from './githubMarkup';

const REACT = 'react-issue-142957';
const CLASSIC = 'classic-pr-141014';

describe('capabilities: timeline', () => {
  afterEach(() => resetFixture());

  it('reports items added after subscription, once, and stops after abort', async () => {
    const meta = await loadFixture(REACT);
    const s = openCapabilitySession(meta.url);
    const timeline = s.caps.timeline!;
    const controller = new AbortController();
    const added: string[][] = [];
    timeline.onItemsAdded((items) => added.push(items.map((it) => it.nodeId ?? '')), controller.signal);

    const root = s.detections.timeline!.root!;
    const clone = timeline.items()[0].el.cloneNode(true) as Element;
    clone.setAttribute('data-wrapper-timeline-id', 'IC_kwDOnewcomment');
    root.appendChild(clone);
    s.fireScopeChange({ scope: 'timeline', addedElements: [clone], rootReplaced: false, removedOwn: [] });
    s.fireScopeChange({ scope: 'timeline', addedElements: [], rootReplaced: false, removedOwn: [] });
    expect(added).toEqual([['IC_kwDOnewcomment']]);

    controller.abort();
    const another = clone.cloneNode(true) as Element;
    another.setAttribute('data-wrapper-timeline-id', 'IC_kwDOlater');
    root.appendChild(another);
    s.fireScopeChange({ scope: 'timeline', addedElements: [another], rootReplaced: false, removedOwn: [] });
    expect(added).toHaveLength(1);
  });

  it('returns stable item wrappers across calls', async () => {
    const meta = await loadFixture(CLASSIC);
    const timeline = openCapabilitySession(meta.url).caps.timeline!;
    expect(timeline.items()[0]).toBe(timeline.items()[0]);
  });

  it('reports an unknown node-id prefix once and falls back to the badge icon for row kinds', async () => {
    const meta = await loadFixture(REACT);
    const lis = document.querySelectorAll('[data-wrapper-timeline-id^="LE_"], [data-wrapper-timeline-id^="AE_"]');
    lis.forEach((li, i) => li.setAttribute('data-wrapper-timeline-id', `ZZZ_new${i}`));
    // The second one also gets an unknown icon: no structural answer either.
    lis[1].querySelector('svg.octicon')!.setAttribute('class', 'octicon octicon-some-new-icon');
    const s = openCapabilitySession(meta.url);
    const unknown = s.caps.timeline!.items().filter((it) => it.kind === 'unknown');
    expect(unknown).toHaveLength(2);
    expect(unknown[0].rows()[0]).toMatchObject({ kind: 'event', kindSource: 'structure' });
    expect(unknown[1].rows()[0].kind).toBe('unknown');
    expect(s.reports.filter((d) => d.code === 'TIMELINE_UNKNOWN_KIND')).toHaveLength(1);
  });

  it('falls back to the badge icon when a classic single-event item has an unmapped prefix', async () => {
    const meta = await loadFixture(CLASSIC);
    const ae = document.querySelector('[data-gid^="AE_"]')!;
    ae.setAttribute('data-gid', 'MIE_kwDOmilestoned');
    const item = openCapabilitySession(meta.url).caps.timeline!.items().find((it) => it.el === ae)!;
    expect(item.kind).toBe('unknown');
    expect(item.rows()[0]).toMatchObject({ kind: 'event', kindSource: 'structure' });
  });

  it('re-reads rows of grouped items after live updates', async () => {
    const meta = await loadFixture(CLASSIC);
    const timeline = openCapabilitySession(meta.url).caps.timeline!;
    const group = timeline.items().find((it) => it.nodeId?.startsWith('RFRE_'))!;
    expect(group.rows()).toHaveLength(7);
    const row = group.rows()[0].el;
    const copy = row.cloneNode(true) as Element;
    copy.id = 'event-999999';
    row.parentElement!.appendChild(copy);
    expect(group.rows()).toHaveLength(8);
  });

  it('classifies classic group rows by badge icon and leaves unknown icons unknown', async () => {
    const meta = await loadFixture(CLASSIC);
    const group = document.querySelector('[data-gid^="RFRE_"]')!;
    const icon = group.querySelector('[id^="event-"] .TimelineItem-badge svg')!;
    icon.setAttribute('class', 'octicon octicon-some-new-icon');
    const item = openCapabilitySession(meta.url).caps.timeline!.items().find((it) => it.el === group)!;
    const rows = item.rows();
    expect(rows).toHaveLength(7);
    expect(rows[0].kind).toBe('unknown');
    expect(rows.slice(1).every((r) => r.kind === 'event')).toBe(true);
  });

  it('exposes review-thread anchors and the review body on classic review items', async () => {
    const meta = await loadFixture(CLASSIC);
    const reviews = openCapabilitySession(meta.url).caps.timeline!.items().filter((it) => it.kind === 'review');
    expect(reviews).toHaveLength(3);
    expect(reviews[0].anchors.some((a) => a.startsWith('discussion_r'))).toBe(true);
    // The second review has its own body ("left a comment"); the third is bodiless.
    expect(reviews[1].body()).not.toBeNull();
    expect(reviews[2].body()).toBeNull();
    expect(reviews[2].anchors.some((a) => a.startsWith('discussion_r'))).toBe(false);
  });

  it('finds prefixed anchor ids by suffix, but not partial-number matches', async () => {
    const meta = await loadFixture(REACT);
    const s = openCapabilitySession(meta.url);
    const target = s.caps.timeline!.items()[2].el.querySelector('[data-testid="markdown-body"]')!;
    target.id = 'comment-anchor-issuecomment-424242';
    expect(s.caps.timeline!.findByAnchor('issuecomment-424242')?.target).toBe(target);
    expect(s.caps.timeline!.findByAnchor('issuecomment-24242')).toBeNull();
  });

  it('fails closed on loading when the variant has no load adapter', async () => {
    const meta = await loadFixture(REACT);
    const timeline = openCapabilitySession(meta.url).caps.timeline!;
    expect(timeline.supportsLoadMore()).toBe(false);
    expect(timeline.hidden()).toEqual([]);
    const signal = new AbortController().signal;
    await expect(timeline.loadUntil(() => false, { signal, maxBatches: 1, batchTimeoutMs: 1, interBatchDelayMs: 0 })).resolves.toEqual({
      status: 'exhausted',
      added: 0,
      batches: 0,
    });
    await expect(timeline.focusedLoad('issuecomment-1', { signal })).resolves.toBe(false);
  });

  it('delegates loading to the variant load adapter through the injected loader', async () => {
    const meta = await loadFixture(CLASSIC);
    const load: TimelineLoadAdapter = {
      supportsLoadMore: () => true,
      hidden: (root) => [{ kind: 'range', segment: root, count: 104 }],
      loadOne: () => Promise.resolve('ended'),
      focusedLoad: (hash) => Promise.resolve(hash === 'issuecomment-9'),
      reveal: () => Promise.resolve(true),
    };
    const variants: VariantModule[] = VARIANTS.map((v) => (v.id === 'classic' ? { ...v, adapters: { ...v.adapters, load } } : v));
    const loader = vi.fn(() => Promise.resolve({ status: 'loaded' as const, added: 3, batches: 1 }));
    const factory = vi.fn(() => loader);
    const timeline = openCapabilitySession(meta.url, { variants, createLoadUntil: factory }).caps.timeline!;
    const signal = new AbortController().signal;

    expect(timeline.supportsLoadMore()).toBe(true);
    expect(timeline.hidden()).toHaveLength(1);
    expect(factory).toHaveBeenCalledTimes(1);
    await expect(timeline.loadUntil(() => false, { signal, maxBatches: 1, batchTimeoutMs: 1, interBatchDelayMs: 0 })).resolves.toMatchObject({ added: 3 });
    await expect(timeline.focusedLoad('#issuecomment-9', { signal })).resolves.toBe(true);
    await expect(timeline.reveal(document.body, { signal })).resolves.toBe(true);
  });
});

describe('capabilities: timeline.loadMoreControls (native Load more anchors)', () => {
  afterEach(() => resetFixture());

  const loaderButton = () => document.querySelector('form.js-ajax-pagination button[data-disable-with]') as HTMLButtonElement;
  const controlReports = (s: ReturnType<typeof openCapabilitySession>) => s.reports.filter((d) => d.anchor === 'timeline.loadMoreControl');

  it('classic: locates the range\'s "Load more…" button and offers the slot right after it', async () => {
    const meta = await loadFixture(CLASSIC);
    const s = openCapabilitySession(meta.url);
    const controls = s.caps.timeline!.loadMoreControls();
    expect(controls).toHaveLength(1);
    const [c] = controls;
    expect(c.control).toBe(loaderButton());
    expect(c.control.textContent?.trim()).toBe('Load more…');
    expect(c.hidden).toMatchObject({ kind: 'range', count: 104, segment: c.control.closest('form') });
    expect(c.insertionPoint).toEqual({ after: c.control });
    expect(controlReports(s)).toEqual([]);
  });

  it('react: unsupported loader, so no controls and no drift', async () => {
    const meta = await loadFixture(REACT);
    const s = openCapabilitySession(meta.url);
    expect(s.caps.timeline!.loadMoreControls()).toEqual([]);
    expect(controlReports(s)).toEqual([]);
  });

  it('fails closed and reports drift once when the range has no recognizable loader button', async () => {
    const meta = await loadFixture(CLASSIC);
    loaderButton().removeAttribute('data-disable-with');
    const s = openCapabilitySession(meta.url);
    expect(s.caps.timeline!.hidden().some((h) => h.kind === 'range')).toBe(true);
    expect(s.caps.timeline!.loadMoreControls()).toEqual([]);
    expect(s.caps.timeline!.loadMoreControls()).toEqual([]);
    expect(controlReports(s)).toEqual([
      expect.objectContaining({ code: 'DOM_ANCHOR_MISSING', scope: 'timeline', message: 'range-without-control' }),
    ]);
  });

  it('fails closed and reports ambiguity when a range has several loader buttons', async () => {
    const meta = await loadFixture(CLASSIC);
    const button = loaderButton();
    button.after(button.cloneNode(true));
    const s = openCapabilitySession(meta.url);
    expect(s.caps.timeline!.loadMoreControls()).toEqual([]);
    expect(controlReports(s)).toEqual([expect.objectContaining({ code: 'DOM_ANCHOR_AMBIGUOUS', count: 2 })]);
  });

  it('follows GitHub replacing the pagination form', async () => {
    const meta = await loadFixture(CLASSIC);
    const s = openCapabilitySession(meta.url);
    const before = s.caps.timeline!.loadMoreControls()[0];
    const form = before.hidden.segment;
    const next = form.cloneNode(true) as Element;
    form.replaceWith(next);
    const after = s.caps.timeline!.loadMoreControls();
    expect(after).toHaveLength(1);
    expect(after[0].hidden.segment).toBe(next);
    expect(next.contains(after[0].control)).toBe(true);
    next.remove();
    expect(s.caps.timeline!.loadMoreControls()).toEqual([]);
  });

  it('ignores review-thread "Load more…" loaders: no control beside them, remaining count stays known', async () => {
    const meta = await loadFixture(CLASSIC);
    document.querySelector('.js-discussion')!.append(threadLoader('111,222'));
    const s = openCapabilitySession(meta.url);
    const timeline = s.caps.timeline!;
    expect(timeline.hidden().filter((h) => h.kind === 'range')).toEqual([expect.objectContaining({ count: 104 })]);
    expect(timeline.loadMoreControls().map((c) => c.control)).toEqual([loaderButton()]);
    expect(controlReports(s)).toEqual([]);

    const h = createFakeContext({ id: 'expandAll', caps: s.caps });
    expandAllFeature.create().mount(h.ctx);
    expect(document.querySelectorAll(`button.${LOAD_ALL_CLASS}`)).toHaveLength(1);
    expect(document.querySelector(`button.${LOAD_ALL_CLASS}`)!.previousElementSibling).toBe(loaderButton());
    h.abort();
  });

  it('expandAll on the real classic capability: "Load all" sits after GitHub\'s button and is invisible to the loader', async () => {
    const meta = await loadFixture(CLASSIC);
    const s = openCapabilitySession(meta.url);
    const h = createFakeContext({ id: 'expandAll', caps: s.caps });
    expandAllFeature.create().mount(h.ctx);
    const own = document.querySelector(`button.${LOAD_ALL_CLASS}`) as HTMLButtonElement;
    expect(own).not.toBeNull();
    expect(own.previousElementSibling).toBe(loaderButton());
    expect(own.type).toBe('button');
    // GitHub's own reads are unchanged by our node: same count, same control, nothing new hidden.
    expect(parseHiddenCount(own.closest('form')!)).toBe(104);
    expect(s.caps.timeline!.loadMoreControls().map((c) => c.control)).toEqual([loaderButton()]);
    expect(h.errors).toEqual([]);
    h.abort();
    expect(document.querySelector(`button.${LOAD_ALL_CLASS}`)).toBeNull();
  });

  it('expandAll on the real react capability renders nothing (unsupported variant)', async () => {
    const meta = await loadFixture(REACT);
    const s = openCapabilitySession(meta.url);
    const h = createFakeContext({ id: 'expandAll', caps: s.caps });
    expandAllFeature.create().mount(h.ctx);
    expect(document.querySelector(`button.${LOAD_ALL_CLASS}`)).toBeNull();
    expect(h.statuses.at(-1)).toEqual({ health: 'notApplicable', detail: 'unsupported-variant' });
    h.abort();
  });
});
