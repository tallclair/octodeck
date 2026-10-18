/**
 * Test fake for FeatureContext, with a working ledger and bus that follow the engine's contract
 * (docs/internal/extension_dom_engine_design.md section 5): everything registered through the
 * context is torn down on abort, and ledger.revert() restores GitHub's DOM.
 */
import type { Diagnostic, ExtensionMessage, ExtensionResponse } from '../../types';
import type { Capabilities } from '../../content/capabilities/types';
import type { FeatureId, ScopeId } from '../../content/dom/types';
import { OWN_ATTR, OWN_KEY_ATTR } from '../../content/engine/constants';
import type {
  BusEventName,
  BusEvents,
  EventBus,
  FeatureContext,
  FeatureLedger,
  FeatureStatus,
  OwnClass,
  OwnDataName,
  PageSession,
  PrefsSnapshot,
  PrefsSource,
  ScopeChange,
} from '../../content/engine/types';
import { createFakeCapabilities, fakePageFacts } from './capabilities';

export const DEFAULT_PREFS: PrefsSnapshot = { hideEvents: false, knownBots: [], safeMode: false };

/** A bus shared by several fake contexts in one test (like the engine's per-session bus). */
export function createFakeBus(): { forSignal(signal: AbortSignal): EventBus } {
  const listeners = new Map<BusEventName, Set<(v: unknown) => void>>();
  const lastValues = new Map<BusEventName, unknown>();
  return {
    forSignal(signal: AbortSignal): EventBus {
      return {
        emit(name, value) {
          lastValues.set(name, value);
          for (const cb of Array.from(listeners.get(name) ?? [])) cb(value);
        },
        on(name, cb) {
          const set = listeners.get(name) ?? new Set();
          listeners.set(name, set);
          const wrapped = cb as (v: unknown) => void;
          const off = () => set.delete(wrapped);
          if (signal.aborted) return off;
          set.add(wrapped);
          signal.addEventListener('abort', off, { once: true });
          return off;
        },
        last<K extends BusEventName>(name: K) {
          return lastValues.get(name) as BusEvents[K] | undefined;
        },
      };
    },
  };
}

export type FakeLedger = FeatureLedger & {
  /** Nodes created by this ledger (whether or not still attached). */
  readonly created: Element[];
  readonly reinserts: number;
};

export function createFakeLedger(featureId: FeatureId): FakeLedger {
  const created: Element[] = [];
  const addedClasses: Array<[Element, OwnClass]> = [];
  const dataChanges: Array<[Element, string, string | null]> = [];
  const seenKeys = new Set<string>();
  let reinserts = 0;

  const assertOwn = (node: Element) => {
    if (node.getAttribute(OWN_ATTR) !== featureId) {
      throw new Error(`ledger(${featureId}): node was not created by this ledger`);
    }
  };

  const ledger: FakeLedger = {
    created,
    get reinserts() {
      return reinserts;
    },
    create(tag, key) {
      const el = document.createElement(tag);
      el.setAttribute(OWN_ATTR, featureId);
      if (key) el.setAttribute(OWN_KEY_ATTR, key);
      created.push(el);
      return el;
    },
    insert(node, where) {
      assertOwn(node);
      const key = node.getAttribute(OWN_KEY_ATTR);
      if (key) {
        if (seenKeys.has(key) && !node.isConnected) reinserts++;
        seenKeys.add(key);
      }
      if ('before' in where) where.before.parentNode?.insertBefore(node, where.before);
      else if ('after' in where) where.after.parentNode?.insertBefore(node, where.after.nextSibling);
      else where.appendTo.appendChild(node);
    },
    remove(node) {
      assertOwn(node);
      node.remove();
    },
    addClass(el, cls) {
      if (el.classList.contains(cls)) return;
      el.classList.add(cls);
      addedClasses.push([el, cls]);
    },
    removeClass(el, cls) {
      el.classList.remove(cls);
    },
    setData(el, name: OwnDataName, value) {
      const attr = `data-${name}`;
      dataChanges.push([el, attr, el.getAttribute(attr)]);
      el.setAttribute(attr, value);
    },
    cloneForDisplay(el) {
      const clone = el.cloneNode(true) as typeof el;
      for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
        for (const attr of Array.from(node.attributes)) {
          if (attr.name === 'id' || attr.name === 'for' || attr.name === 'name' || attr.name.startsWith('on')) {
            node.removeAttribute(attr.name);
          }
        }
      }
      return clone;
    },
    revert() {
      for (const el of created) el.remove();
      for (const [el, cls] of addedClasses) el.classList.remove(cls);
      for (const [el, attr, prev] of dataChanges.reverse()) {
        if (prev === null) el.removeAttribute(attr);
        else el.setAttribute(attr, prev);
      }
      addedClasses.length = 0;
      dataChanges.length = 0;
    },
  };
  return ledger;
}

