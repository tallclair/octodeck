import { describe, it, expect, afterEach, vi } from 'vitest';
import { listFixtures, loadFixture, resetFixture, type FixtureMeta } from './fixtureHarness';
import { ownNodes, recordMutations, shutdownAll, snapshot, startEngine, stubChrome, wait } from './engineHarness';

// Whole-engine invariants on every real fixture (docs/internal/extension_dom_engine_design.md 11.3).
describe.each(listFixtures())('invariants: %s', (name) => {
  afterEach(() => {
    shutdownAll();
    vi.unstubAllGlobals();
    localStorage.clear();
    resetFixture();
  });

  describe.each([false, true])('hide events %s', (hideEvents) => {
    it('only adds tagged nodes, never edits GitHub nodes, hides no human comment, and reverts exactly', async () => {
      const meta: FixtureMeta = await loadFixture(name);
      const bg = stubChrome({ hideEvents });
      const before = snapshot();
      const recorder = recordMutations();

      const engine = await startEngine();
      const violations = recorder.stop();

      expect(violations.foreignAdds).toEqual([]);
      expect(violations.foreignRemovals).toEqual([]);
      expect(violations.foreignAttrChanges).toEqual([]);

      // The sidebar widget and the Ack button mount on both variants.
      expect(ownNodes('sidebarWidget').length).toBeGreaterThan(0);
      expect(ownNodes('ackButton').length).toBeGreaterThan(0);

      // Human comments are never hidden as events. (Slash-command-only comments may be collapsed
      // into a dense preview, as before; the feature suites cover that.)
      for (const id of meta.expect?.humanCommentIds ?? []) {
        const el = document.getElementById(id);
        expect(el, id).not.toBeNull();
        expect(el!.closest('.octodeck-gh-hidden-event'), id).toBeNull();
      }

      // Unmodified fixtures produce no failures or drift.
      await wait(700);
      const outcomes = bg.reports.map((r) => `${r.feature}:${r.outcome}`);
      expect(outcomes.filter((o) => /:(unrecognized|disabled|drifted)$/.test(o))).toEqual([]);
      const codes = bg.reports.flatMap((r) => r.diagnostics.map((d) => `${r.feature}:${d.code}`));
      expect(codes.filter((c) => /FALLBACK|AMBIGUOUS|MISSING|UNRECOGNIZED|EXCEPTION|DISABLED/.test(c))).toEqual([]);

      engine.shutdown();
      expect(ownNodes()).toEqual([]);
      expect(snapshot()).toBe(before);
    });
  });

  it('leaves exactly one instance of each widget after rapid overlapping navigations', async () => {
    const meta = await loadFixture(name);
    stubChrome();
    const engine = await startEngine();
    const base = new URL(meta.url);
    const number = Number(base.pathname.split('/')[4]);
    // Each item change starts a new session while the previous one may still be mounting.
    for (const n of [number + 1, number + 2, number]) {
      window.history.pushState(null, '', base.pathname.replace(/\/\d+$/, `/${n}`));
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    await wait(900);
    const sections = ownNodes('sidebarWidget').filter((el) => !el.parentElement?.closest('[data-octodeck]'));
    const acks = ownNodes('ackButton').filter((el) => !el.parentElement?.closest('[data-octodeck]'));
    expect(sections).toHaveLength(1);
    expect(acks).toHaveLength(1);
    engine.shutdown();
    expect(ownNodes()).toEqual([]);
  });
});
