/**
 * Action classifier for GitHub's classic (Rails) conversation markup
 * (docs/internal/extension_dom_engine_design.md section 6.5).
 *
 * Maps a user event (submit, click, keydown, change) to the kind of GitHub write it most likely
 * starts, so actionTracker can schedule a refetch of the item. Misclassification only costs (or
 * skips) one refetch, but every rule here is a markup assumption, so the rules are kept in tables
 * and lean on structural signals (form actions, input names, Rails js-* behavior classes, ARIA
 * roles, data-testid) before visible English text.
 *
 * Even on "classic" pages the shell around the Rails partial is React (e.g. the PR mergebox), so
 * the React-flavored rules live here too; the React variant reuses this classifier.
 *
 * Own-node filtering (events inside OctoDeck UI) happens in the actions capability.
 */
import type { GitHubActionType } from '../../capabilities/types';
import type { ActionAdapter } from '../types';

/** Ancestors of the event target, crossing shadow roots, plus the composed path. */
function pathElements(event: Event): Element[] {
  const out: Element[] = [];
  const seen = new Set<Element>();
  const push = (el: Element) => {
    if (seen.has(el)) return;
    seen.add(el);
    out.push(el);
  };
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const node of path) if (node instanceof Element) push(node);
  // composedPath() is empty for events constructed outside dispatch; walk from the target.
  let current: Element | null = (path[0] instanceof Element ? path[0] : null) ?? (event.target instanceof Element ? event.target : null);
  while (current) {
    push(current);
    if (current.parentElement) {
      current = current.parentElement;
    } else {
      const root = current.getRootNode();
      current = root instanceof ShadowRoot ? root.host : null;
    }
  }
  return out;
}

function targetOf(event: Event): Element | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const first = path[0];
  if (first instanceof Element) return first;
  return event.target instanceof Element ? event.target : null;
}

/** First element on the event path matching the selector. */
function closestOnPath(event: Event, selector: string): Element | null {
  for (const el of pathElements(event)) if (el.matches(selector)) return el;
  return null;
}

