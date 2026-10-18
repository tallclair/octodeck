import { describe, it, expect, beforeEach } from 'vitest';
import { detectScope, Resolver, resolveLocator, isScopeExpected, type ResolveEvent } from '../content/dom/resolver';
import type { VariantModule } from '../content/variants/types';
import { fakePageFacts } from './fakes/capabilities';
import { OWN_ATTR } from '../content/engine/constants';

const classic: VariantModule = {
  id: 'classic',
  detectors: {
    timeline: { variant: 'classic', root: { selectors: ['.js-discussion'] } },
    sidebar: { variant: 'classic', root: { selectors: ['#partial-discussion-sidebar', '.discussion-sidebar'] } },
  },
  anchors: {
    'timeline.root': { selectors: ['.js-discussion'] },
    'timeline.item': { selectors: ['.js-timeline-item'] },
    'sidebar.insertBefore': { selectors: ['#partial-discussion-sidebar', '.discussion-sidebar'] },
    'composer.submit': { selectors: ['button.primary'] },
    'page.identity': { selectors: ['[data-gid^="PR_"]'], value: (el) => el.getAttribute('data-gid') },
  },
  adapters: {},
};

const react: VariantModule = {
  id: 'react',
  detectors: { timeline: { variant: 'react', root: { selectors: ['#issue-timeline'] } } },
  anchors: { 'timeline.item': { selectors: [':scope > li'] } },
  adapters: {},
};

describe('resolver', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('detects the variant owning a scope and its root', () => {
    document.body.innerHTML = '<div class="js-discussion"><div class="js-timeline-item"></div></div>';
    const det = detectScope('timeline', document, [classic, react], fakePageFacts({ kind: 'pr-conversation' }));
    expect(det.status).toBe('recognized');
    expect(det.variant).toBe('classic');
    expect(det.root?.className).toBe('js-discussion');
  });

  it('reports unrecognized when an expected scope matches no variant, absent when not expected', () => {
    const facts = fakePageFacts({ kind: 'issue' });
    expect(detectScope('timeline', document, [classic, react], facts).status).toBe('unrecognized');
    const subtab = fakePageFacts({ kind: 'pr-subtab' });
    expect(isScopeExpected('timeline', subtab)).toBe(false);
    expect(detectScope('timeline', document, [classic, react], subtab).status).toBe('absent');
  });

  it('fails closed when two variants claim the same scope', () => {
    document.body.innerHTML = '<div class="js-discussion"></div><ol id="issue-timeline"></ol>';
    const det = detectScope('timeline', document, [classic, react], fakePageFacts());
    expect(det.status).toBe('ambiguous');
    expect(det.candidates).toEqual(['classic', 'react']);
  });

  it('reports drift when a fallback detector selector matches', () => {
    document.body.innerHTML = '<div class="discussion-sidebar"></div>';
    const det = detectScope('sidebar', document, [classic], fakePageFacts());
    expect(det.status).toBe('recognized');
    expect(det.selectorIndex).toBe(1);
  });

  it('returns ambiguous instead of picking the first match for cardinality one', () => {
    document.body.innerHTML = '<button class="primary"></button><button class="primary"></button>';
    const res = resolveLocator('composer.submit', classic.anchors['composer.submit']!, document.body, 'classic', fakePageFacts());
    expect(res).toMatchObject({ status: 'ambiguous', count: 2, selectorIndex: 0 });
  });

  it('allEqual requires every match to share its value', () => {
    document.body.innerHTML = '<i data-gid="PR_a"></i><i data-gid="PR_a"></i>';
    const loc = classic.anchors['page.identity']!;
    expect(resolveLocator('page.identity', loc, document.body, 'classic', fakePageFacts()).status).toBe('ok');
    document.body.innerHTML = '<i data-gid="PR_a"></i><i data-gid="PR_b"></i>';
    expect(resolveLocator('page.identity', loc, document.body, 'classic', fakePageFacts()).status).toBe('ambiguous');
  });

  it('never returns OctoDeck-owned nodes', () => {
    document.body.innerHTML = `<div ${OWN_ATTR}="sidebarWidget"><button class="primary"></button></div><button class="primary" id="gh"></button>`;
    const res = resolveLocator('composer.submit', classic.anchors['composer.submit']!, document.body, 'classic', fakePageFacts());
    expect(res.status).toBe('ok');
    expect(res.status === 'ok' && res.els[0].id).toBe('gh');
  });

  it('many-cardinality anchors resolve to an empty ok result', () => {
    document.body.innerHTML = '<ol id="issue-timeline"></ol>';
    const det = detectScope('timeline', document, [react], fakePageFacts());
    const r = new Resolver({ facts: fakePageFacts(), detections: { timeline: det }, variants: [react] });
    expect(r.resolve('timeline.item')).toMatchObject({ status: 'ok', els: [] });
  });

  it('memoizes, re-checks connectivity, and reports notable results', () => {
    document.body.innerHTML = '<div class="discussion-sidebar" id="s1"></div>';
    const facts = fakePageFacts();
    const events: ResolveEvent[] = [];
    const r = new Resolver({
      facts,
      detections: { sidebar: detectScope('sidebar', document, [classic], facts) },
      variants: [classic],
      onEvent: (e) => events.push(e),
    });
    const first = r.first('sidebar.insertBefore');
    expect(first?.id).toBe('s1');
    expect(events).toHaveLength(1);
    expect(events[0].resolution).toMatchObject({ status: 'fallback', selectorIndex: 1 });

    // Memo hit: no new event.
    r.first('sidebar.insertBefore');
    expect(events).toHaveLength(1);

    // Detached element forces a recompute.
    first!.remove();
    const again = r.resolve('sidebar.insertBefore');
    expect(again).toMatchObject({ status: 'missing', expected: true });
  });

  it('returns missing for anchors whose scope is not recognized', () => {
    const facts = fakePageFacts();
    const r = new Resolver({ facts, detections: { timeline: detectScope('timeline', document, [classic], facts) }, variants: [classic] });
    expect(r.resolve('timeline.item')).toMatchObject({ status: 'missing', expected: false });
  });

  it('honors absentWhen for the composer when signed out', () => {
    document.body.innerHTML = '<div class="composer"></div>';
    const withComposer: VariantModule = {
      id: 'v',
      detectors: { composer: { variant: 'v', root: { selectors: ['.composer'] } } },
      anchors: { 'composer.submit': { selectors: ['button.primary'] } },
      adapters: {},
    };
    const signedOut = fakePageFacts({ signedIn: false });
    const r = new Resolver({ facts: signedOut, detections: { composer: detectScope('composer', document, [withComposer], signedOut) }, variants: [withComposer] });
    expect(r.resolve('composer.submit')).toMatchObject({ status: 'missing', expected: false });
  });
});
