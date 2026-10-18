/**
 * Capability layer: the only API features use to read or locate GitHub DOM.
 *
 * Capabilities hide variants, selectors and fallbacks
 * (docs/internal/extension_dom_engine_design.md section 6). They are built once per page session;
 * listener registrations take the caller's AbortSignal so they are torn down with the feature.
 */
import type { PageFacts } from '../dom/types';

export interface Capabilities {
  page: PageCap;
  /** null when the timeline scope is absent or unrecognized on this page. */
  timeline: TimelineCap | null;
  composer: ComposerCap | null;
  sidebar: SidebarCap | null;
  navigation: NavigationCap;
  actions: ActionsCap;
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export interface PageCap {
  facts(): PageFacts;
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

export type TimelineItemKind =
  | 'comment'
  | 'review'
  | 'reviewThread'
  | 'closeReopen'
  | 'reference'
  | 'commit'
  /** Allowlisted noise events (labels, assignments, review requests, renames, project, milestone): hideable. */
  | 'event'
  /** Known event types that are not allowlisted (force-push, draft/ready, branch, lock, pin, deploy...): never hidden. */
  | 'otherEvent'
  | 'description'
  | 'unknown';

/** How a row's kind was determined. Heuristic (text-based) use is reported as drift. */
export type KindSource = 'gid' | 'structure' | 'heuristic';

export interface TimelineAuthor {
  login: string;
  /** Page-local signals (bot badge next to the author link). */
  isBotHint: boolean;
  /** Author links to a GitHub App (/apps/...). */
  isApp: boolean;
}

/** One unit of hiding (section 7). Single-row items have exactly one row. */
export interface TimelineRow {
  readonly el: Element;
  readonly kind: TimelineItemKind;
  readonly kindSource: KindSource;
  /** DOM ids inside this row usable as URL hashes. */
  readonly anchors: readonly string[];
  timestamp(): number | null;
  /** Markdown body inside this row (comment text, review body), or null. Rows with a body are never hidden. */
  body(): Element | null;
}

/** One whole timeline item: the unit for collapse runs and marker placement. */
export interface TimelineItem {
  readonly el: Element;
  /** GitHub GraphQL node id (classic data-gid, react data-wrapper-timeline-id). */
  readonly nodeId: string | null;
  /** From the GID typename prefix; for grouped items this is the item's own GID type (informational). */
  readonly kind: TimelineItemKind;
  /** DOM ids inside this item usable as URL hashes (issuecomment-N, discussion_rN, ...). */
  readonly anchors: readonly string[];
  rows(): readonly TimelineRow[];
  author(): TimelineAuthor | null;
  timestamp(): number | null;
  /** Markdown body element (read-only), or null for bodiless items. */
  body(): Element | null;
}

export type HiddenKind = 'range' | 'collapsedThread' | 'hiddenComments';

/** A place where GitHub is holding content back (section 9.1). */
export interface HiddenItemsInfo {
  readonly kind: HiddenKind;
  /** The control's container; read-only to features. */
  readonly segment: Element;
  /** Hint only (parsed digits); never required. */
  readonly count: number | null;
  /** Numeric comment ids GitHub says live inside (classic data-hidden-comment-ids). */
  readonly containsCommentIds?: readonly string[];
}

export interface LoadResult {
  status: 'loaded' | 'exhausted' | 'timeout' | 'failed' | 'aborted' | 'noProgress';
  added: number;
  batches: number;
}

export interface LoadUntilOptions {
  signal: AbortSignal;
  /** Hidden kinds this run may load. Default ['range']. */
  kinds?: readonly HiddenKind[];
  maxBatches: number;
  batchTimeoutMs: number;
  interBatchDelayMs: number;
  onProgress?: (p: { batches: number; added: number; remaining: number | null }) => void;
}

export interface TimelineCap {
  /** Whole items in document order. */
  items(): readonly TimelineItem[];
  /** False for variants whose loader is not verified (fail closed). */
  supportsLoadMore(): boolean;
  hidden(): readonly HiddenItemsInfo[];
  /** Bounded sequential loading through GitHub's own controls; serialized per session (section 9.3). */
  loadUntil(pred: () => boolean, opts: LoadUntilOptions): Promise<LoadResult>;
  /** Ask GitHub's own anchor loader for a focused item, when the variant has one. */
  focusedLoad(hash: string, opts: { signal: AbortSignal }): Promise<boolean>;
  /** Exact id first, then suffix + numeric id (React variants may prefix anchor ids). */
  findByAnchor(hash: string): { item: TimelineItem; target: Element } | null;
  /** Open a GitHub-collapsed container around a target (thread toggle, details). */
  reveal(target: Element | HiddenItemsInfo, opts: { signal: AbortSignal }): Promise<boolean>;
  /** Items added after the initial scan (load-more, live websocket inserts, hydration). */
  onItemsAdded(cb: (items: readonly TimelineItem[]) => void, signal: AbortSignal): void;
}

// ---------------------------------------------------------------------------
// composer, sidebar
// ---------------------------------------------------------------------------

export type InsertionPoint = { before: Element } | { after: Element } | { appendTo: Element };

export interface ComposerCap {
  /** The single primary submit button of the new-comment composer. */
  submitButton(): Element | null;
  /** Where an adjacent OctoDeck control goes (the variant decides the wrapper). */
  insertionPoint(): InsertionPoint | null;
}

export interface SidebarCap {
  /** Where the OctoDeck sidebar section goes. */
  insertionPoint(): InsertionPoint | null;
}

// ---------------------------------------------------------------------------
// navigation
// ---------------------------------------------------------------------------

export interface ToastHandle {
  update(text: string): void;
  dismiss(): void;
}

export interface NavigationCap {
  /** Current URL hash, decoded, without '#'. */
  hash(): string;
  /** Hash-only changes within the page session. */
  onHash(cb: (hash: string) => void, signal: AbortSignal): void;
  /** Scroll into view (sticky-header aware) and apply a fading highlight class; respects reduced motion. */
  scrollToAndHighlight(target: Element, opts: { signal: AbortSignal }): void;
  /** Banner toast for the anchor-repair flow only (decision 4). Dismissed automatically on abort. */
  showToast(text: string, opts: { signal: AbortSignal }): ToastHandle;
}

// ---------------------------------------------------------------------------
// actions (read-only)
// ---------------------------------------------------------------------------

export type GitHubActionType = 'comment' | 'pr_review' | 'merge' | 'close_reopen' | 'assignee_label';

export interface ActionsCap {
  /** Classify a user event; events whose composedPath contains an OctoDeck node return null. */
  classify(event: Event): GitHubActionType | null;
}
