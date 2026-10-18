import { afterEach, describe, expect, it } from 'vitest';
import { classicActionAdapter } from '../content/variants/classic/actions';
import { reactActionAdapter } from '../content/variants/react/actions';
import type { GitHubActionType } from '../content/capabilities/types';
import type { ActionAdapter } from '../content/variants/types';
import { loadFixture, resetFixture } from './fixtureHarness';

/** Dispatches a real event on `el` and returns what the adapter classifies at capture time. */
function classifyDispatch(adapter: ActionAdapter, el: Element, event: Event): GitHubActionType | null {
  let result: GitHubActionType | null = null;
  const listener = (e: Event) => {
    result = adapter.classify(e);
    e.preventDefault();
  };
  document.addEventListener(event.type, listener, true);
  el.dispatchEvent(event);
  document.removeEventListener(event.type, listener, true);
  return result;
}

const click = (adapter: ActionAdapter, el: Element) =>
  classifyDispatch(adapter, el, new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
const submit = (adapter: ActionAdapter, form: Element, submitter?: HTMLElement) => {
  const e = new Event('submit', { bubbles: true, cancelable: true, composed: true });
  if (submitter) Object.defineProperty(e, 'submitter', { value: submitter });
  return classifyDispatch(adapter, form, e);
};
const ctrlEnter = (adapter: ActionAdapter, el: Element, meta = false) =>
  classifyDispatch(adapter, el, new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: !meta, metaKey: meta, bubbles: true, composed: true }));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) e.setAttribute(k, v);
  e.textContent = text;
  return e;
}

/** Counts classifications over every clickable on the page (the audit's false-positive probe). */
function classifyAllClicks(adapter: ActionAdapter): Map<string, GitHubActionType> {
  const out = new Map<string, GitHubActionType>();
  const clickables = document.querySelectorAll('button, a, input:not([type="hidden"]), [role="option"], [role="menuitem"], [role="menuitemcheckbox"], summary');
  clickables.forEach((node, i) => {
    const r = click(adapter, node);
    if (r) out.set(`${i}:${(node.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40) || node.outerHTML.slice(0, 160)}`, r);
  });
  return out;
}

describe('classic action adapter on classic-pr-141014', () => {
  afterEach(() => resetFixture());

  it('classifies only real write controls among all clickables', async () => {
    await loadFixture('classic-pr-141014');
    // Project-status menu items live inside sidebar forms; choosing one is a sidebar edit.
    const sidebarItems = new Set(
      Array.from(document.querySelectorAll('.js-issue-sidebar-form .SelectMenu-item')).map((n) => (n.textContent ?? '').trim())
    );
    const hits = classifyAllClicks(classicActionAdapter);
    expect(hits.size).toBeGreaterThan(0);
    for (const [label, type] of hits) {
      const text = label.replace(/^\d+:/, '');
      if (text === 'Comment') expect(type).toBe('comment');
      else {
        expect(sidebarItems.has(text), `unexpected classification of "${text}" as ${type}`).toBe(true);
        expect(type).toBe('assignee_label');
      }
    }
  });

  it('classifies form submits structurally', async () => {
    await loadFixture('classic-pr-141014');
    const byClass = (cls: string) => document.querySelector(`form.${cls}`) as HTMLFormElement;
    expect(submit(classicActionAdapter, byClass('js-new-comment-form'))).toBe('comment');
    expect(submit(classicActionAdapter, byClass('js-inline-comment-form'))).toBe('comment');
    for (const f of Array.from(document.querySelectorAll('form.js-issue-sidebar-form'))) {
      expect(submit(classicActionAdapter, f)).toBe('assignee_label');
    }
    // Not writes we track: Load more (expandAll), reactions, "Hide comment".
    expect(submit(classicActionAdapter, byClass('js-ajax-pagination'))).toBeNull();
    for (const sel of ['form.js-pick-reaction', 'form.js-timeline-comment-minimize']) {
      const f = document.querySelector(sel);
      if (f) expect(submit(classicActionAdapter, f)).toBeNull();
    }
  });

  it('treats Ctrl+Enter in comment textareas as a comment but ignores plain inputs', async () => {
    await loadFixture('classic-pr-141014');
    const ta = document.querySelector('textarea[name="comment[body]"]')!;
    expect(ctrlEnter(classicActionAdapter, ta)).toBe('comment');
    for (const input of Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))) {
      expect(ctrlEnter(classicActionAdapter, input)).toBeNull();
    }
  });

  it('ignores clicks on GitHub\'s Load more control', async () => {
    await loadFixture('classic-pr-141014');
    for (const b of Array.from(document.querySelectorAll('form.js-ajax-pagination button'))) {
      expect(click(classicActionAdapter, b)).toBeNull();
    }
  });
});

describe('react action adapter on react-issue-142957 (no forms)', () => {
  afterEach(() => resetFixture());

  it('classifies "Comment" and "Close issue" and nothing else', async () => {
    await loadFixture('react-issue-142957');
    const hits = Array.from(classifyAllClicks(reactActionAdapter).entries()).map(([label, type]) => [label.replace(/^\d+:/, ''), type]);
    expect(hits).toEqual(
      expect.arrayContaining([
        ['Comment', 'comment'],
        ['Close issue', 'close_reopen'],
      ])
    );
    expect(hits).toHaveLength(2);
  });

  it('treats Ctrl/Cmd+Enter in the composer as a comment', async () => {
    await loadFixture('react-issue-142957');
    const ta = document.querySelector('[data-testid="comment-composer"] textarea')!;
    expect(ctrlEnter(reactActionAdapter, ta)).toBe('comment');
    expect(ctrlEnter(reactActionAdapter, ta, true)).toBe('comment');
  });
});

