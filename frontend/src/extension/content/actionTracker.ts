import { parseCurrentGitHubItem } from './viewTracker';
import type { ExtensionMessage, ExtensionResponse } from '../types';

export type GitHubActionType =
  | 'comment'
  | 'pr_review'
  | 'merge'
  | 'close_reopen'
  | 'assignee_label';

export const ACTION_SYNC_DELAY_MS = 1000;

interface PendingSync {
  timeoutId?: ReturnType<typeof setTimeout>;
  fallbackTimeoutId?: ReturnType<typeof setTimeout>;
  actionType: GitHubActionType;
  timestamp: number;
}

const pendingSyncs = new Map<string, PendingSync>();
let onActionDetectedCallback: ((itemId: string, actionType: GitHubActionType) => void) | null = null;
let onSyncTriggeredCallback: ((itemId: string, actionType: GitHubActionType, response?: ExtensionResponse, isFallback?: boolean) => void) | null = null;

export function setActionListenersForTest(
  onDetected?: (itemId: string, actionType: GitHubActionType) => void,
  onTriggered?: (itemId: string, actionType: GitHubActionType, response?: ExtensionResponse, isFallback?: boolean) => void
): void {
  onActionDetectedCallback = onDetected || null;
  onSyncTriggeredCallback = onTriggered || null;
}

export function resetActionTrackerState(): void {
  for (const pending of pendingSyncs.values()) {
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
    if (pending.fallbackTimeoutId) {
      clearTimeout(pending.fallbackTimeoutId);
    }
  }
  pendingSyncs.clear();
  onActionDetectedCallback = null;
  onSyncTriggeredCallback = null;
}

export function cancelActionSync(itemId: string): void {
  const existing = pendingSyncs.get(itemId);
  if (existing) {
    if (existing.timeoutId) clearTimeout(existing.timeoutId);
    if (existing.fallbackTimeoutId) clearTimeout(existing.fallbackTimeoutId);
    pendingSyncs.delete(itemId);
  }
}

export function getPendingSync(itemId: string): PendingSync | undefined {
  const p = pendingSyncs.get(itemId);
  if (!p) return undefined;
  if (!p.timeoutId && !p.fallbackTimeoutId) {
    pendingSyncs.delete(itemId);
    return undefined;
  }
  return p;
}

/**
 * Traverses from a starting element up across ShadowRoot boundaries to light DOM hosts.
 * Unlike standard el.closest(selector), this pierces open and closed Shadow DOM roots.
 */
function closestAcrossShadow(startNode: Element | null, selector: string): Element | null {
  let current: Element | null = startNode;
  while (current) {
    const found = current.closest(selector);
    if (found) return found;

    const root = current.getRootNode();
    if (root && (root as unknown as { host?: Element }).host instanceof Element) {
      current = (root as unknown as { host: Element }).host;
    } else {
      break;
    }
  }
  return null;
}

/**
 * Searches all elements in event.composedPath() matching the given selector,
 * allowing detection inside web component Shadow DOM roots where event.target retargets.
 */
function matchesInComposedPath(event: Event, selector: string): Element | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const node of path) {
    if (node instanceof Element && node.matches(selector)) {
      return node;
    }
  }
  return null;
}

/**
 * Detects if a DOM event corresponds to a GitHub PR or issue user action:
 * - Submitting comments (main form, inline comments, PR reviews, replies)
 * - Submitting PR reviews (Approve, Request Changes, Comment)
 * - State & lifecycle changes (Merging, Closing, Reopening, editing assignees/labels/milestones/reviewers)
 */