/** closest() that also crosses shadow-root boundaries upwards from a start element. */
function closestFrom(start: Element, selector: string): Element | null {
  let current: Element | null = start;
  while (current) {
    const found = current.closest(selector);
    if (found) return found;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

const attr = (el: Element | null | undefined, name: string) => el?.getAttribute(name) ?? '';
const lowerText = (el: Element) => (el.textContent ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

/** Forms whose submission is not a user write we care about. */
const IGNORED_FORMS = [
  'form.js-ajax-pagination', // Load more (expandAll clicks this)
  'form.js-pick-reaction', // emoji reactions
  'form.js-timeline-comment-minimize', // Hide comment
  'form.js-timeline-marker-form', // GitHub's own notification read marker
].join(', ');

interface FormSignals {
  action: string;
  className: string;
  id: string;
  testId: string;
}

function formSignals(form: Element): FormSignals {
  let action = attr(form, 'action');
  try {
    // Compare paths only, so query strings can't trigger matches.
    action = new URL(action, 'https://github.com').pathname;
  } catch {
    // Keep the raw value.
  }
  return { action, className: form.className || '', id: form.id || '', testId: attr(form, 'data-testid') };
}

function classifySubmit(event: Event): GitHubActionType | null {
  const form = closestOnPath(event, 'form');
  if (!form || form.matches(IGNORED_FORMS)) return null;
  const s = formSignals(form);

  if (
    s.className.includes('js-pull-request-review-submission-form') ||
    /\/pull_request_review|pull-request-review/.test(s.action) ||
    /pull-request-review|review-form/.test(s.testId)
  ) {
    return 'pr_review';
  }

  if (
    /js-merge-pull-request|js-pull-request-merge-form/.test(s.className) ||
    /\/merge$/.test(s.action) ||
    /merge-form|pull-request-merge/.test(s.testId)
  ) {
    return 'merge';
  }

  const submitter = (event as SubmitEvent).submitter ?? null;
  const submitName = attr(submitter, 'name');
  const submitValue = attr(submitter, 'value');
  if (
    submitName === 'comment_and_close' ||
    submitName === 'comment_and_reopen' ||
    submitValue === 'close' ||
    submitValue === 'reopen' ||
    /\/(close|reopen)$/.test(s.action)
  ) {
    return 'close_reopen';
  }

  if (
    s.className.includes('js-issue-sidebar-form') ||
    /\/(assignees|labels|milestone|set_milestone|reviewers|review-requests|projects)(\/|$)|\/projects\/issues\/|closing_references/.test(s.action) ||
    s.testId.includes('sidebar-form')
  ) {
    return 'assignee_label';
  }

  if (
    /js-new-comment-form|js-inline-comment-form|js-discussion-comment-form|js-comment-form|js-comment-update/.test(s.className) ||
    s.id === 'new_comment_form' ||
    /\/(comment|comments|review_comment)(\/|$)|\/issue_comments\//.test(s.action) ||
    /comment-form|new-comment/.test(s.testId) ||
    form.querySelector('textarea[name="comment[body]"]') !== null
  ) {
    return 'comment';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Keydown (Ctrl/Cmd+Enter in an editor; Enter/Space on picker options)
// ---------------------------------------------------------------------------

const PICKER_OPTION = [
  '[role="option"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '.js-assignee-picker-item',
  '.js-label-picker-item',
  '[data-testid*="picker-item" i]',
].join(', ');

const PICKER_CONTAINER = [
  '.js-assignee-picker',
  '.js-label-picker',
  '.js-issue-sidebar-form',
  '#assignees-select-menu',
  '#labels-select-menu',
  '[data-testid*="picker" i]',
  '[role="dialog"][aria-label*="assignee" i]',
  '[role="dialog"][aria-label*="label" i]',
  '[role="dialog"][aria-label*="reviewer" i]',
  '[role="dialog"][aria-label*="milestone" i]',
  '[role="dialog"][aria-label*="project" i]',
].join(', ');

const EDITOR = 'textarea, [contenteditable="true"], [contenteditable=""]';

function classifyKeydown(event: KeyboardEvent): GitHubActionType | null {
  if (event.key === 'Enter' || event.key === ' ') {
    if (closestOnPath(event, PICKER_OPTION) && closestOnPath(event, PICKER_CONTAINER)) return 'assignee_label';
  }
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return null;

  // Only real editors: Ctrl+Enter in search boxes or hidden inputs is not a comment.
  const editor = closestOnPath(event, EDITOR);
  if (!editor) return null;
  const name = attr(editor, 'name');
  const hints = `${attr(editor, 'aria-label')} ${attr(editor, 'placeholder')} ${attr(editor, 'data-testid')}`.toLowerCase();
  if (
    name.includes('pull_request_review') ||
    hints.includes('review') || // i18n-fragile: aria-label/placeholder text
    closestFrom(editor, '.js-pull-request-review-submission-form, [data-testid*="pull-request-review-form" i]') !== null
  ) {
    return 'pr_review';
  }
  return 'comment';
}

// ---------------------------------------------------------------------------
// Change (inputs inside sidebar pickers)
// ---------------------------------------------------------------------------

const SIDEBAR_FIELD_NAME = /assignee|label|milestone|reviewer|project/;

function classifyChange(event: Event): GitHubActionType | null {
  const target = targetOf(event);
  if (!target) return null;
  if (SIDEBAR_FIELD_NAME.test(attr(target, 'name'))) return 'assignee_label';
  return closestOnPath(event, PICKER_CONTAINER) ? 'assignee_label' : null;
}

// ---------------------------------------------------------------------------
// Click
// ---------------------------------------------------------------------------

/**
 * Controls a click can activate. Plain links and generic data-testid substrings are deliberately
 * excluded: they matched timeline containers and "learn more" links.
 */
const CLICKABLE = [
  'button',
  'input[type="submit"]',
  'input[type="button"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '.select-menu-item',
  '.SelectMenu-item',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[data-menu-trigger]',
  '.js-assignee-picker-item',
  '.js-label-picker-item',
].join(', ');

const SIDEBAR_REGION = [
  PICKER_CONTAINER,
  '.js-issue-sidebar-item',
  '[data-testid*="assignee-picker" i]',
  '[data-testid*="label-picker" i]',
].join(', ');

interface ClickSignals {
  el: Element;
  name: string;
  value: string;
  className: string;
  text: string;
  trigger: string;
  testId: string;
  ariaLabel: string;
  role: string;
  isSubmitLike: boolean;
}

function clickSignals(el: Element): ClickSignals {
  return {
    el,
    name: attr(el, 'name'),
    value: attr(el, 'value'),
    className: typeof el.className === 'string' ? el.className : '',
    text: lowerText(el),
    trigger: attr(el, 'data-menu-trigger'),
    testId: attr(el, 'data-testid'),
    ariaLabel: attr(el, 'aria-label').toLowerCase(),
    role: attr(el, 'role'),
    isSubmitLike: el.tagName === 'BUTTON' || (el instanceof HTMLInputElement && el.type === 'submit'),
  };
}

const SIDEBAR_TRIGGERS = new Set(['assignees', 'labels', 'reviewers', 'milestone']);

function isSidebarEdit(s: ClickSignals): boolean {
  const inSidebarRegion =
    SIDEBAR_TRIGGERS.has(s.trigger) ||
    /js-assignee-picker|js-label-picker/.test(s.className) ||
    /sidebar-(assignees|labels|reviewers|milestone)/.test(s.testId) ||
    /edit (assignees|labels|reviewers|milestone)/.test(s.ariaLabel) || // i18n-fragile
    closestFrom(s.el, SIDEBAR_REGION) !== null;
  if (!inSidebarRegion) return false;
  return (
    /select-menu-item|SelectMenu-item|js-(assignee|label|reviewer|milestone)-picker-item/.test(s.className) ||
    ['menuitemcheckbox', 'menuitemradio', 'option', 'checkbox'].includes(s.role) ||
    SIDEBAR_TRIGGERS.has(s.trigger) ||
    s.testId.includes('picker-item') ||
    s.el.tagName === 'INPUT' ||
    SIDEBAR_FIELD_NAME.test(s.name) ||
    /\b(apply|save|update|clear|remove)\b/.test(s.text) // i18n-fragile
  );
}

function isMerge(s: ClickSignals): boolean {
  return (
    /js-merge-commit-button|js-merge-pull-request/.test(s.className) ||
    /merge-button|confirm-merge|squash-button|rebase-button/.test(s.testId) ||
    // i18n-fragile: GitHub's mergebox button labels
    /^(merge pull request|confirm merge|squash and merge|confirm squash and merge|rebase and merge|confirm rebase and merge|enable auto-merge|enable auto-merge \(squash\)|enable auto-merge \(rebase\)|confirm auto-merge|merge when ready|merge without waiting for requirements to be met.*)$/.test(
      s.text
    )
  );
}

function isCloseReopen(s: ClickSignals): boolean {
  return (
    s.name === 'comment_and_close' ||
    s.name === 'comment_and_reopen' ||
    s.value === 'close' ||
    s.value === 'reopen' ||
    /close-issue|reopen-issue|close-pr|reopen-pr|close-button|reopen-button|convert-to-draft|ready-for-review/.test(s.testId) ||
    s.className.includes('js-comment-and-button') ||
    // i18n-fragile: close/reopen/draft button labels
    /^(close issue|close pull request|close with comment|close as completed|close as not planned|close as duplicate|reopen issue|reopen pull request|reopen with comment|convert to draft|ready for review)$/.test(
      s.text
    )
  );
}

function isReviewSubmit(s: ClickSignals): boolean {
  const reviewContext =
    /^submit review$|^submit pr review$/.test(s.text) || // i18n-fragile
    s.value.toLowerCase() === 'submit review' ||
    s.testId.includes('submit-review') ||
    s.ariaLabel.includes('submit review') || // i18n-fragile
    closestFrom(
      s.el,
      '.js-pull-request-review-submission-form, [data-testid*="pull-request-review-form" i], [data-testid*="review-submission" i], [data-testid*="review-dialog" i]'
    ) !== null;
  if (!reviewContext) return false;
  return (
    ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(s.value) ||
    s.name === 'pull_request_review[event]' ||
    s.testId.includes('review-event') ||
    s.isSubmitLike
  );
}

function isCommentSubmit(s: ClickSignals): boolean {
  return (
    /js-new-comment-button|js-reply-button|js-inline-comment-button|js-resolve-conversation-button/.test(s.className) ||
    /comment-button|submit-comment|reply-button|resolve-conversation/.test(s.testId) ||
    // i18n-fragile: comment button labels
    /^(comment|reply|post reply|add comment|post comment|start a review|add review comment|add single comment|update comment|save comment|resolve conversation|unresolve conversation)$/.test(
      s.text
    )
  );
}

function classifyClick(event: Event): GitHubActionType | null {
  const control = closestOnPath(event, CLICKABLE);
  if (!control) return null;
  const s = clickSignals(control);
  if (isSidebarEdit(s)) return 'assignee_label';
  if (isMerge(s)) return 'merge';
  if (isCloseReopen(s)) return 'close_reopen';
  if (isReviewSubmit(s)) return 'pr_review';
  if (isCommentSubmit(s)) return 'comment';
  return null;
}

/** Shared classifier; exported so the React variant can reuse it. */
export function classifyGitHubAction(event: Event): GitHubActionType | null {
  switch (event.type) {
    case 'submit':
      return classifySubmit(event);
    case 'keydown':
      return event instanceof KeyboardEvent ? classifyKeydown(event) : null;
    case 'change':
      return classifyChange(event);
    case 'click':
      return classifyClick(event);
    default:
      return null;
  }
}

export const classicActionAdapter: ActionAdapter = {
  classify: classifyGitHubAction,
};
