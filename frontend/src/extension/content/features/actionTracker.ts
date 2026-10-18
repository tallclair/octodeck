/**
 * Action tracker (observer): when the user does something on GitHub that changes the current
 * issue/PR (comment, review, merge, close/reopen, sidebar edits), ask the daemon to refetch it so
 * the dashboard catches up quickly (docs/internal/extension_dom_engine_design.md section 8).
 *
 * Classification lives in the actions capability (variant adapters); this feature only listens
 * and schedules: a primary refetch ~1s after the action and a fallback ~3.5s after it, debounced
 * per item. The fallback is skipped when the primary refetch succeeded.
 *
 * Known limitation: timers are bound to the page session, so if the user navigates to another
 * item within ~1s of acting, the pending refetch is dropped (ctx.send is inert after abort). The
 * daemon's regular polling catches up.
 */
import type { GitHubActionType } from '../capabilities/types';
import type { Feature, FeatureContext, FeatureRegistration } from '../engine/types';

export const ACTION_SYNC_DELAY_MS = 1000;
export const ACTION_FALLBACK_EXTRA_MS = 2500;

/** User events that can start a GitHub write. Capture phase, so stopPropagation can't hide them. */
const EVENT_TYPES = ['submit', 'click', 'keydown', 'change'] as const;

function createActionTracker(): Feature {
  return {
    id: 'actionTracker',
    kind: 'observer',
    pages: ['issue', 'pr-conversation', 'pr-subtab'],
    requires: [],
    mount(ctx: FeatureContext) {
      const item = ctx.session.facts.item;
      if (!item) {
        ctx.setStatus({ health: 'notApplicable', detail: 'no-item' });
        return;
      }
      const itemId = item.itemId;
      let cancelPrimary: (() => void) | null = null;
      let cancelFallback: (() => void) | null = null;
      let scheduleGen = 0;

      const refetch = async (actionType: GitHubActionType, isFallback: boolean, gen: number) => {
        const res = await ctx.send({ type: 'REFETCH_ITEM', itemId });
        if (!isFallback && res.ok && gen === scheduleGen && cancelFallback) {
          // The primary refetch confirmed; the fallback would only repeat it.
          cancelFallback();
          cancelFallback = null;
        }
        ctx.setStatus({ health: 'ok', detail: `synced:${actionType}${isFallback ? ':fallback' : ''}` });
      };

      const schedule = (actionType: GitHubActionType) => {
        cancelPrimary?.();
        cancelFallback?.();
        const gen = ++scheduleGen;
        cancelPrimary = ctx.setTimer(() => {
          cancelPrimary = null;
          void refetch(actionType, false, gen);
        }, ACTION_SYNC_DELAY_MS);
        cancelFallback = ctx.setTimer(() => {
          cancelFallback = null;
          void refetch(actionType, true, gen);
        }, ACTION_SYNC_DELAY_MS + ACTION_FALLBACK_EXTRA_MS);
      };

      const onEvent = ctx.guard((event: Event) => {
        const actionType = ctx.caps.actions.classify(event);
        if (actionType) schedule(actionType);
      });

      for (const type of EVENT_TYPES) {
        document.addEventListener(type, onEvent, { capture: true, signal: ctx.signal });
      }
      ctx.setStatus({ health: 'ok' });
    },
  };
}

export const actionTrackerFeature: FeatureRegistration = { id: 'actionTracker', create: createActionTracker };
