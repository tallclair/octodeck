/**
 * Feature module API and engine lifecycle types
 * (docs/internal/extension_dom_engine_design.md section 5).
 *
 * Features import only this file and capabilities/types.ts. Everything a feature registers
 * through its FeatureContext is torn down automatically when its AbortSignal aborts (unmount,
 * page-session end, circuit breaker, or orphaning).
 */
import type { Item } from '../../../api/octodeck/v1/resources_pb';
import type { Diagnostic, ExtensionMessage, ExtensionResponse } from '../../types';
import type { Capabilities, TimelineItem } from '../capabilities/types';
import type { FeatureId, PageFacts, PageKind, ScopeId } from '../dom/types';

export type FeatureKind = 'observer' | 'mutator';

export type FeatureHealth = 'ok' | 'degraded' | 'disabled' | 'notApplicable' | 'unrecognized' | 'off';

export interface FeatureStatus {
  health: FeatureHealth;
  /** Short machine-readable detail, e.g. 'unsupported-variant' or 'scope:timeline'. */
  detail?: string;
}

/** One page session: from a navigation that changes the item or sub-route until the next one. */
export interface PageSession {
  /** Increments on every session; work from an older generation must stop. */
  readonly generation: number;
  /** Random id for diagnostics resend dedupe. */
  readonly navId: string;
  readonly url: URL;
  readonly facts: PageFacts;
  /** Aborted when the session ends (navigation, unload, orphaning). */
  readonly signal: AbortSignal;
}

/** User and daemon preferences relevant to content features. */
export interface PrefsSnapshot {
  hideEvents: boolean;
  knownBots: readonly string[];
  /** Global Safe mode switch (decision 7): mutators off, own UI hidden. */
  safeMode: boolean;
}

export interface PrefsSource {
  /** Current values; defaults or cached values until storage answers (never blocks mounting). */
  current(): PrefsSnapshot;
  onChange(cb: (prefs: PrefsSnapshot) => void, signal: AbortSignal): void;
  /** Persist the hide-events preference (local cache + background); updates current() and notifies every onChange listener in the session. */
  setHideEvents(hide: boolean): void;
}

/** DOM changes attributed to one scope by the shared observer (section 5.3). */
export interface ScopeChange {
  scope: ScopeId;
  /** Non-OctoDeck elements added inside the scope since the last notification. */
  addedElements: readonly Element[];
  /**
   * OctoDeck-owned elements that someone else (GitHub/React) detached from inside the scope since
   * the last notification. Removal-only mutations are delivered so owners can re-insert.
   */
  removedOwn: readonly Element[];
  /** The scope root was detached or replaced; capabilities for it have been rebuilt. */
  rootReplaced: boolean;
}

/** Typed, synchronous, per-session events (section 5.4). */
export interface BusEvents {
  /** Daemon state for the current item (emitted by sidebarWidget). */
  'item:updated': {
    item: Item | null;
    /** Daemon availability for this item; item is non-null only when 'ok'. */
    daemon: 'ok' | 'notFound' | 'offline' | 'error';
    error?: string;
  };
  'prefs:changed': PrefsSnapshot;
  'timeline:changed': { added: readonly TimelineItem[]; reason: 'mutation' | 'loadMore' | 'live' };
  'timeline:loading': { phase: 'start' | 'batch' | 'end'; loaded: number; remaining: number | null; error?: string };
  'nav:hash': { hash: string };
  /** Synchronous request to un-hide an element OctoDeck itself hid; handlers act before emit() returns. */
  'reveal:request': { target: Element };
  'host:health': Partial<Record<FeatureId, FeatureStatus>>;
}

export type BusEventName = keyof BusEvents;

export interface EventBus {
  emit<K extends BusEventName>(name: K, value: BusEvents[K]): void;
  /** Subscription is removed automatically when the subscribing feature's signal aborts. */
  on<K extends BusEventName>(name: K, cb: (value: BusEvents[K]) => void): () => void;
  /** Last emitted value in this session, for late mounters. */
  last<K extends BusEventName>(name: K): BusEvents[K] | undefined;
}