export interface FakeContextOptions {
  id?: FeatureId;
  caps?: Capabilities;
  prefs?: Partial<PrefsSnapshot>;
  /** Share one bus between several contexts (e.g. sidebarWidget + expandAll). */
  bus?: ReturnType<typeof createFakeBus>;
  /** Background responder for ctx.send. */
  onSend?: (msg: ExtensionMessage) => ExtensionResponse | Promise<ExtensionResponse>;
  session?: Partial<Omit<PageSession, 'signal'>>;
}

export interface FakeContextHandle {
  ctx: FeatureContext;
  ledger: FakeLedger;
  /** Simulates unmount / session end: aborts the signal and reverts the ledger. */
  abort(): void;
  readonly sent: ExtensionMessage[];
  readonly reports: Diagnostic[];
  readonly statuses: FeatureStatus[];
  /** Errors swallowed by ctx.guard (the real host counts these toward the circuit breaker). */
  readonly errors: unknown[];
  setPrefs(prefs: Partial<PrefsSnapshot>): void;
  readonly hideEventsWrites: boolean[];
  emitScopeChange(change: ScopeChange): void;
}

export function createFakeContext(opts: FakeContextOptions = {}): FakeContextHandle {
  const id = opts.id ?? 'sidebarWidget';
  const controller = new AbortController();
  const signal = controller.signal;
  const ledger = createFakeLedger(id);
  const bus = (opts.bus ?? createFakeBus()).forSignal(signal);
  const sent: ExtensionMessage[] = [];
  const reports: Diagnostic[] = [];
  const statuses: FeatureStatus[] = [];
  const errors: unknown[] = [];
  const hideEventsWrites: boolean[] = [];
  const scopeListeners = new Map<ScopeId, Set<(c: ScopeChange) => void>>();
  let prefs: PrefsSnapshot = { ...DEFAULT_PREFS, ...opts.prefs };
  const prefListeners = new Set<(p: PrefsSnapshot) => void>();

  const session: PageSession = {
    generation: 1,
    navId: 'test-nav',
    url: new URL(window.location.href),
    facts: fakePageFacts(),
    ...opts.session,
    signal,
  };

  const prefsSource: PrefsSource = {
    current: () => prefs,
    onChange: (cb, s) => {
      if (s.aborted) return;
      prefListeners.add(cb);
      s.addEventListener('abort', () => prefListeners.delete(cb), { once: true });
    },
    setHideEvents: (hide) => {
      hideEventsWrites.push(hide);
    },
  };

  const guard: FeatureContext['guard'] =
    (fn) =>
    (...args) => {
      if (signal.aborted) return;
      try {
        const r = fn(...args);
        if (r instanceof Promise) r.catch((e) => errors.push(e));
      } catch (e) {
        errors.push(e);
      }
    };

  const ctx: FeatureContext = {
    id,
    session,
    signal,
    caps: opts.caps ?? createFakeCapabilities(),
    ledger,
    bus,
    prefs: prefsSource,
    guard,
    setTimer: (cb, ms) => {
      const t = setTimeout(guard(cb), ms);
      const cancel = () => clearTimeout(t);
      signal.addEventListener('abort', cancel, { once: true });
      return cancel;
    },
    delay: (ms) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        const t = setTimeout(resolve, ms);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true }
        );
      }),
    onScopeChange: (scope, cb) => {
      if (signal.aborted) return;
      const set = scopeListeners.get(scope) ?? new Set();
      scopeListeners.set(scope, set);
      set.add(cb);
      signal.addEventListener('abort', () => set.delete(cb), { once: true });
    },
    send: async <T,>(msg: ExtensionMessage): Promise<ExtensionResponse<T>> => {
      sent.push(msg);
      if (!opts.onSend) return { ok: false, error: 'no handler' };
      const res = await opts.onSend(msg);
      if (signal.aborted) return new Promise<ExtensionResponse<T>>(() => {});
      return res as ExtensionResponse<T>;
    },
    report: (d) => {
      reports.push(d);
    },
    setStatus: (s) => {
      statuses.push(s);
    },
  };

  return {
    ctx,
    ledger,
    abort: () => {
      controller.abort();
      ledger.revert();
    },
    sent,
    reports,
    statuses,
    errors,
    hideEventsWrites,
    setPrefs: (p) => {
      prefs = { ...prefs, ...p };
      for (const cb of Array.from(prefListeners)) cb(prefs);
    },
    emitScopeChange: (change) => {
      for (const cb of Array.from(scopeListeners.get(change.scope) ?? [])) cb(change);
    },
  };
}
