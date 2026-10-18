/**
 * Engine: boot hygiene, navigation, page sessions, scope settling and orphan handling
 * (docs/internal/extension_dom_engine_design.md section 5).
 *
 * The engine is wired with injected dependencies (variant modules, page-facts and capability
 * builders, features, diagnostics), so it can be tested with fakes and so the capability layer
 * (WP1) and diagnostics (WP3) plug in without the engine importing their internals.
 */
import type { Capabilities } from '../capabilities/types';
import { detectScope, Resolver, type ResolveEvent } from '../dom/resolver';
import type { FeatureId, PageFacts, ScopeDetection, ScopeId } from '../dom/types';
import type { VariantModule } from '../variants/types';
import { SessionBus } from './bus';
import { INSTANCE_ATTR, SAFE_ATTR } from './constants';
import { FeatureHost, type DiagnosticsSink } from './featureHost';
import { MutationLedger, sweepStaleOwnState } from './ledger';
import { createMessenger, type Messenger } from './messaging';
import { NavigationSource, type NavEvent } from './navigation';
import { ScopedObserver } from './observer';
import { PrefsStore } from './prefs';
import type { Diagnostic } from '../../types';
import type { EventBus, FeatureLedger, FeatureRegistration, PageSession, ScopeChange } from './types';

/** How long expected scopes may take to appear before they are declared unrecognized. */
export const SETTLE_MS = 8000;
export const SETTLE_POLL_MS = 250;

const DETECTED_SCOPES: readonly ScopeId[] = ['timeline', 'sidebar', 'composer'];

export interface BuildCapabilitiesDeps {
  resolver: Resolver;
  variants: readonly VariantModule[];
  doc: Document;
  win: Window;
  bus: EventBus;
  /** Ledger view for navigation UI (highlight, toast); tagged and reverted as anchorNav's. */
  navLedger: FeatureLedger;
  onHash(cb: (hash: string) => void, signal: AbortSignal): void;
  onScopeChange(scope: ScopeId, cb: (change: ScopeChange) => void, signal: AbortSignal): void;
  /** Session sink for capability diagnostics; attributed to the running or dependent features. */
  report(d: Diagnostic): void;
}

export interface EngineDeps {
  variants: readonly VariantModule[];
  features: readonly FeatureRegistration[];
  computePageFacts(
    url: URL,
    doc: Document,
    variants: readonly VariantModule[],
    opts: { onEvent: (e: ResolveEvent) => void; report: (d: Diagnostic) => void }
  ): { facts: PageFacts; pageDetection: ScopeDetection };
  /**
   * Features that page-scope diagnostics (identity, repo, viewer) are attributed to: the ones
   * that act on the page's identity. Page facts are computed before any feature mounts.
   */
  pageDiagnosticFeatures?: readonly FeatureId[];
  buildCapabilities(deps: BuildCapabilitiesDeps): Capabilities;
  /** Optional: platform's diagnostics client, given the engine's messenger. */
  createDiagnostics?(messenger: Messenger): DiagnosticsSink;
  fingerprint?: (root: Element) => string;
  doc?: Document;
  win?: Window;
  settleMs?: number;
}

interface ActiveSession {
  session: PageSession;
  controller: AbortController;
  host: FeatureHost;
  resolver: Resolver;
  detections: Partial<Record<ScopeId, ScopeDetection>>;
  bus: SessionBus;
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

export class Engine {
  private readonly doc: Document;
  private readonly win: Window;
  private readonly instanceId = randomId();
  private readonly ledger: MutationLedger;
  private readonly messenger: Messenger;
  private readonly prefs: PrefsStore;
  private readonly observer: ScopedObserver;
  private readonly navigation: NavigationSource;
  private readonly diagnostics?: DiagnosticsSink;
  private readonly lifetime = new AbortController();
  private instanceWatcher: MutationObserver | null = null;
  private active: ActiveSession | null = null;
  private generation = 0;
  private stopped = false;

