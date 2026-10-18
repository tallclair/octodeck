/**
 * Shared bounded loader for GitHub's progressive timeline
 * (docs/internal/extension_dom_engine_design.md section 9.3).
 *
 * expandAll and anchorNav both load hidden timeline content through this one primitive, so they
 * can never click GitHub's controls concurrently (a per-session mutex) and both get the same
 * politeness rules: strictly sequential batches, a delay between batches, a hard batch cap, a stop
 * at the first non-success, and no work while the tab is hidden or the user is typing.
 *
 * The loader never touches GitHub's DOM itself; the variant's TimelineLoadAdapter clicks GitHub's
 * own controls. This module only sequences, measures progress (by item node id), keeps the
 * reader's scroll position and focus stable, and announces progress on the bus.
 */
import type { Diagnostic } from '../../types';
import type { EventBus } from '../engine/types';
import type { TimelineLoadAdapter } from '../variants/types';
import type { HiddenItemsInfo, HiddenKind, LoadResult, LoadUntilOptions, TimelineCap, TimelineItem } from './types';

/** What the loader needs from the timeline capability that owns it. */
export interface LoadUntilDeps {
  /** Current whole items, in document order. */
  items: () => readonly TimelineItem[];
  /** Current hidden-content places (all kinds); the loader filters by the run's kinds. */
  hidden: () => readonly HiddenItemsInfo[];
  adapter: TimelineLoadAdapter;
  /** When given, the loader emits 'timeline:loading' and 'timeline:changed' (reason 'loadMore'). */
  bus?: EventBus;
  doc: Document;
  /** Diagnostics sink (LOADMORE_FAILED / LOADMORE_NO_PROGRESS). */
  report?: (d: Diagnostic) => void;
}

const DEFAULT_KINDS: readonly HiddenKind[] = ['range'];

/** How often we re-check whether the user has stopped typing. */
const TYPING_POLL_MS = 1000;

const ANCHOR_FOR_KIND: Record<HiddenKind, NonNullable<Diagnostic['anchor']>> = {
  range: 'timeline.hiddenRange',
  collapsedThread: 'timeline.collapsedThread',
  hiddenComments: 'timeline.hiddenComments',
};

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/** Abortable delay; rejects with AbortError when the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolves once the document is visible (immediately when it already is). */
function whenVisible(doc: Document, signal: AbortSignal): Promise<void> {
  if (!doc.hidden) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      doc.removeEventListener('visibilitychange', onChange);
      reject(abortError());
    };
    const onChange = () => {
      if (doc.hidden) return;
      doc.removeEventListener('visibilitychange', onChange);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    doc.addEventListener('visibilitychange', onChange);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'hidden', 'image', 'file', 'range', 'color']);

/** True while focus is in an editable field, so loading could disturb what the user is typing. */
export function isUserTyping(doc: Document): boolean {
  const el = doc.activeElement;
  if (!el || el === doc.body) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(el.type);
  if (!(el instanceof HTMLElement)) return false;
  // isContentEditable is the precise check; the attribute walk covers environments without it.
  return el.isContentEditable === true || el.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/** First item whose box intersects the viewport, with its current top offset. */
function viewportAnchor(items: readonly TimelineItem[], win: Window): { el: Element; top: number } | null {
  const height = win.innerHeight || 0;
  for (const { el } of items) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < height) return { el, top: rect.top };
  }
  return null;
}

interface Mutex {
  acquire(signal: AbortSignal): Promise<() => void>;
}

