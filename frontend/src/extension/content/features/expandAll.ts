/**
 * Expand all (mutator; requires the timeline scope): loads every comment GitHub hides behind the
 * timeline's "Load more" control, on the user's command
 * (docs/internal/extension_dom_engine_design.md section 9.4; decisions 1, 2 and 16).
 *
 * UI: a "Load all" button rendered next to each of GitHub's own "Load more" controls
 * (timeline.loadMoreControls()), re-rendered whenever the timeline changes, and absent when nothing
 * is hidden or the variant's loader is not verified. While a run is active the inline buttons are
 * withdrawn and a banner toast (navigation.showToast) shows progress with a Cancel button. Focus
 * follows a keyboard activation into the toast's Cancel button, and returns to the re-rendered
 * inline button when the run ends (unless the user has moved focus elsewhere meanwhile).
 *
 * All loading goes through timeline.loadUntil, which clicks GitHub's own control in bounded,
 * polite batches and shares a per-session mutex with anchorNav. Resolved/outdated review threads
 * are left collapsed (decision 16): only 'range' segments are loaded. When the batch cap is
 * reached the inline button offers to continue.
 */
import type { HiddenItemsInfo, LoadResult, TimelineCap, ToastHandle } from '../capabilities/types';
import { OWN_ATTR } from '../engine/constants';
import type { Feature, FeatureContext, FeatureRegistration } from '../engine/types';

/** Batches per run before the control offers to continue (decision 2). */
export const EXPAND_MAX_BATCHES = 25;
/** Pause between batches, for GitHub's secondary rate limits (decision 2). */
export const EXPAND_INTER_BATCH_DELAY_MS = 400;
export const EXPAND_BATCH_TIMEOUT_MS = 15000;
/** How long the result toast stays up after a run ends (cancelled runs show none). */
export const EXPAND_RESULT_TOAST_MS = 4000;

/** Class of the inline button; styled in styles/expandAll.css. */
export const LOAD_ALL_CLASS = 'octodeck-gh-load-all';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** User-facing strings (exported for tests). */
export const EXPAND_TEXT = {
  start: 'Load all',
  continue: 'Continue loading all',
  title: 'OctoDeck: load every hidden item, in polite batches',
  cancel: 'Cancel',
  starting: (count: number | null) =>
    count !== null && count > 0 ? `Loading ${plural(count, 'hidden item', 'hidden items')}…` : 'Loading hidden items…',
  progress: (p: { added: number; remaining: number | null }) =>
    p.remaining !== null
      ? `Loading hidden items… ${p.remaining} remaining`
      : `Loading hidden items… ${plural(p.added, 'item', 'items')} loaded`,
  done: (added: number) => `Loaded ${plural(added, 'hidden item', 'hidden items')}`,
  bounded: (added: number) => `Loaded ${plural(added, 'item', 'items')}; more remain. Choose "Continue loading all" to keep going.`,
  failed: "Couldn't load more hidden items",
} as const;

function rangesOf(timeline: TimelineCap): HiddenItemsInfo[] {
  return timeline.hidden().filter((h) => h.kind === 'range');
}

function countOf(ranges: readonly HiddenItemsInfo[]): number | null {
  let total = 0;
  for (const r of ranges) {
    if (r.count === null) return null;
    total += r.count;
  }
  return total;
}

