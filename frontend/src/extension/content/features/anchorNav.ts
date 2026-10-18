/**
 * Anchor navigation repair (mutator; requires the timeline scope): makes permalinks such as
 * #issuecomment-N, #discussion_rN and #pullrequestreview-N work when the target is hidden
 * (docs/internal/extension_dom_engine_design.md section 9.5; decisions 3, 4 and 17).
 *
 * GitHub hides the middle of long timelines behind "Load more", collapses resolved threads, and
 * on React-shell pages its own anchor loader runs before the Rails conversation exists. When the
 * target is missing, this feature shows a banner toast and tries, in order:
 *   1. opening the collapsed container GitHub says holds the comment,
 *   2. GitHub's own focused anchor loader (classic: one synthetic hashchange; one request),
 *   3. bounded "Load more" batches through timeline.loadUntil (shared mutex with expandAll),
 * then scrolls to the target and highlights it. Present targets that are already on screen are
 * left alone; present but off-screen ones are scrolled to (GitHub's fragment scroll can run before
 * a late-inserted partial exists, and router hash links never scroll), except on the initial
 * settle when the page has already been scrolled. Present-but-hidden targets (collapsed by GitHub
 * or by OctoDeck) are revealed and scrolled to without a toast. Variants with no loader get no
 * toast at all: only a quiet attempt with GitHub's focused loader.
 */
import { parseAnchor, type ParsedAnchor } from '../capabilities/anchorKinds';
import type { TimelineCap, ToastHandle } from '../capabilities/types';
import type { Feature, FeatureContext, FeatureRegistration } from '../engine/types';

/** How long to wait for a target after opening its collapsed container or nudging GitHub. */
export const ANCHOR_WAIT_MS = 5000;
export const ANCHOR_MAX_BATCHES = 50;
export const ANCHOR_BATCH_TIMEOUT_MS = 15000;
export const ANCHOR_INTER_BATCH_DELAY_MS = 400;
/** How long the "not found" toast stays up. */
export const ANCHOR_NOT_FOUND_TOAST_MS = 5000;

/** User-facing copy (decision 4). */
export const ANCHOR_TOAST_LOADING = 'Loading hidden comments to find the linked comment…';
/** Neutral on purpose: the target may be deleted, or on another tab of the PR. */
export const ANCHOR_TOAST_NOT_FOUND = 'Couldn’t find the linked comment on this page.';

type Found = NonNullable<ReturnType<TimelineCap['findByAnchor']>>;

/** Whether the element currently renders (not inside display:none / a closed container). */
function isRendered(el: Element): boolean {
  return el.isConnected && el.getClientRects().length > 0;
}

/** Whether any part of the element is inside the viewport. */
function isOnScreen(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < (window.innerHeight || 0) && rect.height > 0;
}

