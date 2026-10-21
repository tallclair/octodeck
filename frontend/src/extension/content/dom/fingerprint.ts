/**
 * Sanitized structural fingerprint of a DOM subtree, attached to drift diagnostics
 * (docs/internal/extension_dom_engine_design.md section 10.3).
 *
 * The output shows a developer what GitHub's markup looked like where an anchor was expected,
 * without leaking page content: one node per line, indented by depth, as
 * `tag#id.class1.class2[data-testid=value][role=value][aria-label?]`. Each line is itself a usable
 * selector candidate when updating variants/.
 *
 * Privacy rules:
 * - No text nodes, ever. User-content subtrees (rendered markdown, comment bodies) are skipped
 *   entirely, because even their attributes (e.g. id="user-content-<heading text>") carry text.
 * - Attribute values are kept only for data-testid, role and type, and for ids the DOM contract
 *   itself references (FingerprintOptions.knownIds). Every other attribute appears by name only.
 * - Digit runs become '#', GraphQL node ids are cut to their typename prefix, and generated
 *   (hashed) CSS-module class suffixes collapse to '*'.
 */
import { OWN_SELECTOR } from '../engine/constants';

export interface FingerprintOptions {
  /** Levels below root to include (root is depth 0). */
  depth?: number;
  /** Maximum number of element lines. */
  maxNodes?: number;
  /**
   * Id values (exact, or prefixes ending in '-' / '_' for numbered ids such as 'issuecomment-')
   * that may be shown. Every other id appears by name only, because ids can embed user text
   * (e.g. GitHub's 'awaiting-review-<login>'). Typically built with idsFromSelectors() from the
   * contract's own locators.
   */
  knownIds?: ReadonlySet<string>;
  /** Interactive descendants listed after the tree when deeper than `depth` (default 8). */
  maxInteractive?: number;
}

/** Controls listed after the tree (see fingerprint()). */
const INTERACTIVE_SELECTOR = 'button, [role="button"], textarea, [contenteditable="true"], [contenteditable=""], input, summary';
const DEFAULT_MAX_INTERACTIVE = 8;

/** Hard cap on the fingerprint length; the background rejects anything longer. */
export const FINGERPRINT_MAX_CHARS = 2048;

const DEFAULT_DEPTH = 3;
const DEFAULT_MAX_NODES = 40;

/** Subtrees holding user-authored content; never descended into. */
const USER_CONTENT_SELECTOR = '.markdown-body, [data-testid="markdown-body"], .comment-body';

/** Attributes whose (normalized) values are structural and safe to keep. */
const VALUE_ATTRS = ['data-testid', 'role', 'type'] as const;

/** Attributes listed by name only (presence is a useful structural signal; values may be text). */
const NAME_ONLY_ATTRS = ['aria-label', 'href', 'data-gid', 'data-hovercard-type', 'data-url'] as const;

/**
 * GraphQL global node ids: a typename prefix (e.g. IC_, PRR_, PR_, I_) followed by an opaque
 * base64url-ish payload. Matched where they appear inside ids and test ids.
 */
const GRAPHQL_ID = /\b([A-Z]{1,5}_)[A-Za-z0-9_-]{6,}/g;

/**
 * CSS-module / styled class names end in a generated hash, e.g. `prc-Button-ButtonBase-c50BI`,
 * `sidebarContent__Ab12c` or `PageHeader_Title__RB_Qdt`. The hash is 5+ characters after '-'
 * (alphanumeric) or '__' (may also contain '_' and '-'). A tail counts as generated only when it
 * contains a digit or mixes case unlike a plain word, so ordinary classes such as
 * `js-timeline-item` or `Box-row__title` are kept as-is.
 */
const MODULE_CLASS = /^(.*?__)([\w-]{5,})$/;
const HASHED_CLASS = /^(.*?-)([A-Za-z0-9]{5,})$/;

function looksGenerated(tail: string): boolean {
  return /\d/.test(tail) || (/[A-Z]/.test(tail) && /[a-z]/.test(tail) && !/^[A-Z][a-z]+$/.test(tail));
}

/** Masks digits and GraphQL ids in an attribute value. */
export function maskValue(value: string): string {
  return value.replace(GRAPHQL_ID, '$1*').replace(/\d+/g, '#');
}

/** Collapses a generated class suffix to '*', keeping the readable stem. */
export function normalizeClass(token: string): string {
  for (const pattern of [MODULE_CLASS, HASHED_CLASS]) {
    const m = pattern.exec(token);
    if (m && looksGenerated(m[2])) return `${m[1]}*`;
  }
  return token.replace(/\d+/g, '#');
}

