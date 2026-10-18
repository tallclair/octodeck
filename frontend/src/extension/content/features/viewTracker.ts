/**
 * View tracker (observer): records that the user actually looked at the current issue/PR
 * (docs/internal/extension_dom_engine_design.md section 8, decision 18).
 *
 * A view is recorded only after the tab has been visible AND focused for VIEW_DWELL_MS without
 * interruption. A background or restored tab that is later brought to the front and kept there
 * counts at that point. This keeps tabs opened in the background (middle-click, session restore,
 * prerender) from marking items as read in the dashboard. After a view is recorded, losing
 * attention (tab hidden or window blurred) re-arms the tracker, so returning to a long-lived tab
 * records a fresh view (at most once per VIEW_REVISIT_MIN_MS).
 */
import type { Feature, FeatureContext, FeatureRegistration } from '../engine/types';

/** How long the tab must stay visible and focused before a view is recorded. */
export const VIEW_DWELL_MS = 3000;

/** Minimum gap between two recorded views of the same item (e.g. Conversation -> Files tab). */
export const VIEW_THROTTLE_MS = 3000;

/** Minimum gap before a revisit of the same open tab (attention lost, then regained) counts again. */
export const VIEW_REVISIT_MIN_MS = 60_000;

// Survives page sessions on purpose: a sub-route change starts a new session for the same item.
let lastRecorded: { itemId: string; at: number } | null = null;

/** Test hook: forget the cross-session throttle. */
export function resetViewTrackerForTest(): void {
  lastRecorded = null;
}

function isAttended(doc: Document): boolean {
  const prerendering = (doc as Document & { prerendering?: boolean }).prerendering === true;
  return !prerendering && doc.visibilityState === 'visible' && doc.hasFocus();
}

function createViewTracker(): Feature {
  return {
    id: 'viewTracker',
    kind: 'observer',
    pages: ['issue', 'pr-conversation', 'pr-subtab'],
    requires: [],
    mount(ctx: FeatureContext) {
      const item = ctx.session.facts.item;
      if (!item) {
        ctx.setStatus({ health: 'notApplicable', detail: 'no-item' });
        return;
      }
      const doc = document;
      const win = window;
      let cancelDwell: (() => void) | null = null;
      // Armed until a view is recorded; re-armed once attention is lost (tab hidden or blurred),
      // so coming back to a long-lived tab later records a fresh view.
      let armed = true;
      let recordedThisSession = false;

      const record = ctx.guard(async () => {
        armed = false;
        const now = Date.now();
        // First view in a session: short throttle (sub-route changes). Revisits: longer throttle.
        const minGap = recordedThisSession ? VIEW_REVISIT_MIN_MS : VIEW_THROTTLE_MS;
        recordedThisSession = true;
        if (lastRecorded && lastRecorded.itemId === item.itemId && now - lastRecorded.at < minGap) {
          ctx.setStatus({ health: 'ok', detail: 'throttled' });
          return;
        }
        lastRecorded = { itemId: item.itemId, at: now };
        const res = await ctx.send({ type: 'VIEW_ITEM', itemId: item.itemId });
        ctx.setStatus(res.ok ? { health: 'ok' } : { health: 'ok', detail: 'daemon-unavailable' });
      });

      const evaluate = ctx.guard(() => {
        if (isAttended(doc)) {
          if (armed && !cancelDwell) {
            cancelDwell = ctx.setTimer(() => {
              cancelDwell = null;
              if (isAttended(doc)) record();
              else evaluate();
            }, VIEW_DWELL_MS);
          }
          return;
        }
        armed = true;
        if (cancelDwell) {
          cancelDwell();
          cancelDwell = null;
        }
      });

      const opts = { signal: ctx.signal };
      doc.addEventListener('visibilitychange', evaluate, opts);
      doc.addEventListener('prerenderingchange', evaluate, opts);
      win.addEventListener('focus', evaluate, opts);
      win.addEventListener('blur', evaluate, opts);
      ctx.setStatus({ health: 'ok', detail: 'waiting-for-attention' });
      evaluate();
    },
  };
}

export const viewTrackerFeature: FeatureRegistration = { id: 'viewTracker', create: createViewTracker };