  constructor(private readonly deps: EngineDeps) {
    this.doc = deps.doc ?? document;
    this.win = deps.win ?? window;
    this.ledger = new MutationLedger({ onBudgetExceeded: (id) => this.active?.host.trip(id, 'reinject-budget') });
    this.messenger = createMessenger(() => this.shutdown(true));
    this.prefs = new PrefsStore(this.messenger);
    this.diagnostics = deps.createDiagnostics?.(this.messenger);
    this.observer = new ScopedObserver({
      getRoots: () => {
        const roots: Partial<Record<ScopeId, Element>> = {};
        for (const [scope, det] of Object.entries(this.active?.detections ?? {})) {
          if (det?.root) roots[scope as ScopeId] = det.root;
        }
        return roots;
      },
      onRootsDetached: (scopes) => this.onRootsDetached(scopes),
      onBodySwap: () => this.onRootsDetached(DETECTED_SCOPES),
    });
    this.navigation = new NavigationSource(
      (e) => this.onNavigate(e),
      () => this.onRootsDetached(DETECTED_SCOPES),
      this.win
    );
  }

  /** Boots the engine: takes over from any orphaned instance, then starts the first session. */
  start(): void {
    const html = this.doc.documentElement;
    sweepStaleOwnState(this.doc);
    html.removeAttribute(SAFE_ATTR);
    html.setAttribute(INSTANCE_ATTR, this.instanceId);
    this.watchInstanceToken();
    this.applySafeMode(this.prefs.current().safeMode);
    this.observer.start(html);
    this.navigation.start();

    this.prefs.onChange((p) => this.onPrefsChanged(p.safeMode), this.lifetime.signal);
    // May detect an invalidated extension context and shut the engine down synchronously.
    void this.prefs.start();
    if (this.stopped) return;
    void this.startSession();
  }

  /** Stops everything and reverts all mutations. `safe` also sets the CSS safe-mode valve. */
  shutdown(safe = false): void {
    if (this.stopped) return;
    this.stopped = true;
    this.endSession();
    this.lifetime.abort();
    this.navigation.stop();
    this.observer.stop();
    this.prefs.stop();
    this.instanceWatcher?.disconnect();
    this.ledger.revertAll();
    if (safe) this.doc.documentElement.setAttribute(SAFE_ATTR, '');
  }

  /** For tests and diagnostics. */
  get current(): { session: PageSession; host: FeatureHost; detections: Partial<Record<ScopeId, ScopeDetection>> } | null {
    return this.active ? { session: this.active.session, host: this.active.host, detections: this.active.detections } : null;
  }

  // -------------------------------------------------------------------------

  private watchInstanceToken(): void {
    if (typeof MutationObserver === 'undefined') return;
    this.instanceWatcher = new MutationObserver(() => {
      // A newer content-script instance took over (extension update/re-inject): step aside quietly.
      if (this.doc.documentElement.getAttribute(INSTANCE_ATTR) !== this.instanceId) this.shutdown(false);
    });
    this.instanceWatcher.observe(this.doc.documentElement, { attributes: true, attributeFilter: [INSTANCE_ATTR] });
  }

  private onPrefsChanged(safeMode: boolean): void {
    const wasSafe = this.doc.documentElement.hasAttribute(SAFE_ATTR);
    if (wasSafe === safeMode) return;
    this.applySafeMode(safeMode);
    // Mutators mount or unmount according to Safe mode: restart the session.
    void this.startSession();
  }

  private applySafeMode(safe: boolean): void {
    if (safe) this.doc.documentElement.setAttribute(SAFE_ATTR, '');
    else this.doc.documentElement.removeAttribute(SAFE_ATTR);
  }

