import { createActionsCap } from '../content/capabilities/actions';
import { HIGHLIGHT_CLASS, TOAST_CLASS, createNavigationCap } from '../content/capabilities/navigation';
import { OWN_ATTR } from '../content/engine/constants';
import type { VariantModule } from '../content/variants/types';
import { openCapabilitySession } from './capabilitySession';
import { createFakeLedger } from './fakes/context';
import { loadFixture, resetFixture } from './fixtureHarness';

describe('capabilities: composer and sidebar', () => {
  afterEach(() => resetFixture());

  it('uses the classic fallback submit selector and reports it as drift', async () => {
    const meta = await loadFixture('classic-pr-141014');
    document.getElementById('partial-new-comment-form-actions')!.removeAttribute('id');
    const s = openCapabilitySession(meta.url);
    expect(s.caps.composer!.submitButton()?.textContent?.trim()).toBe('Comment');
    expect(s.events.some((e) => e.anchor === 'composer.submit' && e.resolution.status === 'fallback')).toBe(true);
  });

  it('places the React Ack control directly before the Comment button, after the close-issue group', async () => {
    const meta = await loadFixture('react-issue-142957');
    const composer = openCapabilitySession(meta.url).caps.composer!;
    const point = composer.insertionPoint();
    expect(point && 'before' in point && point.before).toBe(composer.submitButton());
    expect(composer.submitButton()!.previousElementSibling?.getAttribute('data-component')).toBe('ButtonGroup');
  });

  it('fails closed (null capability) when the composer is duplicated', async () => {
    const meta = await loadFixture('react-issue-142957');
    const composer = document.querySelector('[data-testid="comment-composer"]')!;
    composer.parentElement!.appendChild(composer.cloneNode(true)); // duplicate id and testid outside the timeline
    const s = openCapabilitySession(meta.url);
    expect(s.detections.composer?.status).not.toBe('recognized');
    expect(s.caps.composer).toBeNull();
    // Unaffected scopes still work.
    expect(s.caps.sidebar?.insertionPoint()).not.toBeNull();
  });

  it('ignores an edit composer inside the React timeline', async () => {
    const meta = await loadFixture('react-issue-142957');
    const composer = document.querySelector('[data-testid="comment-composer"]')!;
    const edit = composer.cloneNode(true) as Element;
    edit.removeAttribute('id');
    document.querySelector('[data-testid="issue-timeline-container"] > li')!.appendChild(edit);
    const s = openCapabilitySession(meta.url);
    expect(s.detections.composer?.status).toBe('recognized');
    expect(s.detections.composer?.root).toBe(composer);
    expect(s.caps.composer!.submitButton()).not.toBeNull();
  });

  it('marks the scope unrecognized when its root disappears', async () => {
    const meta = await loadFixture('classic-pr-141014');
    document.querySelector('.js-discussion')!.classList.remove('js-discussion');
    const s = openCapabilitySession(meta.url);
    expect(s.detections.timeline?.status).toBe('unrecognized');
    expect(s.caps.timeline).toBeNull();
  });

  it('never resolves anchors inside OctoDeck-owned nodes', async () => {
    const meta = await loadFixture('react-issue-142957');
    const own = document.createElement('div');
    own.setAttribute(OWN_ATTR, 'sidebarWidget');
    own.innerHTML = '<div data-testid="sidebar-assignees-section"></div>';
    document.querySelector('[data-testid="issue-viewer-metadata-pane"]')!.prepend(own);
    const point = openCapabilitySession(meta.url).caps.sidebar!.insertionPoint();
    expect(point && 'before' in point && own.contains(point.before)).toBe(false);
  });
});

describe('capabilities: navigation', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  function makeNav() {
    const navLedger = createFakeLedger('anchorNav');
    const nav = createNavigationCap({ doc: document, win: window, navLedger, onHash: () => {} });
    return { nav, navLedger };
  }

  it('decodes the hash', () => {
    window.history.replaceState(null, '', '#issuecomment-1%20x');
    expect(makeNav().nav.hash()).toBe('issuecomment-1 x');
    window.history.replaceState(null, '', '#%E0%A4%A');
    expect(makeNav().nav.hash()).toBe('%E0%A4%A');
    window.history.replaceState(null, '', window.location.pathname);
  });

  it('highlights a target and clears the class after a delay or on abort', () => {
    vi.useFakeTimers();
    const { nav } = makeNav();
    const target = document.body.appendChild(document.createElement('div'));
    target.scrollIntoView = vi.fn();
    const controller = new AbortController();
    nav.scrollToAndHighlight(target, { signal: controller.signal });
    expect(target.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(target.classList.contains(HIGHLIGHT_CLASS)).toBe(false);

    nav.scrollToAndHighlight(target, { signal: controller.signal });
    controller.abort();
    expect(target.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('shows an accessible own-node toast and removes it on dismiss or abort', () => {
    const { nav } = makeNav();
    const controller = new AbortController();
    const toast = nav.showToast('Loading…', { signal: controller.signal });
    const el = document.querySelector(`.${TOAST_CLASS}`)!;
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.hasAttribute(OWN_ATTR)).toBe(true);
    toast.update('Still loading…');
    expect(el.textContent).toBe('Still loading…');
    controller.abort();
    expect(el.isConnected).toBe(false);
    expect(() => toast.dismiss()).not.toThrow();
  });
});

describe('capabilities: actions', () => {
  it('ignores events from OctoDeck nodes and delegates the rest to the variant adapter', () => {
    const classify = vi.fn(() => 'comment' as const);
    const module = { id: 'x', detectors: {}, anchors: {}, adapters: { actions: { classify } } } as VariantModule;
    const caps = createActionsCap(module);
    const own = document.body.appendChild(document.createElement('button'));
    own.setAttribute(OWN_ATTR, 'sidebarWidget');
    const github = document.body.appendChild(document.createElement('button'));

    let result: unknown = 'unset';
    own.addEventListener('click', (e) => (result = caps.classify(e)));
    own.click();
    expect(result).toBeNull();

    github.addEventListener('click', (e) => (result = caps.classify(e)));
    github.click();
    expect(result).toBe('comment');
    expect(createActionsCap(undefined).classify(new Event('click'))).toBeNull();
    document.body.innerHTML = '';
  });
});