export function detectGitHubAction(event: Event): GitHubActionType | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const target = ((path[0] as Element | undefined) || (event.target as Element | null)) as Element | null;
  if (!target) return null;

  const type = event.type;

  // 1. FORM SUBMIT EVENTS
  if (type === 'submit') {
    const form =
      closestAcrossShadow(target, 'form') ||
      matchesInComposedPath(event, 'form') ||
      (target instanceof HTMLFormElement ? target : null);
    if (form) {
      const action = form.getAttribute('action') || '';
      const formClass = form.className || '';
      const formId = form.id || '';
      const testId = form.getAttribute('data-testid') || '';

      // PR Review Submission
      if (
        formClass.includes('js-pull-request-review-submission-form') ||
        action.includes('/pull_request_review') ||
        action.includes('pull-request-review') ||
        testId.includes('pull-request-review') ||
        testId.includes('review-form')
      ) {
        return 'pr_review';
      }

      // Merge PR
      if (
        formClass.includes('js-merge-pull-request') ||
        formClass.includes('js-pull-request-merge-form') ||
        action.includes('/merge') ||
        testId.includes('merge-form') ||
        testId.includes('pull-request-merge')
      ) {
        return 'merge';
      }

      // Close or Reopen Issue/PR
      const submitBtn =
        ((event as unknown) as { submitter?: HTMLButtonElement | HTMLInputElement }).submitter ||
        (matchesInComposedPath(
          event,
          'button[type="submit"], input[type="submit"], [data-testid*="close"i], [data-testid*="reopen"i]'
        ) as HTMLButtonElement | HTMLInputElement | null);
      const submitName = submitBtn?.name || '';
      const submitValue = submitBtn?.value || '';
      const submitTestId = submitBtn?.getAttribute('data-testid') || '';
      if (
        submitName === 'comment_and_close' ||
        submitValue === 'close' ||
        submitName === 'comment_and_reopen' ||
        submitValue === 'reopen' ||
        action.includes('/close') ||
        action.includes('/reopen') ||
        submitTestId.includes('close') ||
        submitTestId.includes('reopen') ||
        form.querySelector('[data-testid*="close-issue"i], [data-testid*="reopen-issue"i], [data-testid*="close-pr"i], [data-testid*="reopen-pr"i]') != null
      ) {
        return 'close_reopen';
      }

      // Assignees or Labels Sidebar Form
      if (
        formClass.includes('js-issue-sidebar-form') ||
        action.includes('/assignees') ||
        action.includes('/labels') ||
        action.includes('/milestone') ||
        action.includes('/reviewers') ||
        action.includes('/projects') ||
        testId.includes('sidebar-form')
      ) {
        return 'assignee_label';
      }

      // Comment Submissions
      if (
        formClass.includes('js-new-comment-form') ||
        formClass.includes('js-inline-comment-form') ||
        formClass.includes('js-discussion-comment-form') ||
        formClass.includes('js-comment-form') ||
        formId === 'partial-new-comment-form-actions' ||
        formId === 'new_comment_form' ||
        action.includes('/comments') ||
        action.includes('/review_comment') ||
        testId.includes('comment-form') ||
        testId.includes('new-comment') ||
        form.querySelector('textarea[name="comment[body]"], textarea[aria-label*="comment"i], textarea[placeholder*="comment"i]') != null
      ) {
        return 'comment';
      }
    }
  }

  // 2. KEYDOWN EVENTS (Ctrl+Enter, Meta+Enter inside text editor, OR Enter/Space in popovers)
  if (type === 'keydown') {
    const kbEvent = event as KeyboardEvent;
    // Enter / Space inside sidebar assignee/label dialog options
    if (kbEvent.key === ' ' || kbEvent.key === 'Enter') {
      const isOption =
        closestAcrossShadow(
          target,
          '[role="option"], [role="menuitemcheckbox"], [role="checkbox"], [data-testid*="picker-item"i], [data-testid*="assignee-item"i], [data-testid*="label-item"i], .js-assignee-picker-item, .js-label-picker-item'
        ) ||
        matchesInComposedPath(
          event,
          '[role="option"], [role="menuitemcheckbox"], [role="checkbox"], [data-testid*="picker-item"i], [data-testid*="assignee-item"i], [data-testid*="label-item"i], .js-assignee-picker-item, .js-label-picker-item'
        );
      const isPicker =
        closestAcrossShadow(
          target,
          '.js-assignee-picker, .js-label-picker, #assignees-select-menu, #labels-select-menu, [data-testid*="sidebar"i], [data-testid*="picker"i], [role="dialog"][aria-label*="assignee"i], [role="dialog"][aria-label*="label"i]'
        ) ||
        matchesInComposedPath(
          event,
          '.js-assignee-picker, .js-label-picker, #assignees-select-menu, #labels-select-menu, [data-testid*="sidebar"i], [data-testid*="picker"i], [role="dialog"][aria-label*="assignee"i], [role="dialog"][aria-label*="label"i]'
        );
      if (isOption && isPicker) {
        return 'assignee_label';
      }
    }

    if ((kbEvent.ctrlKey || kbEvent.metaKey) && kbEvent.key === 'Enter') {
      const el = target as HTMLElement;
      const isInputOrEditor =
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'INPUT' ||
        el.getAttribute('contenteditable') === 'true' ||
        closestAcrossShadow(el, '[contenteditable="true"]') != null ||
        matchesInComposedPath(event, 'textarea, [contenteditable="true"]') != null;

      if (isInputOrEditor) {
        const name = el.getAttribute('name') || '';
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
        const testId = el.getAttribute('data-testid') || '';

        if (
          name.includes('pull_request_review') ||
          ariaLabel.includes('review') ||
          placeholder.includes('review') ||
          testId.includes('review') ||
          closestAcrossShadow(
            el,
            '.js-pull-request-review-submission-form, [data-testid*="review"i], [data-testid*="pull-request-review-form"i]'
          ) != null
        ) {
          return 'pr_review';
        }
        return 'comment';
      }
    }
  }

  // 3. CHANGE EVENTS (Inputs in assignee/label pickers)
  if (type === 'change' || type === 'input') {
    const el = target as HTMLElement;
    const name = el.getAttribute('name') || '';
    if (
      name.includes('assignee') ||
      name.includes('label') ||
      name.includes('milestone') ||
      name.includes('reviewer') ||
      name.includes('project')
    ) {
      return 'assignee_label';
    }
    const closestPicker =
      closestAcrossShadow(
        target,
        '.js-assignee-picker, .js-label-picker, #assignees-select-menu, #labels-select-menu, [data-testid*="assignee"i], [data-testid*="label"i], [data-testid*="milestone"i], [data-testid*="reviewer"i], [role="dialog"][aria-label*="assignee"i], [role="dialog"][aria-label*="label"i]'
      ) ||
      matchesInComposedPath(
        event,
        '.js-assignee-picker, .js-label-picker, #assignees-select-menu, #labels-select-menu, [data-testid*="assignee"i], [data-testid*="label"i], [data-testid*="milestone"i], [data-testid*="reviewer"i], [role="dialog"][aria-label*="assignee"i], [role="dialog"][aria-label*="label"i]'
      );
    if (closestPicker) {
      return 'assignee_label';
    }
  }

  // 4. CLICK EVENTS
  if (type === 'click') {
    const btnOrInput =
      closestAcrossShadow(
        target,
        'button, input[type="submit"], input[type="button"], input[type="checkbox"], input[type="radio"], a, .select-menu-item, [role="menuitemcheckbox"], [role="menuitem"], [role="option"], [role="checkbox"], [data-menu-trigger], [data-testid*="item"i], [data-testid*="row"i], .js-assignee-picker-item, .js-label-picker-item'
      ) ||
      matchesInComposedPath(
        event,
        'button, input[type="submit"], input[type="button"], input[type="checkbox"], input[type="radio"], a, .select-menu-item, [role="menuitemcheckbox"], [role="menuitem"], [role="option"], [role="checkbox"], [data-menu-trigger], [data-testid*="item"i], [data-testid*="row"i], .js-assignee-picker-item, .js-label-picker-item'
      );
    if (!btnOrInput) {
      if (
        closestAcrossShadow(
          target,
          '.js-assignee-picker-item, .js-label-picker-item, [data-testid*="assignee-item"i], [data-testid*="label-item"i]'
        )
      ) {
        return 'assignee_label';
      }
      return null;
    }

    const name = btnOrInput.getAttribute('name') || '';
    const value = btnOrInput.getAttribute('value') || '';
    const className = btnOrInput.className || '';
    const text = (btnOrInput.textContent || '').trim().toLowerCase();
    const trigger = btnOrInput.getAttribute('data-menu-trigger') || '';
    const testId = btnOrInput.getAttribute('data-testid') || '';
    const ariaLabel = (btnOrInput.getAttribute('aria-label') || '').toLowerCase();

    // Assignees / Labels / Milestones / Reviewers Sidebar Interactions
    if (
      trigger === 'assignees' ||
      trigger === 'labels' ||
      trigger === 'reviewers' ||
      trigger === 'milestone' ||
      className.includes('js-assignee-picker') ||
      className.includes('js-label-picker') ||
      testId.includes('sidebar-assignees') ||
      testId.includes('sidebar-labels') ||
      testId.includes('sidebar-reviewers') ||
      testId.includes('sidebar-milestone') ||
      ariaLabel.includes('edit assignees') ||
      ariaLabel.includes('edit labels') ||
      ariaLabel.includes('edit reviewers') ||
      ariaLabel.includes('edit milestone') ||
      closestAcrossShadow(
        btnOrInput,
        '.js-assignee-picker, .js-label-picker, #assignees-select-menu, #labels-select-menu, .js-issue-sidebar-item, .discussion-sidebar-item, [data-testid*="assignee-picker"i], [data-testid*="label-picker"i], [role="dialog"][aria-label*="assignee"i], [role="dialog"][aria-label*="label"i]'
      ) ||
      closestAcrossShadow(btnOrInput, '[data-menu-trigger="assignees"], [data-menu-trigger="labels"]')
    ) {
      if (
        className.includes('select-menu-item') ||
        btnOrInput.getAttribute('role') === 'menuitemcheckbox' ||
        btnOrInput.getAttribute('role') === 'option' ||
        btnOrInput.getAttribute('role') === 'checkbox' ||
        className.includes('js-assignee-picker-item') ||
        className.includes('js-label-picker-item') ||
        className.includes('js-reviewer-picker-item') ||
        className.includes('js-milestone-picker-item') ||
        trigger === 'assignees' ||
        trigger === 'labels' ||
        trigger === 'reviewers' ||
        trigger === 'milestone' ||
        testId.includes('picker-item') ||
        testId.includes('item') ||
        testId.includes('row') ||
        btnOrInput.tagName === 'INPUT' ||
        btnOrInput.tagName === 'LI' ||
        text.includes('apply') ||
        text.includes('save') ||
        text.includes('update') ||
        text.includes('clear') ||
        text.includes('remove') ||
        name.includes('assignee') ||
        name.includes('label') ||
        name.includes('reviewer') ||
        name.includes('milestone')
      ) {
        return 'assignee_label';
      }
    }

    // Merge PR
    if (
      className.includes('js-merge-commit-button') ||
      className.includes('js-merge-pull-request') ||
      testId.includes('merge-button') ||
      testId.includes('confirm-merge') ||
      testId.includes('squash-button') ||
      testId.includes('rebase-button') ||
      text.includes('merge pull request') ||
      text.includes('confirm merge') ||
      text.includes('squash and merge') ||
      text.includes('confirm squash') ||
      text.includes('rebase and merge') ||
      text.includes('confirm rebase') ||
      text.includes('auto-merge') ||
      text.includes('merge without waiting')
    ) {
      return 'merge';
    }

    // Close or Reopen Issue/PR or Draft State Change
    if (
      name === 'comment_and_close' ||
      name === 'comment_and_reopen' ||
      value === 'close' ||
      value === 'reopen' ||
      testId.includes('close-issue') ||
      testId.includes('reopen-issue') ||
      testId.includes('close-pr') ||
      testId.includes('reopen-pr') ||
      testId.includes('close-button') ||
      testId.includes('reopen-button') ||
      testId.includes('convert-to-draft') ||
      testId.includes('ready-for-review') ||
      text.includes('close issue') ||
      text.includes('close pull request') ||
      text.includes('close with comment') ||
      text.includes('close as completed') ||
      text.includes('close as not planned') ||
      text.includes('reopen issue') ||
      text.includes('reopen pull request') ||
      text.includes('reopen with comment') ||
      text.includes('convert to draft') ||
      text.includes('ready for review') ||
      className.includes('js-comment-and-button')
    ) {
      return 'close_reopen';
    }

    // PR Review Submissions
    if (
      text.includes('submit review') ||
      text.includes('submit pr review') ||
      value.toLowerCase() === 'submit review' ||
      testId.includes('submit-review') ||
      ariaLabel.includes('submit review') ||
      closestAcrossShadow(
        btnOrInput,
        '.js-pull-request-review-submission-form, [data-testid*="pull-request-review-form"i], [data-testid*="review-submission"i], [data-testid*="review-dialog"i]'
      )
    ) {
      if (
        value === 'APPROVE' ||
        value === 'REQUEST_CHANGES' ||
        value === 'COMMENT' ||
        name === 'pull_request_review[event]' ||
        testId.includes('review-event') ||
        text.includes('approve') ||
        text.includes('request changes')
      ) {
        return 'pr_review';
      }
      if (
        btnOrInput.tagName === 'BUTTON' ||
        (btnOrInput.tagName === 'INPUT' && (btnOrInput as HTMLInputElement).type === 'submit')
      ) {
        return 'pr_review';
      }
    }

    // Comment Submissions & Thread Replies & Resolutions
    if (
      className.includes('js-new-comment-button') ||
      className.includes('js-reply-button') ||
      className.includes('js-inline-comment-button') ||
      className.includes('js-resolve-conversation-button') ||
      testId.includes('comment-button') ||
      testId.includes('submit-comment') ||
      testId.includes('reply-button') ||
      testId.includes('resolve-conversation') ||
      text.includes('add comment') ||
      text.includes('post comment') ||
      text.includes('start a review') ||
      text.includes('add review comment') ||
      text.includes('add single comment') ||
      text.includes('resolve conversation') ||
      text.includes('unresolve conversation') ||
      text === 'comment' ||
      text === 'reply' ||
      text === 'update comment' ||
      text === 'save comment' ||
      text === 'post reply'
    ) {
      const isSubmitBtn =
        btnOrInput.tagName === 'BUTTON' ||
        (btnOrInput.tagName === 'INPUT' && (btnOrInput as HTMLInputElement).type === 'submit');
      if (
        isSubmitBtn ||
        closestAcrossShadow(
          btnOrInput,
          '.js-new-comment-form, .js-inline-comment-form, .js-discussion-comment-form, [data-testid*="comment-form"i], [data-testid*="new-comment"i]'
        )
      ) {
        return 'comment';
      }
      return 'comment';
    }
  }

  return null;
}