  private onNavigate(e: NavEvent): void {
    if (this.stopped) return;
    if (e.kind === 'hash-change') {
      this.active?.bus.emit('nav:hash', { hash: decodeURIComponent(e.url.hash.replace(/^#/, '')) });
      return;
    }
    void this.startSession();
  }

  private onRootsDetached(scopes: readonly ScopeId[]): void {
    const active = this.active;
    if (!active || this.stopped) return;
    let restart = false;
    for (const scope of scopes) {
      const prev = active.detections[scope];
      const next = detectScope(scope, this.doc, this.deps.variants, active.session.facts);
      if (prev?.status === next.status && prev?.variant === next.variant) {
        // Same variant, new root: capabilities resolve lazily, so updating the detection suffices.
        active.resolver.setDetection(next);
        active.detections[scope] = next;
      } else if (prev?.status === 'recognized' || next.status === 'recognized') {
        restart = true;
      }
    }
    if (restart) void this.startSession();
  }

  private endSession(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.controller.abort();
    active.host.unmountAll();
    active.bus.clear();
  }

  private async startSession(): Promise<void> {
    if (this.stopped) return;
    this.endSession();
    const generation = ++this.generation;
    const controller = new AbortController();
    const url = new URL(this.win.location.href);

    let facts: PageFacts;
    let pageDetection: ScopeDetection;
    // Page facts are computed before the host exists; buffer their diagnostics and replay them.
    const pageEvents: ResolveEvent[] = [];
    const pageDiagnostics: Diagnostic[] = [];
    try {
      ({ facts, pageDetection } = this.deps.computePageFacts(url, this.doc, this.deps.variants, {
        onEvent: (e) => pageEvents.push(e),
        report: (d) => pageDiagnostics.push(d),
      }));
    } catch (error) {
      console.debug('[OctoDeck] page facts failed:', error);
      return;
    }

    const session: PageSession = { generation, navId: randomId(), url, facts, signal: controller.signal };
    const detections: Partial<Record<ScopeId, ScopeDetection>> = { page: pageDetection };
    const noteVariant = (det: ScopeDetection) => {
      if (det.status === 'recognized' && det.variant) facts.variants[det.scope] = det.variant;
      else delete facts.variants[det.scope];
    };
    for (const scope of DETECTED_SCOPES) {
      detections[scope] = detectScope(scope, this.doc, this.deps.variants, facts);
      noteVariant(detections[scope]!);
    }

    const bus = new SessionBus((error, event) => console.debug(`[OctoDeck] bus handler error (${event}):`, error));
    let host: FeatureHost | null = null;
    const resolver = new Resolver({
      facts,
      detections,
      variants: this.deps.variants,
      onEvent: (e: ResolveEvent) => host?.onResolveEvent(e),
    });
    /**
     * Re-detects scopes that aren't recognized yet; updates go through the resolver so its memo
     * stays valid, and capabilities are rebuilt so mutators mounting later see the new scopes.
     */
    const detect = () => {
      let changed = false;
      for (const scope of DETECTED_SCOPES) {
        const prev = detections[scope];
        if (prev?.status === 'recognized') continue;
        const next = detectScope(scope, this.doc, this.deps.variants, facts);
        if (next.status !== prev?.status || next.variant !== prev?.variant) {
          resolver.setDetection(next);
          noteVariant(next);
          changed = true;
        }
      }
      if (changed) caps = build();
    };
    const build = () =>
      this.deps.buildCapabilities({
        resolver,
        variants: this.deps.variants,
        doc: this.doc,
        win: this.win,
        bus: bus.view(controller.signal),
        navLedger: this.ledger.forFeature('anchorNav', controller.signal),
        onHash: (cb, signal) => bus.view(signal).on('nav:hash', (v) => cb(v.hash)),
        onScopeChange: (scope, cb, signal) => this.observer.subscribe(scope, cb, signal),
        report: (d) => host?.onCapabilityDiagnostic(d),
      });
    let caps = build();
    host = new FeatureHost({
      session,
      caps: () => caps,
      detections: () => detections,
      registrations: this.deps.features,
      ledger: this.ledger,
      bus,
      prefs: this.prefs,
      messenger: this.messenger,
      observer: this.observer,
      diagnostics: this.diagnostics,
      fingerprint: this.deps.fingerprint,
    });
    this.active = { session, controller, host, resolver, detections, bus };
    const pageTargets = this.deps.pageDiagnosticFeatures ?? [];
    for (const e of pageEvents) host.reportTo(pageTargets, host.diagnosticFor(e));
    for (const d of pageDiagnostics) host.reportTo(pageTargets, d);

    await host.mountReady();
    // Settle: keep re-detecting scopes that should exist but haven't appeared yet (hydration, partials).
    const deadline = Date.now() + (this.deps.settleMs ?? SETTLE_MS);
    while (!controller.signal.aborted && this.generation === generation) {
      const pending = DETECTED_SCOPES.some((s) => detections[s]?.status === 'unrecognized');
      if (!pending || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
      if (controller.signal.aborted || this.generation !== generation) return;
      detect();
      await host.mountReady();
    }
    if (!controller.signal.aborted && this.generation === generation) host.finalizeSettle();
  }
}
