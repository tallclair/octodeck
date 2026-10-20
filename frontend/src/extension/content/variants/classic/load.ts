/**
 * Classic (Rails) timeline loading adapter
 * (docs/internal/extension_dom_engine_design.md sections 9.1 and 9.2).
 *
 * Mechanics come from GitHub's own bundled behaviors (behaviors.js, observed 2026-10):
 * - The hidden middle of a long timeline is one `form.js-ajax-pagination` ("N hidden items" /
 *   "Load more…"). GitHub's remote-form handler intercepts its submit event, fetches the next
 *   batch and replaces the form in place with the new items plus a new form if more remain. It then
 *   fires `page:loaded` on the detached form. On HTTP 404 the form is removed without items; on
 *   other errors the form stays.
 * - Resolved/outdated review threads are `review-thread-collapsible` custom elements; their hidden
 *   comment ids are listed in `data-hidden-comment-ids` and their content loads when opened.
 * - Long threads/reviews use `.js-thread-hidden-comment-ids` / `.js-review-hidden-comment-ids`
 *   loader forms.
 * - GitHub's own anchor loader (`#js-timeline-progressive-loader[data-timeline-item-src]`) fetches
 *   the single item containing a URL hash, but only runs on DOM-ready, `hashchange` and Turbo
 *   success, so on React-shell pages it misses the late-inserted Rails partial.
 *
 * Rules: always trigger GitHub's own controls with a real click (never `form.submit()`, which
 * navigates away, and never fetch GitHub endpoints ourselves). Content scripts cannot call
 * main-world custom-element methods, so collapsed threads are opened by clicking their toggle.
 */
import type { HiddenItemsInfo } from '../../capabilities/types';
import { isOwnNode } from '../../engine/constants';
import type { LoadOutcome, TimelineLoadAdapter } from '../types';
import { CLASSIC_ANCHORS } from './anchors';

/** The hidden-range form inside GitHub's progressive container (the contract's primary locator). */
const RANGE_PRIMARY = CLASSIC_ANCHORS['timeline.hiddenRange'].selectors[0];
/**
 * Any pagination form in the timeline. GitHub's focused-anchor loader replaces the progressive
 * container with server HTML, so a remaining range may no longer sit inside it.
 */
const RANGE_FORM = 'form.js-ajax-pagination';
const SUBMIT_BUTTON = 'button[type="submit"]';
const TIMELINE_ITEM = '.js-timeline-item';
const COLLAPSED_THREAD = CLASSIC_ANCHORS['timeline.collapsedThread'].selectors[0];
const THREAD_TAG = 'review-thread-collapsible';
const THREAD_TOGGLE = 'button[data-target="review-thread-collapsible.button"]';
const HIDDEN_COMMENTS = CLASSIC_ANCHORS['timeline.hiddenComments'].selectors[0];
const REVIEW_COMMENT = '[id^="discussion_r"]';
const FOCUSED_LOADER = '#js-timeline-progressive-loader[data-timeline-item-src]';

/** After GitHub re-enables the button, how long we still wait for the form to be replaced. */
const REENABLE_GRACE_MS = 750;