/** Class names OctoDeck may add to GitHub nodes. */
export type OwnClass = `octodeck-gh-${string}`;

/** Data attributes OctoDeck may set on GitHub nodes (without the 'data-' prefix). */
export type OwnDataName = `octodeck-${string}`;

export type LedgerPosition = { before: Element } | { after: Element } | { appendTo: Element };

/**
 * The only way a feature may change the page (section 5.5). Pre-bound to one feature; every
 * operation is recorded so revert() restores GitHub's DOM exactly.
 */
export interface FeatureLedger {
  /** Creates an element tagged data-octodeck="<feature>" (and data-octodeck-key when given). */
  create<K extends keyof HTMLElementTagNameMap>(tag: K, key?: string): HTMLElementTagNameMap[K];
  /** Inserts a node created by create(). Re-inserting a key removed by someone else counts against the re-inject budget. */
  insert(node: Element, where: LedgerPosition): void;
  /** Removes an own node. */
  remove(node: Element): void;
  /** Adds an OctoDeck class to any node (GitHub's included); recorded for revert. */
  addClass(el: Element, cls: OwnClass): void;
  removeClass(el: Element, cls: OwnClass): void;
  /** Sets data-octodeck-* on any node; recorded for revert. */
  setData(el: Element, name: OwnDataName, value: string): void;
  /** Deep clone of GitHub content for display, with id/for/name and on* attributes stripped. */
  cloneForDisplay<E extends Element>(el: E): E;
  /** Undo everything this feature did. Idempotent. */
  revert(): void;
}

export interface FeatureContext {
  readonly id: FeatureId;
  readonly session: PageSession;
  /** Per mount; aborted on unmount, session end, circuit break, or orphaning. */
  readonly signal: AbortSignal;
  readonly caps: Capabilities;
  readonly ledger: FeatureLedger;
  readonly bus: EventBus;
  readonly prefs: PrefsSource;
  /** Wraps a callback in try/catch (errors count toward the circuit breaker) and makes it a no-op after abort. */
  guard<A extends unknown[]>(fn: (...args: A) => void | Promise<void>): (...args: A) => void;
  /** Guarded timer; cancelled automatically on abort. Returns a cancel function. */
  setTimer(cb: () => void, ms: number): () => void;
  /** Abortable delay; rejects with an AbortError when the signal aborts. */
  delay(ms: number): Promise<void>;
  /** Debounced, own-node-filtered DOM changes for one scope (section 5.3). */
  onScopeChange(scope: ScopeId, cb: (change: ScopeChange) => void): void;
  /**
   * Message to the background. Resolves {ok:false} on failure (including an invalidated extension
   * context). Once the signal has aborted, the promise never settles, so late responses can't act.
   */
  send<T = unknown>(msg: ExtensionMessage): Promise<ExtensionResponse<T>>;
  /** Attach a diagnostic to this feature's report for the current session (section 10.2). */
  report(diagnostic: Diagnostic): void;
  setStatus(status: FeatureStatus): void;
}

export interface Feature {
  readonly id: FeatureId;
  readonly kind: FeatureKind;
  readonly pages: readonly PageKind[];
  /** Scopes that must be 'recognized' before a mutator mounts (section 7). */
  readonly requires: readonly ScopeId[];
  /** Mount after these features (ordering only; features never reference each other). */
  readonly after?: readonly FeatureId[];
  mount(ctx: FeatureContext): void | Promise<void>;
  /** Optional extra teardown; everything registered through ctx is torn down automatically. */
  unmount?(): void;
}

/**
 * Features are registered as factories: the host creates a fresh instance per mount, so no state
 * survives from one page session (or one circuit-breaker trip) to the next.
 */
export interface FeatureRegistration {
  readonly id: FeatureId;
  create(): Feature;
}