describe('classifier rules (synthetic markup)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });
  const a = classicActionAdapter;
  const mount = <T extends Element>(node: T): T => document.body.appendChild(node);

  it('comments', () => {
    const form = mount(el('form'));
    form.appendChild(el('textarea', { name: 'comment[body]' }));
    expect(submit(a, form)).toBe('comment');
    for (const label of ['Comment', 'Reply', 'Start a review', 'Resolve conversation', 'Add single comment']) {
      expect(click(a, mount(el('button', {}, label)))).toBe('comment');
    }
    const editor = mount(el('div', { contenteditable: 'true', 'data-testid': 'new-comment' }));
    expect(ctrlEnter(a, editor)).toBe('comment');
  });

  it('PR reviews', () => {
    expect(submit(a, mount(el('form', { class: 'js-pull-request-review-submission-form' })))).toBe('pr_review');
    expect(click(a, mount(el('button', {}, 'Submit review')))).toBe('pr_review');
    expect(ctrlEnter(a, mount(el('textarea', { name: 'pull_request_review[body]' })))).toBe('pr_review');
    const form = mount(el('form', { class: 'js-pull-request-review-submission-form' }));
    const approve = form.appendChild(el('button', { type: 'submit', name: 'pull_request_review[event]', value: 'APPROVE' }, 'Approve'));
    expect(click(a, approve)).toBe('pr_review');
  });

  it('merges', () => {
    for (const label of ['Merge pull request', 'Squash and merge', 'Confirm merge', 'Enable auto-merge']) {
      expect(click(a, mount(el('button', {}, label)))).toBe('merge');
    }
    expect(submit(a, mount(el('form', { class: 'js-merge-pull-request' })))).toBe('merge');
    // A link that merely mentions auto-merge is not a merge.
    expect(click(a, mount(el('a', { href: '/docs' }, 'Learn more about auto-merge')))).toBeNull();
  });

  it('close / reopen / draft state', () => {
    expect(click(a, mount(el('button', { value: 'close' }, 'Close issue')))).toBe('close_reopen');
    expect(click(a, mount(el('button', { value: 'reopen' }, 'Reopen pull request')))).toBe('close_reopen');
    for (const label of ['Close as completed', 'Close as not planned', 'Ready for review', 'Convert to draft', 'Close with comment']) {
      expect(click(a, mount(el('button', {}, label)))).toBe('close_reopen');
    }
    const form = mount(el('form', { action: '/o/r/issues/1' }));
    const btn = form.appendChild(el('button', { type: 'submit', name: 'comment_and_close' }, 'Close with comment'));
    expect(submit(a, form, btn)).toBe('close_reopen');
  });

  it('sidebar edits', () => {
    const picker = mount(el('div', { class: 'js-assignee-picker' }));
    expect(click(a, picker.appendChild(el('div', { class: 'select-menu-item' }, 'octocat')))).toBe('assignee_label');
    expect(click(a, mount(el('button', { 'data-menu-trigger': 'reviewers' })))).toBe('assignee_label');
    const change = new Event('change', { bubbles: true });
    expect(classifyDispatch(a, mount(el('input', { name: 'issue[label_names][]' })), change)).toBe('assignee_label');
    const dialog = mount(el('div', { role: 'dialog', 'aria-label': 'Assignees' }));
    const option = dialog.appendChild(el('li', { role: 'option' }, 'octocat'));
    expect(click(a, option)).toBe('assignee_label');
    expect(classifyDispatch(a, option, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))).toBe('assignee_label');
    expect(click(a, mount(el('button', { class: 'js-assignee-picker-item' }, 'Clear assignees')))).toBe('assignee_label');
    expect(submit(a, mount(el('form', { action: '/o/r/issues/1/set_milestone?partial=x' })))).toBe('assignee_label');
  });

  it('sees through shadow roots via composedPath', () => {
    const host = mount(el('div'));
    const root = host.attachShadow({ mode: 'open' });
    const form = root.appendChild(el('form', { class: 'js-pull-request-review-submission-form' }));
    const button = form.appendChild(el('button', {}, 'Submit review'));
    expect(click(a, button)).toBe('pr_review');
    expect(submit(a, form)).toBe('pr_review');
  });

  it('ignores unrelated events', () => {
    expect(click(a, mount(el('div', {}, 'Some normal text')))).toBeNull();
    expect(click(a, mount(el('a', { href: '/o/r/issues?q=label%3Abug' }, 'bug')))).toBeNull();
    const ta = mount(el('textarea', { name: 'comment[body]' }));
    expect(classifyDispatch(a, ta, new KeyboardEvent('keydown', { key: 'a', bubbles: true }))).toBeNull();
    expect(ctrlEnter(a, mount(el('input', { type: 'text', name: 'q' })))).toBeNull();
    // Query strings must not trigger path rules.
    expect(submit(a, mount(el('form', { action: '/search?return_to=/o/r/issues/1/labels' })))).toBeNull();
  });
});
