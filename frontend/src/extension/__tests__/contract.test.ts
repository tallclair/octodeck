/**
 * DOM contract tests (design section 11.2): every fixture is run through the real variants,
 * resolver and capabilities, and checked against the expectations in its meta.json `expect` block.
 * A fallback-selector hit fails the test, naming the anchor, variant and selector index.
 */
import type { TimelineItem } from '../content/capabilities/types';
import { ANCHORS } from '../content/dom/anchors';
import type { AnchorId } from '../content/dom/types';
import { VARIANTS } from '../content/variants';
import { openCapabilitySession, type CapabilitySession } from './capabilitySession';
import { listFixtures, loadFixture, resetFixture, type FixtureExpectations, type FixtureMeta } from './fixtureHarness';

/** Anchors read per item (inside a resolved item element), not at the scope root. */
const PER_ITEM_ANCHORS: readonly AnchorId[] = ['timeline.itemBody', 'timeline.itemAuthor', 'timeline.itemTime'];

/** Hashed / generated class names that must never be used as selectors (section 4.6). */
const HASHED_CLASS = /\.[A-Za-z][\w-]*__[A-Za-z0-9_-]{5,}|\.prc-[A-Za-z]+-[A-Za-z]+-[A-Za-z0-9_-]{5}\b/;

interface Session extends CapabilitySession {
  meta: FixtureMeta;
  expect: FixtureExpectations;
}

async function openSession(name: string): Promise<Session> {
  const meta = await loadFixture(name);
  if (!meta.expect) throw new Error(`${name}.meta.json has no "expect" block`);
  return { meta, expect: meta.expect, ...openCapabilitySession(meta.url) };
}

function itemWithAnchor(items: readonly TimelineItem[], anchor: string): TimelineItem | undefined {
  return items.find((it) => it.anchors.includes(anchor));
}

