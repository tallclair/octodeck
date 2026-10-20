/**
 * Variant module contract (docs/internal/extension_dom_engine_design.md sections 4.4 and 9.2).
 *
 * A variant contributes detectors, per-anchor locators and small behavioral adapters. Adding a
 * GitHub markup variant means adding a module under variants/<id>/ and registering it in
 * variants/index.ts; features never change. Only variants/** may contain GitHub selectors.
 */
import type {
  GitHubActionType,
  HiddenItemsInfo,
  InsertionPoint,
  KindSource,
  TimelineAuthor,
  TimelineItemKind,
} from '../capabilities/types';
import type { AnchorId, Locator, ScopeId, VariantDetector, VariantId } from '../dom/types';

/** Page-scope behavior: identity and page flags that are not plain selector lookups. */
export interface PageAdapter {
  /** GraphQL node id (I_/PR_) of the page's item, or null. Validated against the URL by the capability. */
  identity(doc: Document): string | null;
  /** owner/repo as GitHub states it on the page, for the identity cross-check. */
  repoNwo(doc: Document): string | null;
  locked(doc: Document): boolean | null;
  archived(doc: Document): boolean | null;
}

/** Per-element timeline reads. Elements passed in are already resolved timeline items or rows. */
export interface TimelineAdapter {
  itemNodeId(item: Element): string | null;
  /** Hiding units inside an item; single-row items return [item]. */
  rows(item: Element): Element[];
  rowKind(row: Element): { kind: TimelineItemKind; source: KindSource } | null;
  /** DOM ids usable as URL hashes inside an element. */
  anchors(el: Element): string[];
  author(item: Element): TimelineAuthor | null;
  timestamp(el: Element): number | null;
  body(el: Element): Element | null;
}

export type LoadOutcome = 'loaded' | 'ended' | 'failed' | 'timeout' | 'aborted';

/** Variant-specific progressive-loading mechanics (section 9.2). Always uses GitHub's own controls. */
export interface TimelineLoadAdapter {
  supportsLoadMore(): boolean;
  hidden(timelineRoot: Element): HiddenItemsInfo[];
  /** Trigger GitHub's control for one segment and resolve when GitHub has finished or failed. */
  loadOne(segment: HiddenItemsInfo, opts: { signal: AbortSignal; timeoutMs: number }): Promise<LoadOutcome>;
  /** Ask GitHub's own anchor loader for one focused item (classic: one synthetic hashchange). */
  focusedLoad?(hash: string, opts: { signal: AbortSignal; timeoutMs: number }): Promise<boolean>;
  /** Open a GitHub-collapsed container by clicking its toggle (never call custom-element methods). */
  reveal(target: Element | HiddenItemsInfo, opts: { signal: AbortSignal }): Promise<boolean>;
  /**
   * Where an adjacent OctoDeck control goes, given the range's resolved timeline.loadMoreControl,
   * or null when the surrounding markup is not the verified shape (fail closed).
   */
  controlInsertionPoint?(control: Element): InsertionPoint | null;
}

export interface ComposerAdapter {
  /** Where an adjacent OctoDeck control goes, given the resolved submit button. */
  insertionPoint(submit: Element): InsertionPoint | null;
}

export interface SidebarAdapter {
  /** Where the OctoDeck sidebar section goes, given the resolved sidebar.insertBefore anchor. */
  insertionPoint(anchor: Element): InsertionPoint | null;
}

export interface ActionAdapter {
  /** Classify a user event on a GitHub page of this variant. Own-node filtering happens in the capability. */
  classify(event: Event): GitHubActionType | null;
}

export interface VariantModule {
  readonly id: VariantId;
  readonly detectors: Partial<Record<ScopeId, VariantDetector>>;
  readonly anchors: Partial<Record<AnchorId, Locator>>;
  readonly adapters: {
    page?: PageAdapter;
    timeline?: TimelineAdapter;
    /** Separate file per variant so DOM reads (WP1) and loading (WP2) never share a file. */
    load?: TimelineLoadAdapter;
    composer?: ComposerAdapter;
    sidebar?: SidebarAdapter;
    actions?: ActionAdapter;
  };
}
