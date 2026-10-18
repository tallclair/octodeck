/**
 * Shared vocabulary and DOM-contract types for the extension's GitHub DOM engine.
 *
 * See docs/internal/extension_dom_engine_design.md section 4. These types are imported by the
 * engine, capabilities, variants and features, and re-exported from extension/types.ts so the
 * background can validate diagnostics without importing content-script code.
 */

/** Every feature the engine can host. Planned features are listed so diagnostics can name them. */
export const FEATURE_IDS = [
  'viewTracker',
  'actionTracker',
  'sidebarWidget',
  'ackButton',
  'noiseCollapser',
  'timelineMarkers',
  'expandAll',
  'anchorNav',
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

/** Page kinds derived from the URL. `pr-subtab` covers /pull/N/(files|changes|commits|checks). */
export const PAGE_KINDS = ['issue', 'pr-conversation', 'pr-subtab', 'other'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** Regions of a page whose markup stack can vary independently (section 4.2). */
export const SCOPE_IDS = ['page', 'timeline', 'sidebar', 'composer'] as const;
export type ScopeId = (typeof SCOPE_IDS)[number];

/**
 * Identifier of a markup variant (e.g. 'classic', 'react'). Declared by variant modules; kept as a
 * string so adding a variant needs no change outside variants/.
 */
export type VariantId = string;

/** Named DOM landmarks that capabilities depend on. Locators per variant live in variants/. */
export const ANCHOR_IDS = [
  'page.identity',
  'page.repo',
  'page.viewer',
  'page.release',
  'sidebar.root',
  'sidebar.insertBefore',
  'composer.root',
  'composer.submit',
  'timeline.root',
  'timeline.item',
  'timeline.row',
  'timeline.itemBody',
  'timeline.itemAuthor',
  'timeline.itemTime',
  'timeline.hiddenRange',
  'timeline.collapsedThread',
  'timeline.hiddenComments',
] as const;
export type AnchorId = (typeof ANCHOR_IDS)[number];

/**
 * Expected number of matches. `allEqual` means one-or-more matches whose extracted `value` must
 * all agree (used for identity attributes repeated across the page).
 */
export type Cardinality = 'one' | 'zeroOrOne' | 'oneOrMore' | 'many' | 'allEqual';

/** Whether an anchor must exist once the page has settled, per page kind. */
export type Presence = 'required' | 'optional' | 'absent';

/** The GitHub item a page is about, derived from the URL and optionally validated page identity. */
export interface ItemRef {
  owner: string;
  repo: string;
  number: number;
  /** owner/repo#number */
  itemId: string;
  /** GraphQL node id (I_/PR_), only when it agrees with the URL (section 6.1). */
  nodeId?: string;
}

/** Facts about the current page, computed once per page session. */
export interface PageFacts {
  kind: PageKind;
  item: ItemRef | null;
  viewerLogin: string | null;
  signedIn: boolean;
  /** null when the variant cannot tell. */
  locked: boolean | null;
  archived: boolean | null;
  /** GitHub deploy SHA from meta[name=release]. */
  ghRelease: string | null;
  /** Detected variant per scope (absent scopes are omitted). */
  variants: Partial<Record<ScopeId, VariantId>>;
}

/** How to find an anchor in one variant (section 4.3). */
export interface Locator {
  /** Ordered: [0] is the current primary; later entries are known older/alternate markup (reported as drift). */
  selectors: readonly string[];
  /** Resolve relative to another anchor's element instead of the scope root. */
  within?: AnchorId;
  /** Post-match mapping (e.g. to the element's parent). Returning null drops the candidate. */
  map?: (el: Element) => Element | null;
  /** Semantic check on candidates; failures are filtered out before the cardinality check. */
  validate?: (el: Element) => boolean;
  /** For `allEqual` anchors: value extractor (e.g. a data-gid); all matches must agree. */
  value?: (el: Element) => string | null;
}

/** Variant-independent declaration of an anchor. Locators are contributed by variant modules. */
export interface AnchorDef {
  id: AnchorId;
  scope: ScopeId;
  cardinality: Cardinality;
  presence: Partial<Record<PageKind, Presence>>;
  /** Declared legitimate reasons for absence (signed out, locked, archived, ...). */
  absentWhen?: (page: PageFacts) => boolean;
}

/** Result of resolving an anchor in a scope. Anything but `ok` is reported to diagnostics. */
export type Resolution<E extends Element = Element> =
  | { status: 'ok'; els: E[]; selectorIndex: 0; variant: VariantId }
  | { status: 'fallback'; els: E[]; selectorIndex: number; variant: VariantId }
  /** `expected` is false when the anchor is legitimately absent (presence/absentWhen). */
  | { status: 'missing'; variant: VariantId; expected: boolean }
  | { status: 'ambiguous'; count: number; selectorIndex: number; variant: VariantId };

/** Identifies a variant's root for one scope (section 4.2). */
export interface VariantDetector {
  variant: VariantId;
  /** Locator whose match becomes the scope root. */
  root: Locator;
  /** Extra selectors that must all match inside the root, to disambiguate look-alike variants. */
  confirm?: readonly string[];
}

/** Outcome of variant detection for one scope. */
export interface ScopeDetection {
  scope: ScopeId;
  status: 'recognized' | 'absent' | 'unrecognized' | 'ambiguous';
  variant?: VariantId;
  root?: Element;
  /** Every variant whose detector matched; more than one means `ambiguous` (fail closed). */
  candidates: VariantId[];
}
