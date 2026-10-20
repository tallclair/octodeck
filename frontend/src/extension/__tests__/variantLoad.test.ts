import { afterEach, describe, expect, it, vi } from 'vitest';
import { classicLoadAdapter, openCollapsedAncestors, parseHiddenCount } from '../content/variants/classic/load';
import { reactLoadAdapter } from '../content/variants/react/load';
import type { HiddenItemsInfo } from '../content/capabilities/types';
import { loadFixture, resetFixture } from './fixtureHarness';
import { threadLoader } from './githubMarkup';

const timelineRoot = () => document.querySelector('.js-discussion') as Element;
const range = () => classicLoadAdapter.hidden(timelineRoot()).find((h) => h.kind === 'range') as HiddenItemsInfo;
const signal = () => new AbortController().signal;

/**
 * Stands in for GitHub's remote-form handler (behaviors.js): intercepts the pagination submit,
 * disables the buttons like data-disable-with, then splices server HTML in place of the form.
 */
function fakeGitHubPagination(respond: (form: HTMLFormElement) => string | null | 'error', delayMs = 5) {
  const onSubmit = (e: Event) => {
    const form = e.target as HTMLFormElement;
    if (!form.matches('form.js-ajax-pagination')) return;
    e.preventDefault();
    const buttons = Array.from(form.querySelectorAll('button'));
    for (const b of buttons) b.disabled = true;
    setTimeout(() => {
      const html = respond(form);
      if (html === 'error') {
        for (const b of buttons) b.disabled = false; // GitHub restores the button; the form stays
        return;
      }
      if (html === null) {
        form.remove(); // HTTP 404
        return;
      }
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      form.replaceWith(tpl.content);
    }, delayMs);
  };
  document.addEventListener('submit', onSubmit, true);
  return () => document.removeEventListener('submit', onSubmit, true);
}

const itemHtml = (gid: string, commentId: string) =>
  `<div class="js-timeline-item" data-gid="${gid}"><div id="issuecomment-${commentId}" class="js-targetable-element">c</div></div>`;
const nextForm = (cursor: string) =>
  `<form class="js-ajax-pagination" action="/o/r/pull/1/timeline_more_items?after_cursor=${cursor}" method="get"><button type="submit">40 hidden items</button><button type="submit">Load more…</button></form>`;

