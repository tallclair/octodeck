/**
 * Classic (Rails) conversation markup: locators for every anchor this variant supports.
 * Observed on classic-pr-141014 (a Rails conversation partial inside GitHub's React shell).
 */
import type { AnchorId, Locator } from '../../dom/types';
import { GITHUB_META_LOCATORS } from '../shared';

/** Classic timeline entries are .js-timeline-item elements carrying the GraphQL node id in data-gid. */
const ITEM_SELECTOR = '.js-timeline-item[data-gid]';

export const CLASSIC_ANCHORS = {
  ...GITHUB_META_LOCATORS,
  // Every element on the page that names the item by node id; allEqual rejects pages where they disagree.
  'page.identity': {
    selectors: ['[data-gid^="PR_"], [data-gid^="I_"]'],
    value: (el) => el.getAttribute('data-gid'),
  },
  // The sidebar scope root is the parent of #partial-discussion-sidebar, so our section (inserted
  // before the partial, outside GitHub's AJAX-replaced subtree) stays inside the scope.
  'sidebar.root': { selectors: ['#partial-discussion-sidebar'], map: (el) => el.parentElement },
  'sidebar.insertBefore': { selectors: ['#partial-discussion-sidebar'] },
  'composer.root': { selectors: ['#issuecomment-new'] },
  'composer.submit': {
    selectors: [
      '#partial-new-comment-form-actions button.btn-primary[type="submit"]',
      'form.js-new-comment-form button.btn-primary[type="submit"]',
    ],
  },
  'timeline.root': { selectors: ['.js-discussion'] },
  'timeline.item': {
    selectors: [ITEM_SELECTOR],
    // Only top-level entries: never an item nested inside another item.
    validate: (el) => !el.parentElement?.closest(ITEM_SELECTOR),
  },
  // Rows inside grouped event items ("added labels", "requested review", ...): no node id of their own.
  'timeline.row': { selectors: ['[id^="event-"]'], validate: (el) => /^event-\d+$/.test(el.id) },
  // The item's own body: review-thread comments inside a review item are not the review's body.
  'timeline.itemBody': {
    selectors: ['.comment-body'],
    validate: (el) => !el.closest('review-thread-collapsible, .js-comments-holder, .js-inline-comments-container'),
  },
  'timeline.itemAuthor': { selectors: ['a.author'] },
  'timeline.itemTime': { selectors: ['relative-time[datetime]'] },
  // Hidden content (section 9.1). Read by the classic load adapter (variants/classic/load.ts).
  'timeline.hiddenRange': { selectors: ['#js-progressive-timeline-item-container form.js-ajax-pagination'] },
  'timeline.collapsedThread': { selectors: ['review-thread-collapsible[data-hidden-comment-ids]'] },
  'timeline.hiddenComments': { selectors: ['.js-thread-hidden-comment-ids, .js-review-hidden-comment-ids'] },
  // The range's "Load more…" button: of the pagination form's submit buttons, only the loader
  // carries GitHub's in-flight label (data-disable-with); the "N hidden items" button does not.
  'timeline.loadMoreControl': { selectors: ['form.js-ajax-pagination button[type="submit"][data-disable-with]'] },
} satisfies Partial<Record<AnchorId, Locator>>;
