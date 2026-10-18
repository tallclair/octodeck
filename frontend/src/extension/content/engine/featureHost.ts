/**
 * FeatureHost: mounts features for one page session with isolation, a recognition gate, a
 * circuit breaker and health tracking (docs/internal/extension_dom_engine_design.md 5.2, 7).
 */
import type { Diagnostic, ExtensionMessage, FeatureOutcome } from '../../types';
import type { Capabilities } from '../capabilities/types';
import type { ResolveEvent } from '../dom/resolver';
import type { FeatureId, ScopeDetection, ScopeId, VariantId } from '../dom/types';
import type { SessionBus } from './bus';
import type { MutationLedger } from './ledger';
import type { Messenger } from './messaging';
import type { ScopedObserver } from './observer';
import type {
  Feature,
  FeatureContext,
  FeatureRegistration,
  FeatureStatus,
  PageSession,
  PrefsSource,
} from './types';

/** Shape of platform's diagnostics client (engine/diagnosticsClient.ts); injected by content.ts. */
export interface DiagnosticsSink {
  beginSession(info: { navId: string; pageKind: PageSession['facts']['kind']; path: string; ghRelease?: string }): void;
  add(feature: FeatureId, diagnostic: Diagnostic): void;
  setOutcome(feature: FeatureId, outcome: FeatureOutcome, variant: VariantId | 'unknown'): void;
  endSession(): void;
}

export const BREAKER_MAX_ERRORS = 3;
export const BREAKER_WINDOW_MS = 30_000;

export interface FeatureHostOptions {
  session: PageSession;
  /** Current capabilities (rebuilt by the engine as scopes are recognized); read at mount time. */
  caps: () => Capabilities;
  detections: () => Partial<Record<ScopeId, ScopeDetection>>;
  registrations: readonly FeatureRegistration[];
  ledger: MutationLedger;
  bus: SessionBus;
  prefs: PrefsSource;
  messenger: Messenger;
  observer: ScopedObserver;
  diagnostics?: DiagnosticsSink;
  /** Sanitized structural fingerprint (platform's dom/fingerprint.ts), when available. */
  fingerprint?: (root: Element) => string;
  now?: () => number;
}

interface MountState {
  feature: Feature;
  controller: AbortController;
  errors: number[];
  outcome?: FeatureOutcome;
  mounted: boolean;
  /** A fallback selector was used (possibly before the mount finished). */
  drifted: boolean;
  /** A required anchor was ambiguous or missing: the feature couldn't do its job (fail closed). */
  failedAnchor?: string;
}

/** Orders registrations so each comes after the features it lists in `after`. */
function orderFeatures(features: Feature[]): Feature[] {
  const out: Feature[] = [];
  const remaining = [...features];
  while (remaining.length > 0) {
    const idx = remaining.findIndex((f) => (f.after ?? []).every((dep) => out.some((o) => o.id === dep) || !remaining.some((r) => r.id === dep)));
    out.push(...remaining.splice(idx === -1 ? 0 : idx, 1));
  }
  return out;
}

