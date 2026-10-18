/**
 * Expand all (mutator; requires the timeline scope): loads every comment GitHub hides behind the
 * timeline's "Load more" control, on the user's command
 * (docs/internal/extension_dom_engine_design.md section 9.4; decisions 1, 2 and 16).
 *
 * The feature owns no UI. It publishes availability and progress as 'expand:state' and obeys
 * 'expand:command' {start|stop|continue}; sidebarWidget renders the control. All loading goes
 * through timeline.loadUntil, which clicks GitHub's own control in bounded, polite batches and
 * shares a per-session mutex with anchorNav. Resolved/outdated review threads are left collapsed
 * (decision 16): only 'range' segments are loaded.
 */
import type { HiddenItemsInfo, LoadResult, TimelineCap } from '../capabilities/types';
import type { BusEvents, Feature, FeatureContext, FeatureRegistration } from '../engine/types';

/** Batches per run before the control offers "Continue" (decision 2). */
export const EXPAND_MAX_BATCHES = 25;
/** Pause between batches, for GitHub's secondary rate limits (decision 2). */
export const EXPAND_INTER_BATCH_DELAY_MS = 400;
export const EXPAND_BATCH_TIMEOUT_MS = 15000;

/** expand:state.error values (sidebarWidget maps them to user-facing text). */
export const EXPAND_ERROR_LOAD_FAILED = 'load-failed';

type ExpandState = BusEvents['expand:state'];

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
        ctx.bus.emit('expand:state', { available: false, count: null, running: false, bounded: false });
        ctx.setStatus({ health: 'notApplicable', detail: timeline ? 'unsupported-variant' : 'no-timeline' });
        return;
      }

      let run: AbortController | null = null;
      let bounded = false;
      let error: string | undefined;

      const publish = (overrides: Partial<ExpandState> = {}) => {
        const ranges = rangesOf(timeline);
        const state: ExpandState = {
          available: ranges.length > 0,
          count: countOf(ranges),
          running: run !== null,
          bounded: bounded && ranges.length > 0,
          ...(error ? { error } : {}),
          ...overrides,
        };
        ctx.bus.emit('expand:state', state);
      };

      const start = ctx.guard(async () => {
        if (run) return; // already running
        if (rangesOf(timeline).length === 0) {
          publish();
          return;
        }
        const controller = new AbortController();
        const onSessionAbort = () => controller.abort();
        ctx.signal.addEventListener('abort', onSessionAbort, { once: true });
        run = controller;
        bounded = false;
        error = undefined;
        publish();

        let result: LoadResult;
        try {
          result = await timeline.loadUntil(() => false, {
            signal: controller.signal,
            kinds: ['range'],
            maxBatches: EXPAND_MAX_BATCHES,
            batchTimeoutMs: EXPAND_BATCH_TIMEOUT_MS,
            interBatchDelayMs: EXPAND_INTER_BATCH_DELAY_MS,
            onProgress: (p) => publish({ count: p.remaining }),
          });
        } finally {
          ctx.signal.removeEventListener('abort', onSessionAbort);
          run = null;
        }
        if (ctx.signal.aborted) return;

        switch (result.status) {
          case 'loaded':
            // The predicate never succeeds, so 'loaded' means the batch cap was reached.
            bounded = true;
            ctx.setStatus({ health: 'ok' });
            break;
          case 'exhausted':
          case 'aborted':
            ctx.setStatus({ health: 'ok' });
            break;
          case 'failed':
          case 'timeout':
          case 'noProgress':
            error = EXPAND_ERROR_LOAD_FAILED;
            ctx.setStatus({ health: 'degraded', detail: `load-${result.status}` });
            break;
        }
        publish();
      });

      ctx.bus.on('expand:command', ({ action }) => {
        if (action === 'stop') {
          run?.abort();
          return;
        }
        start();
      });

      // GitHub (or another feature) may change what is hidden: refresh availability.
      const refresh = ctx.guard(() => {
        if (!run) publish();
      });
      timeline.onItemsAdded(refresh, ctx.signal);
      ctx.onScopeChange('timeline', refresh);

      ctx.setStatus({ health: 'ok' });
      publish();
    },
  };
}

export const expandAllFeature: FeatureRegistration = { id: 'expandAll', create: createExpandAll };