/**
 * Triggers an item sync (RefetchItem ConnectRPC via background message)
 * after a debounced ~1000ms delay, followed by a secondary fallback refetch
 * after ~3500ms if primary sync failed or did not confirm completion.
 */
export function scheduleActionSync(
  itemId: string,
  actionType: GitHubActionType,
  delayMs = ACTION_SYNC_DELAY_MS
): void {
  const existing = pendingSyncs.get(itemId);
  if (existing) {
    if (existing.timeoutId) clearTimeout(existing.timeoutId);
    if (existing.fallbackTimeoutId) clearTimeout(existing.fallbackTimeoutId);
  }

  if (onActionDetectedCallback) {
    onActionDetectedCallback(itemId, actionType);
  }

  const sendSyncMessage = (isFallback = false) => {
    try {
      const msg: ExtensionMessage = {
        type: 'REFETCH_ITEM',
        itemId,
      };

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage(msg, (response: ExtensionResponse | undefined) => {
          if (chrome.runtime.lastError) {
            console.debug(
              `[OctoDeck ActionTracker] Background service worker unavailable for ${itemId} (${isFallback ? 'fallback' : 'primary'}):`,
              chrome.runtime.lastError.message
            );
          } else {
            console.log(
              `[OctoDeck ActionTracker] Auto-sync (${actionType}, fallback=${isFallback}) completed for ${itemId}`
            );
            // If primary refetch completed successfully, cancel fallback timeout to prevent redundant RPC calls
            if (!isFallback && response && response.ok) {
              const p = pendingSyncs.get(itemId);
              if (p && p.fallbackTimeoutId) {
                clearTimeout(p.fallbackTimeoutId);
                p.fallbackTimeoutId = undefined;
              }
              if (p && !p.timeoutId) {
                pendingSyncs.delete(itemId);
              }
            }
          }
          if (onSyncTriggeredCallback) {
            onSyncTriggeredCallback(itemId, actionType, response, isFallback);
          }
        });
      } else {
        if (onSyncTriggeredCallback) {
          onSyncTriggeredCallback(itemId, actionType, undefined, isFallback);
        }
      }
    } catch (err) {
      console.debug('[OctoDeck ActionTracker] Error dispatching action sync message:', err);
    }
  };

  const timeoutId = setTimeout(() => {
    const p = pendingSyncs.get(itemId);
    if (p) {
      p.timeoutId = undefined;
      if (!p.fallbackTimeoutId) {
        pendingSyncs.delete(itemId);
      }
    }
    sendSyncMessage(false);
  }, delayMs);

  const fallbackTimeoutId = setTimeout(() => {
    const p = pendingSyncs.get(itemId);
    if (p) {
      p.fallbackTimeoutId = undefined;
      if (!p.timeoutId) {
        pendingSyncs.delete(itemId);
      }
    }
    sendSyncMessage(true);
  }, delayMs + 2500);

  pendingSyncs.set(itemId, {
    timeoutId,
    fallbackTimeoutId,
    actionType,
    timestamp: Date.now(),
  });

  console.log(
    `[OctoDeck ActionTracker] Action (${actionType}) detected on ${itemId}. Scheduled refetch sync in ~${delayMs}ms (fallback in ~${delayMs + 2500}ms).`
  );
}

function handleEvent(event: Event): void {
  const actionType = detectGitHubAction(event);
  if (!actionType) return;

  const item = parseCurrentGitHubItem();
  if (!item || !item.itemId) return;

  scheduleActionSync(item.itemId, actionType);
}

/**
 * Initializes DOM listeners for user actions on GitHub PR/issue pages.
 */
export function initActionTracker(): () => void {
  const listener = (e: Event) => handleEvent(e);

  // Capture phase listeners so propagation stops don't hide submit/click events
  document.addEventListener('submit', listener, true);
  document.addEventListener('click', listener, true);
  document.addEventListener('keydown', listener, true);
  document.addEventListener('change', listener, true);

  return () => {
    document.removeEventListener('submit', listener, true);
    document.removeEventListener('click', listener, true);
    document.removeEventListener('keydown', listener, true);
    document.removeEventListener('change', listener, true);
    resetActionTrackerState();
  };
}