/** Characters that may appear in a fingerprint (also enforced by the background). */
const SAFE_CHARS = /[^\w\-#.*[\]=?:> \n]/g;

function clean(s: string): string {
  return s.replace(SAFE_CHARS, '');
}

/**
 * Returns true when an id may be shown: it is listed in knownIds, or it is a numbered id whose
 * prefix is listed (e.g. 'issuecomment-' allows 'issuecomment-123', shown masked).
 */
function isKnownId(id: string, knownIds: ReadonlySet<string> | undefined): boolean {
  if (!knownIds) return false;
  if (knownIds.has(id)) return true;
  const numbered = /^(.*?[-_]r?)(\d+)$/.exec(id);
  return Boolean(numbered && knownIds.has(numbered[1]));
}

function describe(el: Element, knownIds: ReadonlySet<string> | undefined): string {
  let out = el.tagName.toLowerCase();

  const id = el.getAttribute('id');
  if (id) {
    out += isKnownId(id, knownIds) ? `#${maskValue(id)}` : '[id?]';
  }

  const classes = Array.from(el.classList)
    .map(normalizeClass)
    .filter((c, i, all) => c && all.indexOf(c) === i);
  if (classes.length > 0) out += `.${classes.join('.')}`;

  for (const name of VALUE_ATTRS) {
    const v = el.getAttribute(name);
    if (v !== null) out += `[${name}=${maskValue(v)}]`;
  }
  for (const name of NAME_ONLY_ATTRS) {
    if (el.hasAttribute(name)) out += `[${name}?]`;
  }
  return clean(out);
}

/**
 * Returns the sanitized structure of `root` and its descendants (depth-first, document order),
 * capped at FINGERPRINT_MAX_CHARS. Returns '' for an OctoDeck-owned root.
 */
export function fingerprint(root: Element, opts: FingerprintOptions = {}): string {
  const maxDepth = opts.depth ?? DEFAULT_DEPTH;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  if (root.closest(OWN_SELECTOR)) return '';

  const lines: string[] = [];
  const printed = new Set<Element>();
  let length = 0;
  let truncated = false;

  const visit = (el: Element, depth: number): void => {
    if (truncated) return;
    if (lines.length >= maxNodes) {
      truncated = true;
      return;
    }
    const userContent = el.matches(USER_CONTENT_SELECTOR);
    const line = `${'  '.repeat(depth)}${describe(el, opts.knownIds)}${userContent ? ' [content]' : ''}`;
    if (length + line.length + 1 > FINGERPRINT_MAX_CHARS - 4) {
      truncated = true;
      return;
    }
    lines.push(line);
    printed.add(el);
    length += line.length + 1;
    if (userContent || depth >= maxDepth) return;
    for (const child of Array.from(el.children)) {
      if (child.matches(OWN_SELECTOR)) continue;
      visit(child, depth + 1);
    }
  };

  visit(root, 0);
  if (truncated) {
    lines.push('...');
    length += 4;
  }

  // Controls deeper than the tree shows are where a missing anchor (e.g. a submit button) would
  // most likely have moved; list a few of them, flat, marked with '> '. One lazy walk that skips
  // user-content and own subtrees wholesale and stops as soon as enough controls are found.
  const maxInteractive = root.closest(USER_CONTENT_SELECTOR) ? 0 : (opts.maxInteractive ?? DEFAULT_MAX_INTERACTIVE);
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      const el = node as Element;
      if (el.matches(OWN_SELECTOR) || el.matches(USER_CONTENT_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return el.matches(INTERACTIVE_SELECTOR) && !printed.has(el) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let found = 0, node = walker.nextNode(); node && found < maxInteractive; node = walker.nextNode(), found++) {
    const line = `> ${describe(node as Element, opts.knownIds)}`;
    if (length + line.length + 1 > FINGERPRINT_MAX_CHARS) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n');
}

/** Line separating the roots of a multi-root fingerprint. */
const ROOT_SEPARATOR = '--';

/** Fingerprints several roots (e.g. the first matches of an ambiguous anchor), sharing the budget. */
export function fingerprintAll(roots: readonly Element[], opts: FingerprintOptions = {}): string {
  const parts: string[] = [];
  let remaining = FINGERPRINT_MAX_CHARS;
  for (const root of roots.slice(0, 2)) {
    const fp = fingerprint(root, opts);
    const cost = fp.length + ROOT_SEPARATOR.length + 2;
    if (!fp || cost > remaining) break;
    parts.push(fp);
    remaining -= cost;
  }
  return parts.join(`\n${ROOT_SEPARATOR}\n`);
}

/**
 * Collects the ids a set of CSS selectors refers to, for FingerprintOptions.knownIds: exact ids
 * ('#partial-discussion-sidebar', '[id="x"]') and id prefixes ('[id^="issuecomment-"]').
 */
export function idsFromSelectors(selectors: Iterable<string>): Set<string> {
  const ids = new Set<string>();
  for (const selector of selectors) {
    for (const m of selector.matchAll(/#([A-Za-z][\w-]*)/g)) ids.add(m[1]);
    for (const m of selector.matchAll(/\[id[\^]?=["']?([\w-]+)["']?\]/g)) ids.add(m[1]);
  }
  return ids;
}