function createExpandAll(): Feature {
  return {
    id: 'expandAll',
    kind: 'mutator',
    pages: ['issue', 'pr-conversation'],
    requires: ['timeline'],
    mount(ctx: FeatureContext) {
      const timeline = ctx.caps.timeline;
      if (!timeline || !timeline.supportsLoadMore()) {
        ctx.setStatus({ health: 'notApplicable', detail: timeline ? 'unsupported-variant' : 'no-timeline' });
        return;
      }
      const navigation = ctx.caps.navigation;

      let run: AbortController | null = null;
      let bounded = false;
      let resultToast: ToastHandle | null = null;
      let cancelResultTimer: (() => void) | null = null;

      // One own button per range segment. A segment GitHub replaces is a new element and gets a new
      // button (and key), so ordinary loads never count against the ledger's re-inject budget;
      // re-inserting a button someone removed from a still-present segment does.
      const buttons = new Map<Element, HTMLButtonElement>();
      let keySeq = 0;

      // Keyboard users must not be dropped onto <body> when the inline button is withdrawn or the
      // toast goes away. Focus counts as "ours" when it is on a node this feature created through
      // its ledger (inline buttons, the toast's Cancel) or has already fallen back to the body
      // (a focused node was removed).
      const focusIsOurs = () => {
        const active = document.activeElement;
        return !active || active === document.body || active.getAttribute(OWN_ATTR) === ctx.id;
      };
      // preventScroll: the user may have scrolled into the loaded content; never jump back.
      const focusFirstButton = () => {
        for (const btn of Array.from(buttons.values())) {
          if (btn.isConnected) {
            btn.focus({ preventScroll: true });
            return;
          }
        }
      };

      const clearResult = () => {
        cancelResultTimer?.();
        cancelResultTimer = null;
        resultToast?.dismiss();
        resultToast = null;
      };

      const showResult = (text: string) => {
        clearResult();
        const toast = navigation.showToast(text, { signal: ctx.signal, ledger: ctx.ledger });
        resultToast = toast;
        cancelResultTimer = ctx.setTimer(() => {
          toast.dismiss();
          if (resultToast === toast) resultToast = null;
        }, EXPAND_RESULT_TOAST_MS);
      };

      const render = () => {
        // Withdrawn while running: GitHub replaces the controls batch by batch and the toast owns Cancel.
        const controls = run ? [] : timeline.loadMoreControls();
        const live = new Set<Element>();
        for (const { hidden, insertionPoint } of controls) {
          live.add(hidden.segment);
          let btn = buttons.get(hidden.segment);
          if (!btn) {
            btn = ctx.ledger.create('button', `load-all-${++keySeq}`);
            btn.type = 'button';
            btn.className = LOAD_ALL_CLASS;
            btn.title = EXPAND_TEXT.title;
            btn.addEventListener('click', (event) => {
              event.preventDefault();
              start(document.activeElement === event.currentTarget);
            });
            buttons.set(hidden.segment, btn);
          }
          btn.textContent = bounded ? EXPAND_TEXT.continue : EXPAND_TEXT.start;
          if (!btn.isConnected) ctx.ledger.insert(btn, insertionPoint);
        }
        for (const [segment, btn] of Array.from(buttons)) {
          if (live.has(segment)) continue;
          if (btn.isConnected) ctx.ledger.remove(btn);
          buttons.delete(segment);
        }
      };

      /** `fromFocus`: the user activated a focused inline button, so focus follows into the toast. */
      const start = ctx.guard(async (fromFocus: boolean) => {
        if (run) return; // already running
        const ranges = rangesOf(timeline);
        if (ranges.length === 0) {
          render();
          return;
        }
        const controller = new AbortController();
        const onSessionAbort = () => controller.abort();
        ctx.signal.addEventListener('abort', onSessionAbort, { once: true });
        run = controller;
        bounded = false;
        clearResult();
        render();
        // The toast follows the run's signal, so Cancel (or session end) removes it at once.
        const toast = navigation.showToast(EXPAND_TEXT.starting(countOf(ranges)), {
          signal: controller.signal,
          ledger: ctx.ledger,
          action: { label: EXPAND_TEXT.cancel, onClick: ctx.guard(() => controller.abort()) },
        });
        if (fromFocus) toast.focusAction();

        let result: LoadResult | null = null;
        let restoreFocus = false;
        try {
          result = await timeline.loadUntil(() => false, {
            signal: controller.signal,
            kinds: ['range'],
            maxBatches: EXPAND_MAX_BATCHES,
            batchTimeoutMs: EXPAND_BATCH_TIMEOUT_MS,
            interBatchDelayMs: EXPAND_INTER_BATCH_DELAY_MS,
            onProgress: (p) => toast.update(EXPAND_TEXT.progress(p)),
          });
        } finally {
          ctx.signal.removeEventListener('abort', onSessionAbort);
          run = null;
          // Only a run that took focus gives it back.
          restoreFocus = fromFocus && focusIsOurs();
          toast.dismiss();
          // On an exception (reported by the guard) still bring the inline control back.
          if (!result) {
            render();
            if (restoreFocus) focusFirstButton();
          }
        }
        if (ctx.signal.aborted) return;

        switch (result.status) {
          case 'loaded':
            // The predicate never succeeds, so 'loaded' means the batch cap was reached.
            bounded = true;
            ctx.setStatus({ health: 'ok' });
            showResult(EXPAND_TEXT.bounded(result.added));
            break;
          case 'exhausted':
            ctx.setStatus({ health: 'ok' });
            showResult(EXPAND_TEXT.done(result.added));
            break;
          case 'aborted':
            ctx.setStatus({ health: 'ok' });
            break;
          case 'failed':
          case 'timeout':
          case 'noProgress':
            ctx.setStatus({ health: 'degraded', detail: `load-${result.status}` });
            showResult(EXPAND_TEXT.failed);
            break;
        }
        render();
        if (restoreFocus) focusFirstButton();
      });

      // GitHub (or another feature's load) adds, replaces and removes ranges: follow them.
      const refresh = ctx.guard(() => {
        if (!run) render();
      });
      timeline.onItemsAdded(refresh, ctx.signal);
      ctx.onScopeChange('timeline', refresh);

      ctx.setStatus({ health: 'ok' });
      render();
    },
  };
}

export const expandAllFeature: FeatureRegistration = { id: 'expandAll', create: createExpandAll };
