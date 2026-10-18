import { describe, it, expect, afterEach, vi } from 'vitest';
import { listFixtures, loadFixture, resetFixture } from './fixtureHarness';
import { ownNodes, recordMutations, shutdownAll, startEngine, stubChrome, wait, type BackgroundStub } from './engineHarness';

/**
 * Chaos suite (docs/internal/extension_dom_engine_design.md 11.4): break real fixtures the way a
 * GitHub redesign would, and check that mutators fail closed, unaffected features keep working,
 * the right diagnostics are reported, and the page is never corrupted.
 */

interface Chaos {
  name: string;
  /** Mutates the loaded fixture before the engine starts. */
  apply(doc: Document): void;
  hideEvents?: boolean;
  check(bg: BackgroundStub): void;
}

const outcome = (bg: BackgroundStub, feature: string) =>
  bg.reports.filter((r) => r.feature === feature).map((r) => r.outcome).pop();
const codes = (bg: BackgroundStub, feature: string) =>
  bg.reports.filter((r) => r.feature === feature).flatMap((r) => r.diagnostics.map((d) => d.code));
const hidingClasses = () => document.querySelectorAll('.octodeck-gh-hidden-event, .octodeck-gh-collapsed-comment').length;

const CHAOS: Chaos[] = [
  {
    name: 'timeline root removed',
    hideEvents: true,
    apply: (doc) => doc.querySelectorAll('.js-discussion, #issue-timeline').forEach((el) => el.remove()),
    check: (bg) => {
      expect(ownNodes('noiseCollapser')).toEqual([]);
      expect(ownNodes('timelineMarkers')).toEqual([]);
      expect(hidingClasses()).toBe(0);
      expect(outcome(bg, 'noiseCollapser')).toBe('unrecognized');
      expect(codes(bg, 'noiseCollapser')).toContain('SCOPE_UNRECOGNIZED');
      // Unaffected features still work.
      expect(ownNodes('sidebarWidget').length).toBeGreaterThan(0);
    },
  },
  {
    name: 'composer duplicated',
    apply: (doc) => {
      const composer = doc.querySelector('#react-issue-comment-composer, form.js-new-comment-form');
      composer?.parentElement?.appendChild(composer.cloneNode(true));
    },
    check: (bg) => {
      expect(ownNodes('ackButton')).toEqual([]);
      expect(outcome(bg, 'ackButton')).not.toBe('ok');
      expect(ownNodes('sidebarWidget').length).toBeGreaterThan(0);
    },
  },
  {
    name: 'all data-testid attributes stripped',
    hideEvents: true,
    apply: (doc) => doc.querySelectorAll('[data-testid]').forEach((el) => el.removeAttribute('data-testid')),
    check: (bg) => {
      // Whatever still resolves may mount; nothing may throw, and drift is reported, not guessed.
      const failures = bg.reports.filter((r) => r.outcome === 'unrecognized' || r.outcome === 'drifted');
      const mounted = ownNodes().length > 0;
      expect(failures.length > 0 || mounted).toBe(true);
    },
  },
  {
    name: 'foreign item identity injected',
    apply: (doc) => {
      const foreign = doc.createElement('div');
      foreign.setAttribute('data-gid', 'PR_kwDOforeign000');
      doc.body.appendChild(foreign);
      const foreignIssue = doc.createElement('div');
      foreignIssue.setAttribute('data-gid', 'I_kwDOforeign000');
      doc.body.appendChild(foreignIssue);
    },
    check: (bg) => {
      const ids = bg.messages.filter((m) => m.type === 'GET_ITEM').map((m) => (m as { itemId: string }).itemId);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.filter((id) => id.includes('foreign'))).toEqual([]);
    },
  },
  {
    name: 'unknown GraphQL typename prefixes',
    hideEvents: true,
    apply: (doc) => {
      for (const attr of ['data-gid', 'data-wrapper-timeline-id']) {
        doc.querySelectorAll(`[${attr}^="LE_"]`).forEach((el) => el.setAttribute(attr, `ZZQ_${el.getAttribute(attr)!.slice(3)}`));
      }
    },
    check: (bg) => {
      expect(bg.reports.flatMap((r) => r.diagnostics.map((d) => d.code))).toContain('TIMELINE_UNKNOWN_KIND');
    },
  },
];

describe.each(listFixtures())('chaos: %s', (fixture) => {
  afterEach(() => {
    shutdownAll();
    vi.unstubAllGlobals();
    localStorage.clear();
    resetFixture();
  });

  it.each(CHAOS.map((c) => [c.name, c] as const))('%s', async (_name, chaos) => {
    await loadFixture(fixture);
    chaos.apply(document);
    const bg = stubChrome({ hideEvents: chaos.hideEvents });
    const recorder = recordMutations();
    const engine = await startEngine();
    await wait(700); // let diagnostics flush
    const violations = recorder.stop();

    // The page is never corrupted, whatever broke.
    expect(violations.foreignAdds).toEqual([]);
    expect(violations.foreignRemovals).toEqual([]);
    expect(violations.foreignAttrChanges).toEqual([]);
    expect(bg.reports.flatMap((r) => r.diagnostics.map((d) => `${r.feature}:${d.code}`)).filter((c) => /EXCEPTION|DISABLED/.test(c))).toEqual([]);

    chaos.check(bg);
    engine.shutdown();
    expect(ownNodes()).toEqual([]);
  });
});