function createAnchorNav(): Feature {
  return {
    id: 'anchorNav',
    kind: 'mutator',
    pages: ['issue', 'pr-conversation'],
    requires: ['timeline'],
    after: ['noiseCollapser', 'expandAll'],
    mount(ctx: FeatureContext) {
      const timeline = ctx.caps.timeline;
      const nav = ctx.caps.navigation;
      if (!timeline) {
        ctx.setStatus({ health: 'notApplicable', detail: 'no-timeline' });
        return;
      }

      // One DOM-change fan-out for whichever repair is currently waiting for its target.
      const waiters = new Set<() => void>();
      let userScrolled = false;
      const poke = ctx.guard(() => {
        for (const w of Array.from(waiters)) w();
      });
      ctx.onScopeChange('timeline', poke);
      timeline.onItemsAdded(poke, ctx.signal);

      /** Resolves with the target once findByAnchor sees it, or null after `ms` / on abort. */
      const waitForTarget = (hash: string, ms: number, signal: AbortSignal): Promise<Found | null> =>
        new Promise((resolve) => {
          const immediate = timeline.findByAnchor(hash);
          if (immediate || signal.aborted) {
            resolve(immediate);
            return;
          }
          let cancelTimer: () => void = () => {};
          const done = (v: Found | null) => {
            waiters.delete(check);
            cancelTimer();
            signal.removeEventListener('abort', onAbort);
            resolve(v);
          };
          const check = () => {
            const f = timeline.findByAnchor(hash);
            if (f) done(f);
          };
          const onAbort = () => done(null);
          waiters.add(check);
          signal.addEventListener('abort', onAbort, { once: true });
          cancelTimer = ctx.setTimer(() => done(null), ms);
        });

      const show = async (found: Found, signal: AbortSignal) => {
        // Anything OctoDeck itself collapsed is expanded synchronously by its owner.
        ctx.bus.emit('reveal:request', { target: found.target });
        await timeline.reveal(found.target, { signal });
        if (signal.aborted) return;
        nav.scrollToAndHighlight(found.target, { signal: ctx.signal });
      };

      const tryCollapsed = async (anchor: ParsedAnchor, signal: AbortSignal): Promise<Found | null> => {
        if (!anchor.isComment) return null;
        const seg = timeline.hidden().find((h) => h.containsCommentIds?.includes(anchor.id));
        if (!seg) return null;
        const opened = await timeline.reveal(seg, { signal });
        if (!opened || signal.aborted) return null;
        return waitForTarget(anchor.hash, ANCHOR_WAIT_MS, signal);
      };

      const loadingInProgress = () => {
        const last = ctx.bus.last('timeline:loading');
        return last !== undefined && last.phase !== 'end';
      };

      const repair = async (hash: string, signal: AbortSignal, initial: boolean) => {
        const anchor = parseAnchor(hash);
        if (!anchor) return;

        const present = timeline.findByAnchor(anchor.hash);
        if (present) {
          if (!isRendered(present.target)) {
            await show(present, signal);
          } else if (!isOnScreen(present.target) && !(initial && (userScrolled || window.scrollY > 0))) {
            // On React-shell pages the target can appear after the browser's fragment scroll, and
            // router hash links (pushState) never scroll; bring it into view unless the page has
            // already been moved (by the user) before we settled.
            nav.scrollToAndHighlight(present.target, { signal: ctx.signal });
          }
          return;
        }

        // Without any way to load hidden content, don't claim to be loading or that the comment
        // is gone; just try GitHub's own focused loader quietly.
        const collapsedHolder = anchor.isComment && timeline.hidden().some((h) => h.containsCommentIds?.includes(anchor.id));
        if (!timeline.supportsLoadMore() && !collapsedHolder) {
          if (!loadingInProgress() && (await timeline.focusedLoad(anchor.hash, { signal }))) {
            const found = timeline.findByAnchor(anchor.hash);
            if (found && !signal.aborted) {
              await show(found, signal);
              return;
            }
          }
          if (!signal.aborted) {
            ctx.report({ code: 'ANCHOR_NOT_FOUND', severity: 'info', scope: 'timeline', message: `${anchor.kind}:no-loader` });
          }
          return;
        }

        let toast: ToastHandle | null = nav.showToast(ANCHOR_TOAST_LOADING, { signal });
        try {
          let found = await tryCollapsed(anchor, signal);

          // GitHub's own focused loader fetches just the one item. Skip it while a load-more run
          // is active, since it replaces the same hidden-range container.
          if (!found && !signal.aborted && !loadingInProgress()) {
            if (await timeline.focusedLoad(anchor.hash, { signal })) found = timeline.findByAnchor(anchor.hash);
          }

          if (!found && !signal.aborted && timeline.supportsLoadMore()) {
            await timeline.loadUntil(() => timeline.findByAnchor(anchor.hash) !== null, {
              signal,
              kinds: ['range', 'hiddenComments'],
              maxBatches: ANCHOR_MAX_BATCHES,
              batchTimeoutMs: ANCHOR_BATCH_TIMEOUT_MS,
              interBatchDelayMs: ANCHOR_INTER_BATCH_DELAY_MS,
            });
            found = timeline.findByAnchor(anchor.hash) ?? (signal.aborted ? null : await tryCollapsed(anchor, signal));
          }
          if (signal.aborted) return;

          if (found) {
            toast.dismiss();
            toast = null;
            await show(found, signal);
            ctx.setStatus({ health: 'ok', detail: 'repaired' });
            return;
          }

          ctx.report({ code: 'ANCHOR_NOT_FOUND', severity: 'info', scope: 'timeline', message: anchor.kind });
          toast.update(ANCHOR_TOAST_NOT_FOUND);
          const t = toast;
          toast = null;
          ctx.setTimer(() => t.dismiss(), ANCHOR_NOT_FOUND_TOAST_MS);
        } finally {
          // Aborted or failed mid-way: never leave the loading toast behind.
          toast?.dismiss();
        }
      };

      let current: AbortController | null = null;
      const start = ctx.guard(async (hash: string, initial: boolean) => {
        current?.abort(); // a newer hash supersedes an in-flight repair
        const controller = new AbortController();
        current = controller;
        const onSessionAbort = () => controller.abort();
        ctx.signal.addEventListener('abort', onSessionAbort, { once: true });
        try {
          await repair(hash, controller.signal, initial);
        } finally {
          ctx.signal.removeEventListener('abort', onSessionAbort);
          if (current === controller) current = null;
        }
      });

      // User-initiated scrolling (not the browser's own fragment scroll) since the page loaded.
      const markScrolled = () => (userScrolled = true);
      for (const type of ['wheel', 'touchmove', 'keydown'] as const) {
        window.addEventListener(type, markScrolled, { passive: true, signal: ctx.signal });
      }

      nav.onHash((hash) => start(hash, false), ctx.signal);
      ctx.setStatus({ health: 'ok' });
      const initial = nav.hash();
      if (initial) start(initial, true);
    },
  };
}

export const anchorNavFeature: FeatureRegistration = { id: 'anchorNav', create: createAnchorNav };
