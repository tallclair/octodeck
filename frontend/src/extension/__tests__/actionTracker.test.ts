/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  detectGitHubAction,
  scheduleActionSync,
  initActionTracker,
  resetActionTrackerState,
  cancelActionSync,
  setActionListenersForTest,
  getPendingSync,
  ACTION_SYNC_DELAY_MS,
} from '../content/actionTracker';

describe('actionTracker', () => {
  let sendMessageMock: any;
  let originalLocationHref: string;

  beforeEach(() => {
    vi.useFakeTimers();
    resetActionTrackerState();

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
    resetActionTrackerState();
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

  describe('detectGitHubAction', () => {
    describe('1. Submitting comments', () => {
      it('detects form submit on .js-new-comment-form', () => {
        const form = document.createElement('form');
        form.className = 'js-new-comment-form';
        const event = new Event('submit', { bubbles: true });
        form.dispatchEvent(event);
        expect(detectGitHubAction(event)).toBe('comment');
      });

      it('detects form submit on .js-inline-comment-form', () => {
        const form = document.createElement('form');
        form.className = 'js-inline-comment-form';
        const event = new Event('submit', { bubbles: true });
        form.dispatchEvent(event);
        expect(detectGitHubAction(event)).toBe('comment');
      });

      it('detects form submit with textarea[name="comment[body]"]', () => {
        const form = document.createElement('form');
        const textarea = document.createElement('textarea');
        textarea.name = 'comment[body]';
        form.appendChild(textarea);
        const event = new Event('submit', { bubbles: true });
        form.dispatchEvent(event);
        expect(detectGitHubAction(event)).toBe('comment');
      });

      it('detects clicking comment submission buttons ("Comment", "Reply", "Start a review")', () => {
        const button = document.createElement('button');
        button.textContent = 'Comment';
        const event = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(event, 'target', { value: button });
        expect(detectGitHubAction(event)).toBe('comment');

        button.textContent = 'Start a review';
        expect(detectGitHubAction(event)).toBe('comment');

        button.textContent = 'Reply';
        expect(detectGitHubAction(event)).toBe('comment');
      });

      it('detects Ctrl+Enter or Meta+Enter inside comment textarea', () => {
        const textarea = document.createElement('textarea');
        textarea.name = 'comment[body]';
        const eventCtrl = new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
        });
        Object.defineProperty(eventCtrl, 'target', { value: textarea });
        expect(detectGitHubAction(eventCtrl)).toBe('comment');

        const eventMeta = new KeyboardEvent('keydown', {
          key: 'Enter',
          metaKey: true,
          bubbles: true,
        });
        Object.defineProperty(eventMeta, 'target', { value: textarea });
        expect(detectGitHubAction(eventMeta)).toBe('comment');
      });
    });

    describe('2. Submitting PR reviews', () => {
      it('detects form submit on .js-pull-request-review-submission-form', () => {
        const form = document.createElement('form');
        form.className = 'js-pull-request-review-submission-form';
        const event = new Event('submit', { bubbles: true });
        form.dispatchEvent(event);
        expect(detectGitHubAction(event)).toBe('pr_review');
      });

      it('detects clicking "Submit review" button', () => {
        const button = document.createElement('button');
        button.textContent = 'Submit review';
        const event = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(event, 'target', { value: button });
        expect(detectGitHubAction(event)).toBe('pr_review');
      });

      it('detects Ctrl+Enter inside PR review textarea', () => {
        const textarea = document.createElement('textarea');
        textarea.name = 'pull_request_review[body]';
        const eventCtrl = new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
        });
        Object.defineProperty(eventCtrl, 'target', { value: textarea });
        expect(detectGitHubAction(eventCtrl)).toBe('pr_review');
      });
    });

    describe('3. State and PR/issue lifecycle changes (Merge, Close, Reopen, Assignees, Labels)', () => {
      it('detects PR merge actions', () => {
        const button = document.createElement('button');
        button.textContent = 'Merge pull request';
        const event = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(event, 'target', { value: button });
        expect(detectGitHubAction(event)).toBe('merge');

        button.textContent = 'Squash and merge';
        expect(detectGitHubAction(event)).toBe('merge');

        const form = document.createElement('form');
        form.className = 'js-merge-pull-request';
        const submitEvent = new Event('submit', { bubbles: true });
        form.dispatchEvent(submitEvent);
        expect(detectGitHubAction(submitEvent)).toBe('merge');
      });

      it('detects closing and reopening actions', () => {
        const buttonClose = document.createElement('button');
        buttonClose.value = 'close';
        buttonClose.textContent = 'Close issue';
        const eventClose = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(eventClose, 'target', { value: buttonClose });
        expect(detectGitHubAction(eventClose)).toBe('close_reopen');

        const buttonReopen = document.createElement('button');
        buttonReopen.value = 'reopen';
        buttonReopen.textContent = 'Reopen pull request';
        const eventReopen = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(eventReopen, 'target', { value: buttonReopen });
        expect(detectGitHubAction(eventReopen)).toBe('close_reopen');
      });

      it('detects editing assignees and labels in sidebar', () => {
        const pickerItem = document.createElement('div');
        pickerItem.className = 'select-menu-item';
        const container = document.createElement('div');
        container.className = 'js-assignee-picker';
        container.appendChild(pickerItem);

        const event = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(event, 'target', { value: pickerItem });
        expect(detectGitHubAction(event)).toBe('assignee_label');

        const input = document.createElement('input');
        input.name = 'issue[label_names][]';
        const changeEvent = new Event('change', { bubbles: true });
        Object.defineProperty(changeEvent, 'target', { value: input });
        expect(detectGitHubAction(changeEvent)).toBe('assignee_label');

        const reviewerBtn = document.createElement('button');
        reviewerBtn.setAttribute('data-menu-trigger', 'reviewers');
        const clickReviewer = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(clickReviewer, 'target', { value: reviewerBtn });
        expect(detectGitHubAction(clickReviewer)).toBe('assignee_label');
      });

      it('detects modern React GitHub UI elements (data-testid, role="option", contenteditable, split close buttons)', () => {
        // React option item in sidebar dialog
        const option = document.createElement('li');
        option.setAttribute('role', 'option');
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-label', 'Assignees');
        dialog.appendChild(option);

        const clickEvent = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(clickEvent, 'target', { value: option });
        expect(detectGitHubAction(clickEvent)).toBe('assignee_label');

        // Split close issue button ("Close as completed")
        const closeCompleted = document.createElement('button');
        closeCompleted.textContent = 'Close as completed';
        const clickClose = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(clickClose, 'target', { value: closeCompleted });
        expect(detectGitHubAction(clickClose)).toBe('close_reopen');

        // Resolve conversation thread button
        const resolveBtn = document.createElement('button');
        resolveBtn.textContent = 'Resolve conversation';
        const clickResolve = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(clickResolve, 'target', { value: resolveBtn });
        expect(detectGitHubAction(clickResolve)).toBe('comment');

        // Ctrl+Enter in contenteditable editor
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.setAttribute('data-testid', 'new-comment');
        const keyEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
        });
        Object.defineProperty(keyEvent, 'target', { value: editor });
        expect(detectGitHubAction(keyEvent)).toBe('comment');

        // Clear assignees or remove label
        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear assignees';
        clearBtn.className = 'js-assignee-picker-item';
        const clickClear = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(clickClear, 'target', { value: clearBtn });
        expect(detectGitHubAction(clickClear)).toBe('assignee_label');

        // Convert to draft PR / Ready for review
        const readyBtn = document.createElement('button');
        readyBtn.textContent = 'Ready for review';
        const clickReady = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(clickReady, 'target', { value: readyBtn });
        expect(detectGitHubAction(clickReady)).toBe('close_reopen');
      });
    });

    describe('4. Web Component & Shadow DOM encapsulation (ShadowRoot & composedPath)', () => {
      it('detects actions inside open and closed Shadow DOM custom elements using composedPath() & getRootNode()', () => {
        // Create a simulated custom web component host element with a Shadow DOM root
        const webCompHost = document.createElement('div');
        webCompHost.id = 'gh-custom-review-popover';

        const shadowRoot = webCompHost.attachShadow({ mode: 'open' });
        const form = document.createElement('form');
        form.className = 'js-pull-request-review-submission-form';

        const submitButton = document.createElement('button');
        submitButton.textContent = 'Submit review';
        form.appendChild(submitButton);
        shadowRoot.appendChild(form);

        // When clicked inside shadow DOM, event.target is retargeted to webCompHost when handled at document level
        const clickEvent = new MouseEvent('click', { bubbles: true, composed: true });
        Object.defineProperty(clickEvent, 'target', { value: webCompHost });
        Object.defineProperty(clickEvent, 'composedPath', {
          value: () => [submitButton, form, shadowRoot, webCompHost, document.body, document],
        });

        expect(detectGitHubAction(clickEvent)).toBe('pr_review');

        // Form submit inside Shadow DOM
        const submitEvent = new Event('submit', { bubbles: true, composed: true });
        Object.defineProperty(submitEvent, 'target', { value: webCompHost });
        Object.defineProperty(submitEvent, 'composedPath', {
          value: () => [form, shadowRoot, webCompHost, document.body, document],
        });
        expect(detectGitHubAction(submitEvent)).toBe('pr_review');
      });
    });

    describe('5. Ignored non-action events', () => {
      it('ignores unrelated clicks or standard typing', () => {
        const div = document.createElement('div');
        div.textContent = 'Some normal text';
        const eventClick = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(eventClick, 'target', { value: div });
        expect(detectGitHubAction(eventClick)).toBeNull();

        const textarea = document.createElement('textarea');
        textarea.name = 'comment[body]';
        const eventKey = new KeyboardEvent('keydown', {
          key: 'a',
          ctrlKey: false,
          bubbles: true,
        });
        Object.defineProperty(eventKey, 'target', { value: textarea });
        expect(detectGitHubAction(eventKey)).toBeNull();
      });
    });
  });

  describe('scheduleActionSync & ~1000ms delay timing + fallback sync', () => {
    it('schedules primary sync after ~1000ms and cancels secondary fallback when primary succeeds', () => {
      const onTriggered = vi.fn();
      setActionListenersForTest(undefined, onTriggered);

      scheduleActionSync('org/repo#42', 'comment', ACTION_SYNC_DELAY_MS);

      const pending = getPendingSync('org/repo#42');
      expect(pending).toBeDefined();
      expect(pending?.actionType).toBe('comment');

      // At 500ms, message should not have been dispatched yet
      vi.advanceTimersByTime(500);
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(onTriggered).not.toHaveBeenCalled();

      // At 1000ms, primary sync message is dispatched and succeeds
      vi.advanceTimersByTime(500);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'REFETCH_ITEM', itemId: 'org/repo#42' },
        expect.any(Function)
      );
      expect(onTriggered).toHaveBeenCalledWith('org/repo#42', 'comment', { ok: true }, false);

      // Since primary succeeded ({ ok: true }), fallback should be cancelled
      expect(getPendingSync('org/repo#42')).toBeUndefined();
      vi.advanceTimersByTime(2500);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('executes secondary fallback sync after ~3500ms when primary sync fails', () => {
      sendMessageMock.mockImplementationOnce((_msg: any, cb?: (res: any) => void) => {
        if (cb) cb({ ok: false, error: 'Network timeout' });
      });

      const onTriggered = vi.fn();
      setActionListenersForTest(undefined, onTriggered);

      scheduleActionSync('org/repo#43', 'comment', ACTION_SYNC_DELAY_MS);

      vi.advanceTimersByTime(1000);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(onTriggered).toHaveBeenCalledWith('org/repo#43', 'comment', { ok: false, error: 'Network timeout' }, false);

      // Because primary returned ok: false, fallback timeout remains active
      expect(getPendingSync('org/repo#43')).toBeDefined();

      vi.advanceTimersByTime(2500);
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
      expect(onTriggered).toHaveBeenCalledWith('org/repo#43', 'comment', { ok: true }, true);
      expect(getPendingSync('org/repo#43')).toBeUndefined();
    });

    it('cancels pending syncs cleanly via cancelActionSync', () => {
      scheduleActionSync('org/repo#50', 'comment', 1000);
      expect(getPendingSync('org/repo#50')).toBeDefined();

      cancelActionSync('org/repo#50');
      expect(getPendingSync('org/repo#50')).toBeUndefined();

      vi.advanceTimersByTime(4000);
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('debounces multiple actions on the same item within 1000ms and resets both timers', () => {
      scheduleActionSync('org/repo#100', 'comment', 1000);

      vi.advanceTimersByTime(400);
      expect(sendMessageMock).not.toHaveBeenCalled();

      // Second action occurs at 400ms -> timers should reset
      scheduleActionSync('org/repo#100', 'merge', 1000);

      // Advance by another 800ms (total elapsed 1200ms, 800ms since second action) -> still not triggered
      vi.advanceTimersByTime(800);
      expect(sendMessageMock).not.toHaveBeenCalled();

      // Advance by another 200ms (1000ms since second action) -> primary triggered ONCE
      vi.advanceTimersByTime(200);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('handles background service worker lastError gracefully', () => {
      (globalThis as any).chrome.runtime.sendMessage = vi.fn((_msg: any, cb?: (res: any) => void) => {
        (globalThis as any).chrome.runtime.lastError = { message: 'Service worker inactive' };
        if (cb) cb(undefined);
        (globalThis as any).chrome.runtime.lastError = null;
      });

      const onTriggered = vi.fn();
      setActionListenersForTest(undefined, onTriggered);

      scheduleActionSync('org/repo#99', 'close_reopen', 1000);
      vi.advanceTimersByTime(1000);

      expect(onTriggered).toHaveBeenCalledWith('org/repo#99', 'close_reopen', undefined, false);
    });
  });

  describe('initActionTracker DOM integration', () => {
    it('captures user actions on GitHub PR pages and triggers debounced sync', () => {
      setUrl('https://github.com/kubernetes/kubernetes/pull/1234');

      const onDetected = vi.fn();
      const onTriggered = vi.fn();
      setActionListenersForTest(onDetected, onTriggered);

      const cleanup = initActionTracker();

      // Create comment submit button in document
      const button = document.createElement('button');
      button.textContent = 'Comment';
      document.body.appendChild(button);

      button.click();

      expect(onDetected).toHaveBeenCalledWith('kubernetes/kubernetes#1234', 'comment');
      expect(sendMessageMock).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'REFETCH_ITEM', itemId: 'kubernetes/kubernetes#1234' },
        expect.any(Function)
      );

      document.body.removeChild(button);
      cleanup();
    });
  });
});
