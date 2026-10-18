/**
 * Helpers shared by variant modules. Generic DOM reads only; variant-specific selectors stay in
 * each variant's own files.
 */
import type { TimelineItemKind } from '../capabilities/types';
import type { AnchorId, Locator } from '../dom/types';

/**
 * DOM ids GitHub uses as URL-hash targets for timeline content. Ids with suffixes such as
 * "-permalink" or "-edit-form", and the composer's "issuecomment-new", are deliberately excluded.
 */
const ANCHOR_ID = /^(?:issuecomment-\d+|discussion_r\d+|pullrequestreview-\d+|event-\d+|issue-\d+|pullrequest-\d+|ref-(?:pullrequest|issue|commit)-[0-9a-f]+|commits-pushed-[0-9a-f]+)$/;

/** True when a DOM id is a timeline hash target. */
export function isAnchorId(id: string): boolean {
  return ANCHOR_ID.test(id);
}

/** Hash-target ids on the element and its descendants, in document order, de-duplicated. */
export function collectAnchors(el: Element): string[] {
  const out: string[] = [];
  const push = (id: string) => {
    if (id && isAnchorId(id) && !out.includes(id)) out.push(id);
  };
  push(el.id);
  for (const child of Array.from(el.querySelectorAll('[id]'))) push(child.id);
  return out;
}

/** Parses a datetime attribute to epoch ms, or null. */
export function parseDatetime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * First element matching a locator's selectors (in order) inside `base`, applying validate and
 * map. For per-item reads inside an already-resolved element, where cardinality checks don't apply
 * (e.g. a review item legitimately contains several comment bodies).
 */
export function firstIn(base: Element, locator: Locator): Element | null {
  for (const selector of locator.selectors) {
    for (const el of Array.from(base.querySelectorAll(selector))) {
      if (locator.validate && !locator.validate(el)) continue;
      const mapped = locator.map ? locator.map(el) : el;
      if (mapped) return mapped;
    }
  }
  return null;
}

/**
 * The single value shared by every match of an `allEqual`-style locator (first selector that
 * matches), or null when there are no matches or they disagree.
 */
export function allEqualValue(base: ParentNode, locator: Locator): string | null {
  for (const selector of locator.selectors) {
    const els = Array.from(base.querySelectorAll(selector)).filter((el) => !locator.validate || locator.validate(el));
    if (els.length === 0) continue;
    const values = new Set(els.map((el) => (locator.value ? locator.value(el) : null)));
    if (values.size !== 1 || values.has(null)) return null;
    return [...values][0];
  }
  return null;
}

/** Login from a profile or app link: its text, else the last path segment of its href. */
export function loginFromLink(link: Element): string | null {
  const text = link.textContent?.trim().replace(/^@/, '');
  if (text && !/\s/.test(text)) return text;
  const href = link.getAttribute('href') || '';
  const m = /\/(?:apps\/)?([^/?#]+)\/?(?:[?#].*)?$/.exec(href);
  return m ? decodeURIComponent(m[1]) : null;
}

/** True when a link points at a GitHub App (decision 13: App authors are bots). */
export function isAppLink(link: Element): boolean {
  const href = link.getAttribute('href') || '';
  return /^(?:https:\/\/github\.com)?\/apps\//.test(href);
}

/** Reads a <meta name="..."> content value through a resolved element. */
export function metaContent(el: Element | null): string | null {
  const v = el?.getAttribute('content')?.trim();
  return v ? v : null;
}

/**
 * Page-scope locators for GitHub's site-wide <meta> tags, identical in every variant observed so
 * far. Variants spread these into their anchors and override where they differ.
 */
export const GITHUB_META_LOCATORS = {
  'page.repo': { selectors: ['meta[name="octolytics-dimension-repository_nwo"]'], validate: (el) => metaContent(el) !== null },
  'page.viewer': { selectors: ['meta[name="user-login"]'], validate: (el) => metaContent(el) !== null },
  'page.release': { selectors: ['meta[name="release"]'], validate: (el) => metaContent(el) !== null },
} satisfies Partial<Record<AnchorId, Locator>>;

/** True for GitHub's "bot" label rendered next to an author link (classic span.Label, Primer React Label). */
export function isBotLabel(el: Element | null): boolean {
  if (!el) return false;
  const isLabel = el.classList.contains('Label') || el.getAttribute('data-component') === 'Label';
  return isLabel && el.textContent?.trim().toLowerCase() === 'bot';
}

/**
 * Whether a bot label directly follows the author link (or its single-child wrapper). Adjacency
 * keeps another account's badge in the same row from being attributed to this author.
 */
export function hasAdjacentBotLabel(link: Element): boolean {
  if (isBotLabel(link.nextElementSibling)) return true;
  const parent = link.parentElement;
  return Boolean(parent && parent.childElementCount === 1 && isBotLabel(parent.nextElementSibling));
}

/**
 * Octicon on a timeline event badge -> kind. Structural fallback for rows without a usable node id
 * (classic grouped-item rows; any row whose GID prefix is not mapped yet). 'event' rows are the ones "Hide events" may hide (decision 11 as amended on the board, #57).
 * Icons not listed here map to null, i.e. 'unknown', which is never hidden.
 */
export const OCTICON_KINDS: Readonly<Record<string, TimelineItemKind>> = {
  'octicon-tag': 'event', // labeled / unlabeled
  'octicon-person': 'event', // assigned / unassigned
  'octicon-eye': 'event', // review requested, ready for review
  'octicon-pencil': 'event', // renamed title
  'octicon-milestone': 'event',
  'octicon-table': 'event', // projects
  'octicon-project': 'event',
  'octicon-repo-push': 'event', // force-pushed
  'octicon-git-pull-request-draft': 'event', // converted to draft
  'octicon-git-branch': 'event', // head branch deleted / restored, base branch changed
  'octicon-lock': 'event',
  'octicon-key': 'event', // unlocked
  'octicon-pin': 'event',
  'octicon-rocket': 'event', // deployed
  'octicon-git-commit': 'commit',
  'octicon-x': 'otherEvent', // review dismissed
  'octicon-issue-closed': 'closeReopen',
  'octicon-issue-reopened': 'closeReopen',
  'octicon-git-pull-request-closed': 'closeReopen',
  'octicon-git-merge': 'closeReopen',
  'octicon-circle-slash': 'closeReopen',
  'octicon-skip': 'closeReopen', // closed as not planned
  'octicon-cross-reference': 'reference',
  'octicon-bookmark': 'reference',
  'octicon-link-external': 'reference', // React cross-reference badge
};

/** Kind from a badge icon element's octicon-* classes, or null. */
export function kindFromOcticon(icon: Element | null): TimelineItemKind | null {
  if (!icon) return null;
  for (const cls of Array.from(icon.classList)) {
    const kind = OCTICON_KINDS[cls];
    if (kind) return kind;
  }
  return null;
}
