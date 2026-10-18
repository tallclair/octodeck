/**
 * WP4 features on real capabilities built from the sanitized GitHub fixtures: the features mount
 * through the capability layer only, never hide human comments, collapse the known bot comments,
 * and leave GitHub's DOM byte-identical after unmount.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { listFixtures, loadFixture, resetFixture } from '../fixtureHarness';
import { openCapabilitySession } from '../capabilitySession';
import { createFakeBus, createFakeContext, type FakeContextHandle } from '../fakes/context';
import { sidebarWidget } from '../../content/features/sidebarWidget';
import { ackButton } from '../../content/features/ackButton';
import { noiseCollapser, COLLAPSED_CLASS, HIDDEN_EVENT_CLASS } from '../../content/features/noiseCollapser';
import { timelineMarkers } from '../../content/features/timelineMarkers';
import type { FeatureRegistration } from '../../content/engine/types';
import { OWN_ATTR } from '../../content/engine/constants';
import { flush, makeItem } from './helpers';

const FEATURES: FeatureRegistration[] = [sidebarWidget, ackButton, noiseCollapser, timelineMarkers];

async function mountAll(name: string, hideEvents: boolean) {
  const meta = await loadFixture(name);
  const session = openCapabilitySession();
  const facts = session.caps.page.facts();
  const items = session.caps.timeline!.items();
  const ackedAt = new Date(items.map((i) => i.timestamp()).filter((t): t is number => t !== null)[2]).toISOString();
  const snapshot = document.documentElement.outerHTML;
  const bus = createFakeBus();
  const handles: FakeContextHandle[] = FEATURES.map((reg) => {
    const handle = createFakeContext({
      id: reg.id,
      caps: session.caps,
      bus,
      prefs: { hideEvents },
      session: { facts },
      onSend: (msg) =>
        msg.type === 'GET_ITEM'
          ? {
              ok: true,
              data: makeItem(
                { id: facts.item!.nodeId, repo: `${facts.item!.owner}/${facts.item!.repo}`, number: facts.item!.number },
                { ackedAt }
              ),
            }
          : { ok: false, error: 'unhandled' },
    });
    reg.create().mount(handle.ctx);
    return handle;
  });
  await flush();
  return { meta, session, handles, snapshot };
}

/** True when the element or an ancestor carries the class. */
function hasClassUp(el: Element | null, cls: string): boolean {
  for (let n = el; n; n = n.parentElement) if (n.classList.contains(cls)) return true;
  return false;
}

describe.each(listFixtures())('WP4 features on fixture %s', (name) => {
  afterEach(() => resetFixture());

  for (const hideEvents of [false, true]) {
    describe(`Hide events ${hideEvents ? 'on' : 'off'}`, () => {
      it('mounts every feature through capabilities and never hides human comments', async () => {
        const { meta, handles, session } = await mountAll(name, hideEvents);
        const exp = meta.expect!;

        for (const h of handles) expect(h.errors, h.ctx.id).toEqual([]);
        expect(handles.flatMap((h) => h.reports).filter((r) => r.code === 'DOM_CLASSIFY_ANOMALY')).toEqual([]);

        expect(document.querySelector(`[${OWN_ATTR}="sidebarWidget"]`)).not.toBeNull();
        expect(document.querySelector(`[${OWN_ATTR}="ackButton"]`)).not.toBeNull();
        expect(document.querySelector(`[${OWN_ATTR}="timelineMarkers"]`)).not.toBeNull();

        for (const id of exp.humanCommentIds) {
          const el = document.getElementById(id);
          expect(el, id).not.toBeNull();
          expect(hasClassUp(el, HIDDEN_EVENT_CLASS), `${id} hidden`).toBe(false);
          // A human comment is only ever collapsed into a dense box when it is slash commands only
          // (e.g. "/assign"), as today; its text stays visible in the box.
          if (hasClassUp(el, COLLAPSED_CLASS)) {
            const item = session.caps.timeline!.items().find((i) => i.anchors.includes(id))!;
            expect(item.body()?.textContent?.trim(), `${id} collapsed`).toMatch(/^\//);
          }
        }
        for (const id of exp.botCommentIds) {
          expect(hasClassUp(document.getElementById(id), COLLAPSED_CLASS), `${id} collapsed`).toBe(true);
        }
        expect(document.querySelectorAll(`[${OWN_ATTR}="noiseCollapser"]`).length).toBeGreaterThan(0);

        const hiddenEls = document.querySelectorAll(`.${HIDDEN_EVENT_CLASS}`);
        if (hideEvents) expect(hiddenEls.length).toBeGreaterThan(0);
        else expect(hiddenEls.length).toBe(0);
      });

      it('hides only rows positively identified as hideable kinds', async () => {
        const { session } = await mountAll(name, hideEvents);
        for (const item of session.caps.timeline!.items()) {
          if (item.kind === 'review' || item.kind === 'reviewThread') {
            // The user's rule: reviews (with or without comments) are never collapsed or hidden.
            expect(hasClassUp(item.el, COLLAPSED_CLASS), `${item.nodeId} collapsed`).toBe(false);
            expect(hasClassUp(item.el, HIDDEN_EVENT_CLASS), `${item.nodeId} hidden`).toBe(false);
          }
          for (const row of item.rows()) {
            if (!hasClassUp(row.el, HIDDEN_EVENT_CLASS)) continue;
            expect(['event', 'commit'], `${item.nodeId} row`).toContain(row.kind);
            expect(row.body()).toBeNull();
          }
        }
      });

      it('restores the page byte-for-byte after unmount', async () => {
        const { handles, snapshot } = await mountAll(name, hideEvents);
        expect(document.documentElement.outerHTML).not.toBe(snapshot);
        for (const h of handles) h.abort();
        expect(document.documentElement.outerHTML).toBe(snapshot);
      });
    });
  }
});