export class FeatureHost {
  private readonly features: Feature[];
  private readonly states = new Map<FeatureId, MountState>();
  private readonly health: Partial<Record<FeatureId, FeatureStatus>> = {};
  /** Feature whose code is currently running synchronously (for attributing resolver events). */
  private active: FeatureId | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: FeatureHostOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.features = orderFeatures(opts.registrations.map((r) => r.create()));
    const { session, diagnostics } = opts;
    const item = session.facts.item;
    diagnostics?.beginSession({
      navId: session.navId,
      pageKind: session.facts.kind,
      path: item ? `${item.owner}/${item.repo}/${session.facts.kind === 'issue' ? 'issues' : 'pull'}/${item.number}` : '',
      ghRelease: session.facts.ghRelease ?? undefined,
    });
  }

  get session(): PageSession {
    return this.opts.session;
  }

  status(): Partial<Record<FeatureId, FeatureStatus>> {
    return { ...this.health };
  }

  /** Mounts observers immediately and every mutator whose required scopes are recognized. */
  async mountReady(): Promise<void> {
    for (const feature of this.features) {
      if (this.states.has(feature.id) || this.health[feature.id]?.health === 'notApplicable') continue;
      if (!feature.pages.includes(this.session.facts.kind)) {
        this.setHealth(feature.id, { health: 'notApplicable', detail: 'page-kind' });
        if (feature.kind === 'mutator') this.setOutcome(feature, 'notApplicable');
        continue;
      }
      if (feature.kind === 'mutator' && this.opts.prefs.current().safeMode) {
        this.setHealth(feature.id, { health: 'off', detail: 'safe-mode' });
        continue;
      }
      const gate = this.gate(feature);
      if (gate === 'wait') continue;
      if (gate === 'absent') {
        this.setHealth(feature.id, { health: 'notApplicable', detail: 'scope-absent' });
        this.setOutcome(feature, 'notApplicable');
        continue;
      }
      await this.mount(feature);
      if (this.session.signal.aborted) return;
    }
  }

  /**
   * Called when the settle window closes: mutators still waiting on scopes are reported as
   * unrecognized (or ambiguous) and stay unmounted (fail closed).
   */
  finalizeSettle(): void {
    for (const feature of this.features) {
      if (this.states.has(feature.id) || this.health[feature.id]) continue;
      if (feature.kind !== 'mutator') continue;
      const dets = this.opts.detections();
      const bad = feature.requires.map((s) => dets[s]).filter((d): d is ScopeDetection => !!d && d.status !== 'recognized' && d.status !== 'absent');
      for (const det of bad) {
        this.report(feature.id, {
          code: det.status === 'ambiguous' ? 'SCOPE_AMBIGUOUS' : 'SCOPE_UNRECOGNIZED',
          severity: 'warn',
          scope: det.scope,
          count: det.candidates.length || undefined,
          fingerprint: this.fingerprintOf(document.querySelector('main') ?? document.body),
        });
      }
      this.setHealth(feature.id, { health: 'unrecognized', detail: bad.map((d) => `scope:${d.scope}`).join(',') || 'scope' });
      this.setOutcome(feature, 'unrecognized');
    }
  }

  /** Attributes a resolver event to the running feature, or to every mounted feature requiring that scope. */
  onResolveEvent(event: ResolveEvent): void {
    const d = this.diagnosticFor(event);
    const targets = this.active
      ? [this.active]
      : this.features.filter((f) => f.requires.includes(event.scope) && this.states.get(f.id)?.mounted).map((f) => f.id);
    for (const id of targets) this.report(id, d);
  }

  /** Converts a resolver event into a diagnostic (with a fingerprint of where resolution looked). */
  diagnosticFor(event: ResolveEvent): Diagnostic {
    const { resolution } = event;
    return {
      code: resolution.status === 'fallback' ? 'DOM_ANCHOR_FALLBACK' : resolution.status === 'ambiguous' ? 'DOM_ANCHOR_AMBIGUOUS' : 'DOM_ANCHOR_MISSING',
      severity: resolution.status === 'fallback' ? 'info' : 'warn',
      scope: event.scope,
      anchor: event.anchor,
      selectorIndex: 'selectorIndex' in resolution ? resolution.selectorIndex : undefined,
      count: resolution.status === 'ambiguous' ? resolution.count : undefined,
      fingerprint: event.base ? this.fingerprintOf(event.base) : undefined,
    };
  }

  /** Reports a diagnostic on behalf of specific features (e.g. page-scope findings made before any mount). */
  reportTo(features: readonly FeatureId[], d: Diagnostic): void {
    for (const id of features) {
      if (this.features.some((f) => f.id === id && f.pages.includes(this.session.facts.kind))) this.report(id, d);
    }
  }

  /** Capability diagnostics (unknown kinds, identity mismatch, load failures), attributed like resolver events. */
  onCapabilityDiagnostic(d: Diagnostic): void {
    const targets = this.active
      ? [this.active]
      : this.features
          .filter((f) => (d.scope ? f.requires.includes(d.scope) : f.kind === 'mutator') && this.states.get(f.id)?.mounted)
          .map((f) => f.id);
    for (const id of targets) this.report(id, d);
  }

  unmountAll(): void {
    for (const id of Array.from(this.states.keys())) this.unmount(id);
    this.opts.ledger.revertAll();
    this.opts.diagnostics?.endSession();
  }

  /** Called by the ledger when a feature exceeds its re-inject budget. */
  trip(id: FeatureId, reason: string): void {
    const state = this.states.get(id);
    if (!state || state.controller.signal.aborted) return;
    this.unmount(id);
    this.setHealth(id, { health: 'disabled', detail: reason });
    this.report(id, { code: 'FEATURE_DISABLED', severity: 'error', message: reason });
    this.setOutcome(state.feature, 'disabled');
  }

  // -------------------------------------------------------------------------

  private gate(feature: Feature): 'ready' | 'wait' | 'absent' {
    if (feature.kind === 'observer' || feature.requires.length === 0) return 'ready';
    const dets = this.opts.detections();
    const statuses = feature.requires.map((s) => dets[s]?.status);
    if (statuses.every((s) => s === 'recognized')) return 'ready';
    if (statuses.some((s) => s === 'absent')) return 'absent';
    return 'wait';
  }

  private variantOf(feature: Feature): VariantId | 'unknown' {
    const scope = feature.requires[0];
    return (scope && this.opts.detections()[scope]?.variant) || 'unknown';
  }

  private async mount(feature: Feature): Promise<void> {
    const controller = new AbortController();
    const sessionSignal = this.session.signal;
    const abort = () => controller.abort();
    sessionSignal.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener('abort', () => sessionSignal.removeEventListener('abort', abort), { once: true });

    const state: MountState = { feature, controller, errors: [], mounted: false, drifted: false };
    this.states.set(feature.id, state);
    const ctx = this.createContext(feature, controller.signal);
    const generation = this.session.generation;

    try {
      const r = this.run(feature.id, () => feature.mount(ctx));
      if (r instanceof Promise) await r;
    } catch (error) {
      this.onError(feature.id, error, true);
      return;
    }
    if (controller.signal.aborted || this.session.generation !== generation) return;
    state.mounted = true;
    if (state.failedAnchor) {
      this.setHealth(feature.id, { health: 'unrecognized', detail: `anchor:${state.failedAnchor}` });
      if (feature.kind === 'mutator') this.setOutcome(feature, 'unrecognized');
      return;
    }
    if (!this.health[feature.id]) this.setHealth(feature.id, { health: 'ok' });
    if (feature.kind === 'mutator' && !state.outcome) this.setOutcome(feature, state.drifted ? 'drifted' : 'ok');
  }

  private unmount(id: FeatureId): void {
    const state = this.states.get(id);
    if (!state) return;
    if (!state.controller.signal.aborted) {
      state.controller.abort();
      try {
        state.feature.unmount?.();
      } catch {
        // Unmount errors can't affect anything else: the ledger revert below is the backstop.
      }
    }
    this.opts.ledger.revert(id);
  }

  private run<T>(id: FeatureId, fn: () => T): T {
    const prev = this.active;
    this.active = id;
    try {
      return fn();
    } finally {
      this.active = prev;
    }
  }

  private onError(id: FeatureId, error: unknown, fatal = false): void {
    const state = this.states.get(id);
    if (!state || state.controller.signal.aborted) return;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    console.debug(`[OctoDeck] ${id} error:`, error);
    this.report(id, { code: 'FEATURE_EXCEPTION', severity: 'warn', message });
    const t = this.now();
    state.errors = state.errors.filter((x) => t - x < BREAKER_WINDOW_MS);
    state.errors.push(t);
    if (fatal || state.errors.length >= BREAKER_MAX_ERRORS) this.trip(id, fatal ? 'mount-failed' : 'errors');
  }

  private report(id: FeatureId, d: Diagnostic): void {
    this.opts.diagnostics?.add(id, d);
    const state = this.states.get(id);
    if (d.code === 'DOM_ANCHOR_FALLBACK' && state) {
      state.drifted = true;
      if (state.feature.kind === 'mutator' && state.outcome === 'ok') this.setOutcome(state.feature, 'drifted');
    }
    // An ambiguous or expected-but-missing anchor means the feature skipped its work (fail closed):
    // escalate so the aggregator counts it as a failure. Outcomes never de-escalate within a session.
    if ((d.code === 'DOM_ANCHOR_AMBIGUOUS' || d.code === 'DOM_ANCHOR_MISSING') && state && state.feature.kind === 'mutator') {
      state.failedAnchor ??= d.anchor ?? 'unknown';
      if (state.outcome === 'ok' || state.outcome === 'drifted') {
        this.setHealth(id, { health: 'unrecognized', detail: `anchor:${state.failedAnchor}` });
        this.setOutcome(state.feature, 'unrecognized');
      }
    }
  }

  private setOutcome(feature: Feature, outcome: FeatureOutcome): void {
    const state = this.states.get(feature.id);
    if (state) state.outcome = outcome;
    this.opts.diagnostics?.setOutcome(feature.id, outcome, this.variantOf(feature));
  }

  private setHealth(id: FeatureId, status: FeatureStatus): void {
    const prev = this.health[id];
    if (prev?.health === status.health && prev?.detail === status.detail) return;
    this.health[id] = status;
    this.opts.bus.emit('host:health', { ...this.health });
  }

  private fingerprintOf(el: Element): string | undefined {
    if (!this.opts.fingerprint) return undefined;
    try {
      return this.opts.fingerprint(el);
    } catch {
      return undefined;
    }
  }

  private createContext(feature: Feature, signal: AbortSignal): FeatureContext {
    const id = feature.id;
    const guard: FeatureContext['guard'] =
      (fn) =>
      (...args) => {
        if (signal.aborted) return;
        try {
          const r = this.run(id, () => fn(...args));
          if (r instanceof Promise) r.catch((e) => this.onError(id, e));
        } catch (e) {
          this.onError(id, e);
        }
      };
    const wrap = <A extends unknown[]>(fn: (...a: A) => void) => guard(fn);

    return {
      id,
      session: this.session,
      signal,
      caps: this.opts.caps(),
      ledger: this.opts.ledger.forFeature(id, signal),
      bus: this.opts.bus.view(signal, wrap),
      prefs: this.opts.prefs,
      guard,
      setTimer: (cb, ms) => {
        const t = setTimeout(guard(cb), ms);
        const cancel = () => clearTimeout(t);
        signal.addEventListener('abort', cancel, { once: true });
        return cancel;
      },
      delay: (ms) =>
        new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(t);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          const t = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      onScopeChange: (scope, cb) => this.opts.observer.subscribe(scope, guard(cb), signal),
      send: <T,>(msg: ExtensionMessage) => this.opts.messenger.send<T>(msg, signal),
      report: (d) => {
        if (!signal.aborted) this.report(id, d);
      },
      setStatus: (s) => {
        if (!signal.aborted) this.setHealth(id, s);
      },
    };
  }
}