describe('classic load adapter (fixture classic-pr-141014)', () => {
  let undo: (() => void) | null = null;
  afterEach(() => {
    undo?.();
    undo = null;
    vi.useRealTimers();
    resetFixture();
  });

  it('finds the hidden range with its count and the collapsed review thread with its comment ids', async () => {
    await loadFixture('classic-pr-141014');
    const hidden = classicLoadAdapter.hidden(timelineRoot());
    expect(hidden.filter((h) => h.kind === 'range')).toEqual([
      expect.objectContaining({ count: 104, segment: document.querySelector('form.js-ajax-pagination') }),
    ]);
    const threads = hidden.filter((h) => h.kind === 'collapsedThread');
    expect(threads.length).toBeGreaterThan(0);
    expect(threads[0].containsCommentIds).toEqual(['4286379549', '4286387820']);
    // Open threads are not hidden content.
    for (const t of threads) expect(t.segment.querySelector('[aria-expanded="true"]')).toBeNull();
    expect(classicLoadAdapter.supportsLoadMore()).toBe(true);
  });

  it('reports a review thread\'s "Load more…" loader as hidden comments, never as a timeline range', async () => {
    await loadFixture('classic-pr-141014');
    // Shape observed in a timeline_more_items batch on kubernetes/enhancements#6169: review threads
    // load hidden replies through the same ajax-pagination form, with no count in the button.
    timelineRoot().append(threadLoader('111,222,333'));
    const hidden = classicLoadAdapter.hidden(timelineRoot());
    expect(hidden.filter((h) => h.kind === 'range')).toEqual([expect.objectContaining({ count: 104 })]);
    expect(hidden.filter((h) => h.kind === 'hiddenComments')).toEqual([
      expect.objectContaining({ count: 3, containsCommentIds: ['111', '222', '333'] }),
    ]);
  });

  it('loadOne clicks GitHub\'s control and resolves "loaded" when the form is replaced by new items', async () => {
    await loadFixture('classic-pr-141014');
    const before = document.querySelectorAll('.js-timeline-item').length;
    undo = fakeGitHubPagination(() => itemHtml('IC_new1', '901') + itemHtml('IC_new2', '902') + nextForm('next'));
    const seg = range();
    await expect(classicLoadAdapter.loadOne(seg, { signal: signal(), timeoutMs: 1000 })).resolves.toBe('loaded');
    expect(document.querySelectorAll('.js-timeline-item').length).toBe(before + 2);
    expect(seg.segment.isConnected).toBe(false);
    expect(range().count).toBe(40);
  });

  it('resolves "ended" when GitHub removes the form without items (404)', async () => {
    await loadFixture('classic-pr-141014');
    undo = fakeGitHubPagination(() => null);
    await expect(classicLoadAdapter.loadOne(range(), { signal: signal(), timeoutMs: 1000 })).resolves.toBe('ended');
  });

  it('resolves "failed" when GitHub re-enables the button but keeps the form', async () => {
    await loadFixture('classic-pr-141014');
    undo = fakeGitHubPagination(() => 'error');
    await expect(classicLoadAdapter.loadOne(range(), { signal: signal(), timeoutMs: 5000 })).resolves.toBe('failed');
  });

  it('resolves "failed" on a stale cursor (replacement form has the same action)', async () => {
    await loadFixture('classic-pr-141014');
    undo = fakeGitHubPagination((form) => itemHtml('IC_x', '1') + form.outerHTML);
    await expect(classicLoadAdapter.loadOne(range(), { signal: signal(), timeoutMs: 1000 })).resolves.toBe('failed');
  });

  it('times out when nothing happens', async () => {
    await loadFixture('classic-pr-141014');
    undo = fakeGitHubPagination(() => itemHtml('IC_late', '2'), 10_000);
    await expect(classicLoadAdapter.loadOne(range(), { signal: signal(), timeoutMs: 30 })).resolves.toBe('timeout');
  });

  it('aborts promptly', async () => {
    await loadFixture('classic-pr-141014');
    undo = fakeGitHubPagination(() => itemHtml('IC_late', '2'), 10_000);
    const c = new AbortController();
    const p = classicLoadAdapter.loadOne(range(), { signal: c.signal, timeoutMs: 5000 });
    c.abort();
    await expect(p).resolves.toBe('aborted');
  });

  it('never submits the form natively (that would navigate away)', async () => {
    await loadFixture('classic-pr-141014');
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit');
    undo = fakeGitHubPagination(() => itemHtml('IC_n', '3'));
    await classicLoadAdapter.loadOne(range(), { signal: signal(), timeoutMs: 1000 });
    expect(submit).not.toHaveBeenCalled();
  });

  it('opens a collapsed thread by clicking its toggle (never calling element methods)', async () => {
    await loadFixture('classic-pr-141014');
    const thread = classicLoadAdapter.hidden(timelineRoot()).find((h) => h.kind === 'collapsedThread')!;
    const toggle = thread.segment.querySelector('button[data-target="review-thread-collapsible.button"]') as HTMLButtonElement;
    const clicks = vi.fn();
    toggle.addEventListener('click', clicks);
    await expect(classicLoadAdapter.reveal(thread, { signal: signal() })).resolves.toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('loadOne on a collapsed thread resolves when its review comments render', async () => {
    await loadFixture('classic-pr-141014');
    const thread = classicLoadAdapter.hidden(timelineRoot()).find((h) => h.kind === 'collapsedThread')!;
    const toggle = thread.segment.querySelector('button[data-target="review-thread-collapsible.button"]') as HTMLButtonElement;
    toggle.addEventListener('click', () => {
      // GitHub's custom element loads data-deferred-content-url and renders the comments.
      setTimeout(() => {
        toggle.setAttribute('aria-expanded', 'true');
        thread.segment.insertAdjacentHTML('beforeend', '<div id="discussion_r4286379549">r</div>');
      }, 5);
    });
    await expect(classicLoadAdapter.loadOne(thread, { signal: signal(), timeoutMs: 1000 })).resolves.toBe('loaded');
    expect(classicLoadAdapter.hidden(timelineRoot()).some((h) => h.segment === thread.segment)).toBe(false);
  });

  it('focusedLoad nudges GitHub\'s own anchor loader with one synthetic hashchange', async () => {
    await loadFixture('classic-pr-141014');
    const onHash = vi.fn(() => {
      // GitHub's handler fetches timeline_focused_item and splices the item in.
      setTimeout(() => timelineRoot().insertAdjacentHTML('beforeend', itemHtml('IC_focus', '777')), 5);
    });
    window.addEventListener('hashchange', onHash);
    try {
      await expect(classicLoadAdapter.focusedLoad!('issuecomment-777', { signal: signal(), timeoutMs: 1000 })).resolves.toBe(true);
      expect(onHash).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('hashchange', onHash);
    }
  });

  it('focusedLoad reports false when GitHub has no anchor loader on the page', async () => {
    await loadFixture('react-issue-142957');
    await expect(classicLoadAdapter.focusedLoad!('issuecomment-1', { signal: signal(), timeoutMs: 50 })).resolves.toBe(false);
  });
});

describe('openCollapsedAncestors', () => {
  it('opens closed <details> around the target and leaves open ones alone', () => {
    document.body.innerHTML = '<details id="outer"><summary>s</summary><details id="inner" open><summary>t</summary><p id="x">x</p></details></details>';
    const outer = document.getElementById('outer') as HTMLDetailsElement;
    expect(openCollapsedAncestors(document.getElementById('x')!)).toBe(true);
    expect(outer.open).toBe(true);
    expect((document.getElementById('inner') as HTMLDetailsElement).open).toBe(true);
    expect(openCollapsedAncestors(document.getElementById('x')!)).toBe(false);
  });
});

describe('parseHiddenCount', () => {
  it('reads digits from the first labelled button and tolerates separators', () => {
    const f = document.createElement('form');
    f.innerHTML = '<button type="submit">1,204 hidden items</button><button type="submit">Load more…</button>';
    expect(parseHiddenCount(f)).toBe(1204);
    f.innerHTML = '<button type="submit">Load more…</button>';
    expect(parseHiddenCount(f)).toBeNull();
  });
});

describe('react load adapter (fixture react-issue-142957)', () => {
  afterEach(() => resetFixture());

  it('fails closed: load-more unsupported, nothing hidden, loadOne never clicks', async () => {
    await loadFixture('react-issue-142957');
    const root = document.querySelector('[data-testid="issue-timeline-container"]') as Element;
    expect(reactLoadAdapter.supportsLoadMore()).toBe(false);
    expect(reactLoadAdapter.hidden(root)).toEqual([]);
    await expect(
      reactLoadAdapter.loadOne({ kind: 'range', segment: root, count: null }, { signal: signal(), timeoutMs: 10 })
    ).resolves.toBe('failed');
  });
});
