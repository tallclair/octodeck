/**
 * React issue-viewer markup: locators for every anchor this variant supports.
 * Observed on react-issue-142957.
 */
import type { AnchorId, Locator } from '../../dom/types';
import { GITHUB_META_LOCATORS } from '../shared';

/** Marker present only on pages rendered by the React issue viewer (used to keep page detectors exclusive). */
export const REACT_ISSUE_VIEWER_SELECTOR = '[data-testid="issue-viewer-issue-container"]';

/** Reads the issue's node id from the react-app embedded payload, or null. */
function embeddedIssueId(el: Element): string | null {
  try {
    const data = JSON.parse(el.textContent || '') as {
      payload?: { issueViewerRoute?: { data?: { repository?: { issue?: { id?: unknown } } } } };
    };
    const id = data.payload?.issueViewerRoute?.data?.repository?.issue?.id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

export const REACT_ANCHORS = {
  ...GITHUB_META_LOCATORS,
  'page.identity': {
    selectors: ['script[data-target="react-app.embeddedData"]'],
    validate: (el) => embeddedIssueId(el) !== null,
    value: embeddedIssueId,
  },
  'sidebar.root': { selectors: ['[data-testid="issue-viewer-metadata-pane"]'] },
  // The first sidebar section; our section goes above it.
  'sidebar.insertBefore': { selectors: ['[data-testid="sidebar-assignees-section"]'] },
  // The new-comment composer. Editing an existing comment renders another comment-composer inside
  // the timeline (or issue body); those must never count, or the scope turns ambiguous mid-edit.
  'composer.root': {
    selectors: ['#react-issue-comment-composer', '[data-testid="comment-composer"]'],
    validate: (el) => el.closest('[data-testid="issue-timeline-container"], [data-testid="issue-body"]') === null,
  },
  'composer.submit': { selectors: ['button[data-variant="primary"]'] },
  'timeline.root': { selectors: ['[data-testid="issue-timeline-container"]'] },
  'timeline.item': { selectors: [':scope > li[data-wrapper-timeline-id]'] },
  'timeline.itemBody': { selectors: ['[data-testid="markdown-body"]'] },
  // Comment headers use avatar-link; event rows use actor-link.
  'timeline.itemAuthor': { selectors: ['[data-testid="avatar-link"], [data-testid="actor-link"]'] },
  'timeline.itemTime': { selectors: ['relative-time[datetime]'] },
} satisfies Partial<Record<AnchorId, Locator>>;
