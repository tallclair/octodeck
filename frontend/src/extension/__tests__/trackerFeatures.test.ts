import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetViewTrackerForTest, VIEW_DWELL_MS, VIEW_REVISIT_MIN_MS, viewTrackerFeature } from '../content/features/viewTracker';
import { actionTrackerFeature, ACTION_SYNC_DELAY_MS, ACTION_FALLBACK_EXTRA_MS } from '../content/features/actionTracker';
import type { GitHubActionType } from '../content/capabilities/types';
import type { ExtensionMessage, ExtensionResponse } from '../types';
import { createFakeActions, createFakeCapabilities, fakePageFacts } from './fakes/capabilities';
import { createFakeContext } from './fakes/context';

const ok: ExtensionResponse = { ok: true, data: null };

function attention(visible: boolean, focused: boolean) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(visible ? 'visible' : 'hidden');
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

describe('viewTracker feature', () => {
  const handles: Array<ReturnType<typeof createFakeContext>> = [];
  beforeEach(() => {
    vi.useFakeTimers();
    resetViewTrackerForTest();
  });
  afterEach(() => {
    // Unmount everything so earlier mounts can't react to later tests' events.
    for (const h of handles.splice(0)) h.abort();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const mount = (opts: Parameters<typeof createFakeContext>[0] = {}) => {
    const h = createFakeContext({ id: 'viewTracker', onSend: () => ok, ...opts });
    handles.push(h);
    viewTrackerFeature.create().mount(h.ctx);
    return h;
  };
  const views = (h: ReturnType<typeof mount>) => h.sent.filter((m) => m.type === 'VIEW_ITEM');

  it('records a view after the tab stays visible and focused for the dwell time', async () => {
    attention(true, true);
    const h = mount();
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS - 1);
    expect(views(h)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(views(h)).toEqual([{ type: 'VIEW_ITEM', itemId: 'octo/deck#1' }]);
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS * 5);
    expect(views(h)).toHaveLength(1);
  });

  it('records a revisit after attention is lost and regained, at most once per revisit interval', async () => {
    attention(true, true);
    const h = mount();
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS);
    expect(views(h)).toHaveLength(1);
    const away = (ms: number) => {
      attention(false, false);
      document.dispatchEvent(new Event('visibilitychange'));
      return vi.advanceTimersByTimeAsync(ms);
    };
    const back = async () => {
      attention(true, true);
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS);
    };
    // A quick tab switch does not count again.
    await away(1000);
    await back();
    expect(views(h)).toHaveLength(1);
    // Coming back much later records a fresh view.
    await away(VIEW_REVISIT_MIN_MS);
    await back();
    expect(views(h)).toHaveLength(2);
  });

  it('does not record background tabs until they are brought to the front', async () => {
    attention(false, false);
    const h = mount();
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS * 3);
    expect(views(h)).toHaveLength(0);
    attention(true, true);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS);
    expect(views(h)).toHaveLength(1);
  });

  it('restarts the dwell when focus is lost before it completes', async () => {
    attention(true, true);
    const h = mount();
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS - 500);
    attention(true, false);
    window.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS);
    expect(views(h)).toHaveLength(0);
    attention(true, true);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS - 1);
    expect(views(h)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(views(h)).toHaveLength(1);
  });

  it('a visible but unfocused tab (e.g. another window focused) does not count', async () => {
    attention(true, false);
    const h = mount();
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS * 2);
    expect(views(h)).toHaveLength(0);
  });

  it('sends nothing after the session ends', async () => {
    attention(true, true);
    const h = mount();
    h.abort();
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS * 2);
    expect(views(h)).toHaveLength(0);
  });

  it('is not applicable without an item', async () => {
    attention(true, true);
    const h = mount({ session: { facts: fakePageFacts({ item: null, kind: 'other' }) } });
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS * 2);
    expect(views(h)).toHaveLength(0);
    expect(h.statuses.at(-1)).toMatchObject({ health: 'notApplicable' });
  });

  it('throttles the same item across back-to-back sessions but not different items', async () => {
    attention(true, true);
    const a = mount();
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS);
    a.abort();
    // e.g. Conversation -> Files tab: a new session for the same item right away.
    const b = mount();
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS - 1000);
    expect(views(b)).toHaveLength(0);
    b.abort();
    const c = mount({
      session: { facts: fakePageFacts({ item: { owner: 'octo', repo: 'deck', number: 2, itemId: 'octo/deck#2' } }) },
    });
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS);
    expect(views(c)).toEqual([{ type: 'VIEW_ITEM', itemId: 'octo/deck#2' }]);
  });

  it('waits for a prerendered page to be activated', async () => {
    attention(true, true);
    Object.defineProperty(document, 'prerendering', { configurable: true, value: true });
    try {
      const h = mount();
      await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS * 2);
      expect(views(h)).toHaveLength(0);
      Object.defineProperty(document, 'prerendering', { configurable: true, value: false });
      document.dispatchEvent(new Event('prerenderingchange'));
      await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS);
      expect(views(h)).toHaveLength(1);
    } finally {
      delete (document as { prerendering?: boolean }).prerendering;
    }
  });
});