/** A FIFO mutex: expand-all and anchor-nav share one per session. */
function createMutex(): Mutex {
  let tail: Promise<void> = Promise.resolve();
  return {
    async acquire(signal) {
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      const prev = tail;
      tail = prev.then(() => mine);
      let onAbort: () => void = () => {};
      try {
        await Promise.race([
          prev,
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(abortError());
            onAbort = () => reject(abortError());
            signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      } catch (e) {
        // Give up our place without blocking later waiters.
        release();
        throw e;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
      };
    },
  };
}

function sumCounts(hidden: readonly HiddenItemsInfo[]): number | null {
  if (hidden.length === 0) return 0;
  let total = 0;
  for (const h of hidden) {
    if (h.count === null) return null;
    total += h.count;
  }
  return total;
}

/**
 * Builds the loader for one TimelineCap. The mutex lives inside, so build exactly one per
 * session's timeline capability.
 */
export function createLoadUntil(deps: LoadUntilDeps): TimelineCap['loadUntil'] {
  const mutex = createMutex();
  const { doc, adapter, bus } = deps;
  const win = doc.defaultView ?? window;

  const hiddenOf = (kinds: readonly HiddenKind[]) => deps.hidden().filter((h) => kinds.includes(h.kind));

  const report = (kind: HiddenKind, message: string, code: 'LOADMORE_FAILED' | 'LOADMORE_NO_PROGRESS') => {
    deps.report?.({ code, severity: 'warn', scope: 'timeline', anchor: ANCHOR_FOR_KIND[kind], message });
  };

  async function loop(
    pred: () => boolean,
    opts: LoadUntilOptions,
    progress: { batches: number; added: number }
  ): Promise<LoadResult['status']> {
    const { signal } = opts;
    const kinds = opts.kinds ?? DEFAULT_KINDS;

    for (;;) {
      if (signal.aborted) return 'aborted';
      if (pred()) return 'loaded';

      await whenVisible(doc, signal);
      while (isUserTyping(doc)) await delay(TYPING_POLL_MS, signal);
      if (pred()) return 'loaded';

      const seg = hiddenOf(kinds)[0];
      if (!seg) return 'exhausted';

      const before = new Set(deps.items());
      const anchor = viewportAnchor(deps.items(), win);
      const focused = doc.activeElement;

      const outcome = await adapter.loadOne(seg, { signal, timeoutMs: opts.batchTimeoutMs });

      // Keep what the reader was looking at in place: GitHub inserts the batch around it.
      if (anchor && anchor.el.isConnected) {
        const drift = anchor.el.getBoundingClientRect().top - anchor.top;
        if (Math.abs(drift) >= 1) win.scrollBy(0, drift);
      }
      if (focused instanceof HTMLElement && focused.isConnected && doc.activeElement !== focused) {
        focused.focus({ preventScroll: true });
      }

      if (outcome === 'aborted' || signal.aborted) return 'aborted';
      if (outcome === 'failed' || outcome === 'timeout') {
        report(seg.kind, `loadOne:${outcome}`, 'LOADMORE_FAILED');
        return outcome;
      }

      // Items are compared by identity of the capability's item objects keyed on their element.
      const beforeEls = new Set(Array.from(before, (i) => i.el));
      const added = deps.items().filter((i) => !beforeEls.has(i.el));

      if (outcome === 'ended' && added.length === 0) {
        // GitHub removed the control without adding items (e.g. HTTP 404). If the same control is
        // still offered, we'd loop; otherwise move on to any remaining segment.
        if (hiddenOf(kinds).some((h) => h.segment === seg.segment)) {
          report(seg.kind, 'ended-but-control-remains', 'LOADMORE_NO_PROGRESS');
          return 'noProgress';
        }
        continue;
      }
      // Collapsed threads and hidden-comment loaders reveal comments inside existing items, so
      // "no new items" is a stall signal only for ranges.
      if (added.length === 0 && seg.kind === 'range') {
        report(seg.kind, 'loaded-without-new-items', 'LOADMORE_NO_PROGRESS');
        return 'noProgress';
      }

      progress.batches++;
      progress.added += added.length;
      const remaining = sumCounts(hiddenOf(kinds));
      if (added.length > 0) bus?.emit('timeline:changed', { added, reason: 'loadMore' });
      bus?.emit('timeline:loading', { phase: 'batch', loaded: progress.added, remaining });
      opts.onProgress?.({ ...progress, remaining });

      if (pred()) return 'loaded';
      if (progress.batches >= opts.maxBatches) return 'loaded';
      await delay(opts.interBatchDelayMs, signal);
    }
  }

  return async (pred, opts) => {
    const progress = { batches: 0, added: 0 };
    let release: () => void;
    try {
      release = await mutex.acquire(opts.signal);
    } catch {
      return { status: 'aborted', ...progress };
    }
    bus?.emit('timeline:loading', { phase: 'start', loaded: 0, remaining: sumCounts(hiddenOf(opts.kinds ?? DEFAULT_KINDS)) });
    let status: LoadResult['status'] = 'aborted';
    let error: string | undefined;
    try {
      status = await loop(pred, opts, progress);
    } catch (e) {
      if (!isAbortError(e)) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      }
      status = 'aborted';
    } finally {
      release();
      const failed = status === 'failed' || status === 'timeout' || status === 'noProgress';
      bus?.emit('timeline:loading', {
        phase: 'end',
        loaded: progress.added,
        remaining: sumCounts(hiddenOf(opts.kinds ?? DEFAULT_KINDS)),
        ...(error ? { error } : failed ? { error: status } : {}),
      });
    }
    return { status, ...progress };
  };
}
