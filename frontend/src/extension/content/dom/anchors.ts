import type { AnchorDef, AnchorId } from './types';

/**
 * Variant-independent anchor registry: ids, scope, cardinality and presence rules.
 *
 * No selectors live here; each variant module contributes its own Locator per anchor
 * (docs/internal/extension_dom_engine_design.md section 4.3).
 */
export const ANCHORS: { readonly [K in AnchorId]: AnchorDef & { id: K } } = {
  'page.identity': {
    id: 'page.identity',
    scope: 'page',
    cardinality: 'allEqual',
    presence: { issue: 'optional', 'pr-conversation': 'optional', 'pr-subtab': 'optional' },
  },
  'page.repo': {
    id: 'page.repo',
    scope: 'page',
    cardinality: 'one',
    presence: { issue: 'optional', 'pr-conversation': 'optional', 'pr-subtab': 'optional' },
  },
  'page.viewer': {
    id: 'page.viewer',
    scope: 'page',
    cardinality: 'zeroOrOne',
    presence: { issue: 'optional', 'pr-conversation': 'optional', 'pr-subtab': 'optional' },
  },
  'page.release': {
    id: 'page.release',
    scope: 'page',
    cardinality: 'zeroOrOne',
    presence: { issue: 'optional', 'pr-conversation': 'optional', 'pr-subtab': 'optional' },
  },
  'sidebar.root': {
    id: 'sidebar.root',
    scope: 'sidebar',
    cardinality: 'one',
    presence: { issue: 'required', 'pr-conversation': 'required', 'pr-subtab': 'absent' },
  },
  'sidebar.insertBefore': {
    id: 'sidebar.insertBefore',
    scope: 'sidebar',
    cardinality: 'one',
    presence: { issue: 'required', 'pr-conversation': 'required', 'pr-subtab': 'absent' },
  },
  'composer.root': {
    id: 'composer.root',
    scope: 'composer',
    cardinality: 'zeroOrOne',
    presence: { issue: 'required', 'pr-conversation': 'required', 'pr-subtab': 'absent' },
    absentWhen: (page) => !page.signedIn || page.locked === true || page.archived === true,
  },
  'composer.submit': {
    id: 'composer.submit',
    scope: 'composer',
    cardinality: 'zeroOrOne',
    presence: { issue: 'required', 'pr-conversation': 'required', 'pr-subtab': 'absent' },
    absentWhen: (page) => !page.signedIn || page.locked === true || page.archived === true,
  },
  'timeline.root': {
    id: 'timeline.root',
    scope: 'timeline',
    cardinality: 'one',
    presence: { issue: 'required', 'pr-conversation': 'required', 'pr-subtab': 'absent' },
  },
  'timeline.item': {
    id: 'timeline.item',
    scope: 'timeline',
    cardinality: 'many',
    presence: { issue: 'optional', 'pr-conversation': 'optional', 'pr-subtab': 'absent' },
  },
  'timeline.row': {
    id: 'timeline.row',
    scope: 'timeline',
    cardinality: 'many',
    presence: { issue: 'optional', 'pr-conversation': 'optional', 'pr-subtab': 'absent' },
  },
  'timeline.itemBody': {
    id: 'timeline.itemBody',
    scope: 'timeline',
    cardinality: 'zeroOrOne',
    presence: { issue: 'optional', 'pr-conversation': 'optional', 'pr-subtab': 'absent' },
  },
  'timeline.itemAuthor': {
    id: 'timeline.itemAuthor',
    scope: 'timeline',
    cardinality: 'zeroOrOne',
    presence: { issue: 'optional', 'pr-conversation': 'optional', 'pr-subtab': 'absent' },
  },
  'timeline.itemTime': {
    id: 'timeline.itemTime',
    scope: 'timeline',
    cardinality: 'zeroOrOne',
    presence: { issue: 'optional', 'pr-conversation': 'optional', 'pr-subtab': 'absent' },
  },
  'timeline.hiddenRange': {
    id: 'timeline.hiddenRange',
    scope: 'timeline',
    cardinality: 'many',
    presence: { issue: 'optional', 'pr-conversation': 'optional', 'pr-subtab': 'absent' },
  },
  'timeline.collapsedThread': {
    id: 'timeline.collapsedThread',
    scope: 'timeline',
    cardinality: 'many',
    presence: { issue: 'optional', 'pr-conversation': 'optional', 'pr-subtab': 'absent' },
  },
  'timeline.hiddenComments': {
    id: 'timeline.hiddenComments',
    scope: 'timeline',
    cardinality: 'many',
    presence: { issue: 'optional', 'pr-conversation': 'optional', 'pr-subtab': 'absent' },
  },
  // GitHub's own "Load more" button of a hidden range. Resolved inside each range segment, where
  // the timeline capability requires exactly one match (and reports anything else as drift).
  'timeline.loadMoreControl': {
    id: 'timeline.loadMoreControl',
    scope: 'timeline',
    cardinality: 'many',
    presence: { issue: 'optional', 'pr-conversation': 'optional', 'pr-subtab': 'absent' },
  },
};