describe('actionTracker feature', () => {
  let button: HTMLButtonElement;
  const handles: Array<{ abort(): void }> = [];
  beforeEach(() => {
    vi.useFakeTimers();
    button = document.body.appendChild(document.createElement('button'));
  });
  afterEach(() => {
    for (const h of handles.splice(0)) h.abort();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const mount = (onSend: (m: ExtensionMessage) => ExtensionResponse = () => ok, facts = fakePageFacts()) => {
    const classify = vi.fn((e: Event): GitHubActionType | null => (e.type === 'click' && e.target === button ? 'comment' : null));
    const h = createFakeContext({
      id: 'actionTracker',
      onSend,
      caps: createFakeCapabilities({ actions: createFakeActions(classify) }),
      session: { facts },
    });
    handles.push(h);
    actionTrackerFeature.create().mount(h.ctx);
    return { ...h, classify };
  };
  const refetches = (h: ReturnType<typeof mount>) => h.sent.filter((m) => m.type === 'REFETCH_ITEM');

  it('refetches ~1s after a classified action and skips the fallback when it succeeds', async () => {
    const h = mount();
    button.click();
    await vi.advanceTimersByTimeAsync(ACTION_SYNC_DELAY_MS - 1);
    expect(refetches(h)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(refetches(h)).toEqual([{ type: 'REFETCH_ITEM', itemId: 'octo/deck#1' }]);
    await vi.advanceTimersByTimeAsync(ACTION_FALLBACK_EXTRA_MS * 2);
    expect(refetches(h)).toHaveLength(1);
  });

  it('runs the fallback refetch when the primary fails', async () => {
    const h = mount(() => ({ ok: false, error: 'offline' }));
    button.click();
    await vi.advanceTimersByTimeAsync(ACTION_SYNC_DELAY_MS + ACTION_FALLBACK_EXTRA_MS);
    expect(refetches(h)).toHaveLength(2);
  });

  it('debounces repeated actions', async () => {
    const h = mount();
    button.click();
    await vi.advanceTimersByTimeAsync(500);
    button.click();
    await vi.advanceTimersByTimeAsync(ACTION_SYNC_DELAY_MS - 1);
    expect(refetches(h)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(refetches(h)).toHaveLength(1);
  });

  it('ignores unclassified events and stops listening after the session ends', async () => {
    const h = mount();
    document.body.click();
    await vi.advanceTimersByTimeAsync(ACTION_SYNC_DELAY_MS * 5);
    expect(refetches(h)).toHaveLength(0);
    h.abort();
    button.click();
    await vi.advanceTimersByTimeAsync(ACTION_SYNC_DELAY_MS * 5);
    expect(refetches(h)).toHaveLength(0);
    expect(h.classify).toHaveBeenCalledTimes(1);
  });

  it('is not applicable without an item', () => {
    const h = mount(undefined, fakePageFacts({ item: null, kind: 'other' }));
    button.click();
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.statuses.at(-1)).toMatchObject({ health: 'notApplicable' });
  });
});