describe('DOM contract', () => {
  afterEach(() => resetFixture());

  describe('registry hygiene', () => {
    it('declares no hashed or partial-class primary selectors', () => {
      for (const variant of VARIANTS) {
        const locators = [...Object.values(variant.anchors), ...Object.values(variant.detectors).map((d) => d?.root)];
        for (const locator of locators) {
          if (!locator) continue;
          for (const selector of locator.selectors) expect(selector, `${variant.id}: ${selector}`).not.toMatch(HASHED_CLASS);
          expect(locator.selectors[0], `${variant.id}: partial class match as primary`).not.toContain('[class*=');
        }
      }
    });

    it('every variant-declared anchor is listed in some fixture expectation of that variant', async () => {
      const covered = new Map<string, Set<string>>();
      for (const name of listFixtures()) {
        const meta = await loadFixture(name);
        for (const [scope, variant] of Object.entries(meta.expect?.scopes ?? {})) {
          const set = covered.get(variant) ?? new Set<string>();
          for (const id of Object.keys(meta.expect?.anchors ?? {})) if (ANCHORS[id as AnchorId]?.scope === scope) set.add(id);
          for (const id of PER_ITEM_ANCHORS) if (scope === 'timeline') set.add(id);
          covered.set(variant, set);
        }
      }
      for (const variant of VARIANTS) {
        const missing = Object.keys(variant.anchors).filter((id) => !covered.get(variant.id)?.has(id));
        expect(missing, `${variant.id} anchors without fixture coverage`).toEqual([]);
      }
    });
  });

  describe.each(listFixtures())('%s', (name) => {
    it('detects the expected variant for every scope', async () => {
      const s = await openSession(name);
      const actual = Object.fromEntries(
        Object.entries(s.detections).map(([scope, det]) => [scope, det?.status === 'recognized' ? det.variant : det?.status])
      );
      expect(actual).toEqual(s.expect.scopes);
    });

    it('computes page facts: kind, validated identity, viewer, release', async () => {
      const s = await openSession(name);
      const facts = s.caps.page.facts();
      expect(facts.kind).toBe(s.meta.pageKind);
      expect(facts.item?.nodeId ?? null).toBe(s.expect.identity);
      expect(facts.viewerLogin).toBe(s.meta.viewerPlaceholder);
      expect(facts.signedIn).toBe(s.meta.signedIn);
      expect(facts.ghRelease).toMatch(/^[0-9a-f]{40}$/);
      expect(s.reports.filter((d) => d.code === 'DOM_IDENTITY_MISMATCH')).toEqual([]);
    });

    it('resolves every anchor as expected, with no fallbacks', async () => {
      const s = await openSession(name);
      const actual = Object.fromEntries(
        Object.keys(s.expect.anchors).map((id) => {
          const res = s.resolver.resolve(id as AnchorId);
          return [id, 'els' in res ? { status: res.status, count: res.els.length } : { status: res.status }];
        })
      );
      expect(actual).toEqual(s.expect.anchors);
      const notable = s.events.map((e) => `${e.anchor} ${e.resolution.status} (variant ${e.resolution.variant}, selector ${'selectorIndex' in e.resolution ? e.resolution.selectorIndex : '-'})`);
      expect(notable, 'fallback / ambiguous / expected-missing resolutions').toEqual([]);
    });

    it('lists timeline items with the expected kinds and readable rows', async () => {
      const s = await openSession(name);
      const items = s.caps.timeline!.items();
      expect(items.map((it) => it.kind)).toEqual(s.expect.items);
      for (const item of items) {
        expect(item.nodeId, 'every item has a node id').toBeTruthy();
        expect(item.timestamp(), `${item.nodeId} timestamp`).not.toBeNull();
        expect(item.author(), `${item.nodeId} author`).not.toBeNull();
        for (const row of item.rows()) expect(row.kind, `${item.nodeId} row ${row.el.id}`).not.toBe('unknown');
      }
      for (const [prefix, kinds] of Object.entries(s.expect.groupRows)) {
        const group = items.find((it) => it.nodeId?.startsWith(prefix));
        expect(group, `group ${prefix}`).toBeDefined();
        expect(group!.rows().map((r) => r.kind)).toEqual(kinds);
        expect(group!.rows().every((r) => r.kindSource === 'structure')).toBe(true);
      }
      expect(s.reports.filter((d) => d.code === 'TIMELINE_UNKNOWN_KIND')).toEqual([]);
    });

    it('reads comment bodies and authors; tells bots from humans', async () => {
      const s = await openSession(name);
      const items = s.caps.timeline!.items();
      for (const id of s.expect.humanCommentIds) {
        const item = itemWithAnchor(items, id);
        expect(item, id).toBeDefined();
        expect(item!.kind).toBe('comment');
        expect(item!.body(), `${id} body`).not.toBeNull();
        const author = item!.author()!;
        expect(author.isBotHint || author.isApp, `${id} (${author.login}) must not look like a bot`).toBe(false);
      }
      for (const id of s.expect.botCommentIds) {
        const author = itemWithAnchor(items, id)?.author();
        expect(author, id).toBeTruthy();
        expect(author!.isBotHint || author!.isApp, `${id} (${author!.login}) should carry a bot signal`).toBe(true);
      }
    });

    it('reports hidden-content segments and load-more support', async () => {
      const s = await openSession(name);
      const timeline = s.caps.timeline!;
      const counts = { range: 0, collapsedThread: 0, hiddenComments: 0 };
      for (const h of timeline.hidden()) counts[h.kind]++;
      expect(counts).toEqual(s.expect.hidden);
      expect(timeline.supportsLoadMore()).toBe(s.expect.supportsLoadMore);
    });

    it('finds comments by URL hash', async () => {
      const s = await openSession(name);
      for (const id of [...s.expect.humanCommentIds, ...s.expect.botCommentIds]) {
        const hit = s.caps.timeline!.findByAnchor(`#${id}`);
        expect(hit?.target.id, id).toBe(id);
        expect(hit?.item.anchors).toContain(id);
      }
      expect(s.caps.timeline!.findByAnchor('#issuecomment-1')).toBeNull();
      expect(s.caps.timeline!.findByAnchor('#issuecomment-new')).toBeNull();
    });

    it('provides composer and sidebar insertion points inside their scope roots', async () => {
      const s = await openSession(name);
      const submit = s.caps.composer!.submitButton();
      expect(submit?.textContent?.trim()).toBe('Comment');
      for (const [scope, point] of [
        ['composer', s.caps.composer!.insertionPoint()],
        ['sidebar', s.caps.sidebar!.insertionPoint()],
      ] as const) {
        expect(point, scope).not.toBeNull();
        const ref = 'before' in point! ? point.before : 'after' in point! ? point.after : point!.appendTo;
        const parent = 'appendTo' in point! ? ref : ref.parentElement;
        // The scope root must contain the insertion parent, so removals of our node are attributed to the scope.
        expect(s.detections[scope]!.root!.contains(parent), `${scope} root contains insertion parent`).toBe(true);
      }
    });
  });
});