/** Parses the digits of the first control label ("104 hidden items"), as a hint only. */
export function parseHiddenCount(form: Element): number | null {
  for (const button of Array.from(form.querySelectorAll(SUBMIT_BUTTON))) {
    const m = /\d[\d,.\s]*/.exec(button.textContent ?? '');
    if (!m) continue;
    const n = Number.parseInt(m[0].replace(/\D/g, ''), 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseIds(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

function isThreadOpen(thread: Element): boolean {
  const toggle = thread.querySelector(THREAD_TOGGLE);
  if (toggle) return toggle.getAttribute('aria-expanded') === 'true';
  return thread.classList.contains('open');
}

function formOf(segment: Element): HTMLFormElement | null {
  if (segment instanceof HTMLFormElement) return segment;
  return segment.querySelector('form');
}

function enabledSubmit(form: HTMLFormElement): HTMLButtonElement | null {
  const buttons = Array.from(form.querySelectorAll<HTMLButtonElement>(SUBMIT_BUTTON));
  // Prefer the last button ("Load more…"); both submit the same form.
  return buttons.reverse().find((b) => !b.disabled) ?? null;
}

/**
 * Settles with the first outcome among: `check()` returning a value on a DOM mutation (or an
 * explicit re-check via the `poke` handed to `onReady`), the timeout, or the abort signal. The
 * observer and timers are always cleaned up.
 */
function watch(
  doc: Document,
  signal: AbortSignal,
  timeoutMs: number,
  check: () => LoadOutcome | null,
  onReady?: (poke: () => void) => void
): Promise<LoadOutcome> {
  return new Promise<LoadOutcome>((resolve) => {
    let done = false;
    const finish = (o: LoadOutcome) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(o);
    };
    const poke = () => {
      if (done) return;
      const o = check();
      if (o) finish(o);
    };
    const onAbort = () => finish('aborted');
    const observer = new MutationObserver(poke);
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-expanded'] });
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    if (signal.aborted) {
      finish('aborted');
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    onReady?.(poke);
    poke();
  });
}

async function loadForm(form: HTMLFormElement, kind: HiddenItemsInfo['kind'], signal: AbortSignal, timeoutMs: number): Promise<LoadOutcome> {
  const doc = form.ownerDocument;
  const action = form.getAttribute('action');
  const itemsBefore = doc.querySelectorAll(TIMELINE_ITEM).length;
  const button = enabledSubmit(form);
  let sawDisabled = !button; // all buttons disabled: GitHub (or the user) already has a request in flight
  let reenabledAt: number | null = null;
  let poke: () => void = () => {};
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const promise = watch(
    doc,
    signal,
    timeoutMs,
    () => {
      if (!form.isConnected) {
        if (kind !== 'range') return 'loaded';
        // A replacement form with the same cursor would make us loop forever.
        const stale = Array.from(doc.querySelectorAll<HTMLFormElement>(RANGE_FORM)).some(
          (f) => f !== form && f.getAttribute('action') === action
        );
        if (stale) return 'failed';
        return doc.querySelectorAll(TIMELINE_ITEM).length > itemsBefore ? 'loaded' : 'ended';
      }
      const anyDisabled = Array.from(form.querySelectorAll<HTMLButtonElement>(SUBMIT_BUTTON)).some((b) => b.disabled);
      if (anyDisabled) {
        sawDisabled = true;
        reenabledAt = null;
      } else if (sawDisabled && reenabledAt === null) {
        // GitHub restored the button but kept the form: the request failed. Allow a short grace
        // period in case re-enabling happens just before the replacement.
        reenabledAt = Date.now();
        graceTimer = setTimeout(() => poke(), REENABLE_GRACE_MS);
      } else if (reenabledAt !== null && Date.now() - reenabledAt >= REENABLE_GRACE_MS) {
        return 'failed';
      }
      return null;
    },
    (p) => (poke = p)
  );

  if (button && !signal.aborted) button.click();
  const outcome = await promise;
  clearTimeout(graceTimer);
  return outcome;
}

/** Clicks the toggles of GitHub-collapsed containers around `target` (outermost last). Returns whether any was clicked. */
export function openCollapsedAncestors(target: Element): boolean {
  let clicked = false;
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (isOwnNode(el)) continue;
    if (el instanceof HTMLDetailsElement && !el.open) {
      const summary = Array.from(el.children).find((c) => c.localName === 'summary');
      if (summary instanceof HTMLElement) {
        summary.click();
        clicked = true;
      }
    } else if (el.localName === THREAD_TAG && !isThreadOpen(el)) {
      const toggle = el.querySelector(THREAD_TOGGLE);
      if (toggle instanceof HTMLElement) {
        toggle.click();
        clicked = true;
      }
    }
  }
  return clicked;
}

export const classicLoadAdapter: TimelineLoadAdapter = {
  supportsLoadMore: () => true,

  hidden(root) {
    const out: HiddenItemsInfo[] = [];
    // querySelectorAll on a selector list returns each element once, in document order.
    for (const form of Array.from(root.querySelectorAll(`${RANGE_PRIMARY}, ${RANGE_FORM}`))) {
      if (isOwnNode(form)) continue;
      out.push({ kind: 'range', segment: form, count: parseHiddenCount(form) });
    }
    for (const thread of Array.from(root.querySelectorAll(COLLAPSED_THREAD))) {
      if (isOwnNode(thread) || isThreadOpen(thread)) continue;
      const ids = parseIds(thread.getAttribute('data-hidden-comment-ids'));
      if (ids.length === 0) continue;
      out.push({ kind: 'collapsedThread', segment: thread, count: ids.length, containsCommentIds: ids });
    }
    for (const loader of Array.from(root.querySelectorAll(HIDDEN_COMMENTS))) {
      if (isOwnNode(loader) || !loader.hasAttribute('data-hidden-comment-ids')) continue;
      const ids = parseIds(loader.getAttribute('data-hidden-comment-ids'));
      if (ids.length === 0) continue;
      out.push({ kind: 'hiddenComments', segment: loader, count: ids.length, containsCommentIds: ids });
    }
    return out;
  },

  async loadOne(segment, { signal, timeoutMs }) {
    if (signal.aborted) return 'aborted';
    if (!segment.segment.isConnected) return 'ended';
    if (segment.kind === 'collapsedThread') {
      const thread = segment.segment;
      const toggle = thread.querySelector(THREAD_TOGGLE);
      if (!(toggle instanceof HTMLElement)) return 'failed';
      const doc = thread.ownerDocument;
      const promise = watch(doc, signal, timeoutMs, () => (thread.querySelector(REVIEW_COMMENT) ? 'loaded' : null));
      if (!isThreadOpen(thread)) toggle.click();
      return promise;
    }
    const form = formOf(segment.segment);
    if (!form) return 'failed';
    return loadForm(form, segment.kind, signal, timeoutMs);
  },

  async focusedLoad(hash, { signal, timeoutMs }) {
    const doc = document;
    if (doc.getElementById(hash)) return true;
    if (!doc.querySelector(FOCUSED_LOADER)) return false;
    const found = watch(doc, signal, timeoutMs, () => (doc.getElementById(hash) ? 'loaded' : null));
    // Re-run GitHub's own hash handler, which fetches the focused item and splices it in.
    const url = window.location.href;
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: url, newURL: url }));
    return (await found) === 'loaded';
  },

  async reveal(target, { signal }) {
    if (signal.aborted) return false;
    if (target instanceof Element) {
      openCollapsedAncestors(target);
      return true;
    }
    if (target.kind === 'collapsedThread') {
      if (isThreadOpen(target.segment)) return true;
      const toggle = target.segment.querySelector(THREAD_TOGGLE);
      if (!(toggle instanceof HTMLElement)) return false;
      toggle.click();
      return true;
    }
    if (target.kind === 'hiddenComments') {
      const form = formOf(target.segment);
      const button = form ? enabledSubmit(form) : null;
      if (!button) return false;
      button.click();
      return true;
    }
    return false;
  },

  // The form stacks "N hidden items" over "Load more…" in one column; our control becomes the
  // next row. It lives inside the form, so GitHub's in-place replacement of the form after a load
  // takes it along (the feature re-renders next to the new form). Own buttons are type="button"
  // and never match SUBMIT_BUTTON, so they neither submit the form nor confuse loadForm.
  controlInsertionPoint(control) {
    if (control.localName !== 'button' || !control.closest(RANGE_FORM) || isOwnNode(control)) return null;
    return { after: control };
  },
};
