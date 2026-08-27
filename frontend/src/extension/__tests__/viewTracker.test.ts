/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseCurrentGitHubItem,
  reportCurrentView,
  initViewTracker,
  resetViewTrackerStateForTest,
} from '../content/viewTracker';

describe('viewTracker', () => {
  let sendMessageMock: any;
  let originalLocationHref: string;

  beforeEach(() => {
    vi.useFakeTimers();
    resetViewTrackerStateForTest();
    sendMessageMock = vi.fn((_msg: any, cb?: (res: any) => void) => {
      if (cb) cb({ ok: true });
    });

    (globalThis as any).chrome = {
      runtime: {
        sendMessage: sendMessageMock,
        lastError: null,
      },
    };

    originalLocationHref = window.location.href;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', {
      value: { href: originalLocationHref, assign: vi.fn() },
      writable: true,
    });
  });

  function setUrl(url: string) {
    Object.defineProperty(window, 'location', {
      value: { href: url },
      writable: true,
    });
  }

  describe('parseCurrentGitHubItem', () => {
    it('parses GitHub pull request URL into owner, repo, number, and itemId', () => {
      setUrl('https://github.com/kubernetes/kubernetes/pull/12345');
      const item = parseCurrentGitHubItem();
      expect(item).toEqual({
        owner: 'kubernetes',
        repo: 'kubernetes',
        number: 12345,
        itemId: 'kubernetes/kubernetes#12345',
        isIssue: false,
        isPullRequest: true,
      });
    });

    it('parses GitHub issue URL into owner, repo, number, and itemId', () => {
      setUrl('https://github.com/octokit/rest.js/issues/42');
      const item = parseCurrentGitHubItem();
      expect(item).toEqual({
        owner: 'octokit',
        repo: 'rest.js',
        number: 42,
        itemId: 'octokit/rest.js#42',
        isIssue: true,
        isPullRequest: false,
      });
    });

    it('returns null for repository root or non-item GitHub URL', () => {
      setUrl('https://github.com/kubernetes/kubernetes');
      expect(parseCurrentGitHubItem()).toBeNull();
    });

    it('returns null for non-GitHub URL', () => {
      setUrl('https://example.com/some/path/pull/10');
      expect(parseCurrentGitHubItem()).toBeNull();
    });
  });

  describe('SPA event interception (pushState, popstate)', () => {
    it('reports view immediately on initViewTracker when URL is an item', () => {
      setUrl('https://github.com/org/repo/pull/100');
      const onNavigation = vi.fn();
      const cleanup = initViewTracker(onNavigation);

      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'VIEW_ITEM', itemId: 'org/repo#100' },
        expect.any(Function)
      );
      expect(onNavigation).toHaveBeenCalledWith('org/repo#100');

      cleanup();
    });

    it('intercepts history.pushState and popstate events during SPA navigation', () => {
      setUrl('https://github.com/org/repo/pull/100');
      const onNavigation = vi.fn();
      const cleanup = initViewTracker(onNavigation);

      sendMessageMock.mockClear();
      onNavigation.mockClear();

      // Navigate to a new PR via pushState
      setUrl('https://github.com/org/repo/pull/101');
      history.pushState(null, '', '/org/repo/pull/101');

      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'VIEW_ITEM', itemId: 'org/repo#101' },
        expect.any(Function)
      );
      expect(onNavigation).toHaveBeenCalledWith('org/repo#101');

      sendMessageMock.mockClear();
      onNavigation.mockClear();

      // Navigate to another PR via popstate
      setUrl('https://github.com/org/repo/pull/102');
      window.dispatchEvent(new PopStateEvent('popstate'));

      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'VIEW_ITEM', itemId: 'org/repo#102' },
        expect.any(Function)
      );
      expect(onNavigation).toHaveBeenCalledWith('org/repo#102');

      cleanup();
    });

    it('restores original history methods on cleanup', () => {
      const origPushState = history.pushState;
      const cleanup = initViewTracker();
      expect(history.pushState).not.toBe(origPushState);
      cleanup();
      expect(history.pushState).toBe(origPushState);
    });
  });

  describe('debounced/throttled view reporting (THROTTLE_MS = 3000)', () => {
    it('throttles view reports for the same item within THROTTLE_MS (3000ms)', async () => {
      setUrl('https://github.com/org/repo/pull/500');

      await reportCurrentView();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);

      // Call immediately again within 3000ms
      await reportCurrentView();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);

      // Advance by 1500ms (< 3000ms)
      vi.advanceTimersByTime(1500);
      await reportCurrentView();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);

      // Advance past 3000ms threshold
      vi.advanceTimersByTime(1600); // total elapsed 3100ms
      await reportCurrentView();
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
    });

    it('does not throttle immediately when visiting a different item ID', async () => {
      setUrl('https://github.com/org/repo/pull/500');
      await reportCurrentView();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);

      // Immediately visit a different PR without waiting 3000ms
      setUrl('https://github.com/org/repo/pull/501');
      await reportCurrentView();
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
      expect(sendMessageMock).toHaveBeenNthCalledWith(
        2,
        { type: 'VIEW_ITEM', itemId: 'org/repo#501' },
        expect.any(Function)
      );
    });
  });
});
