/**
 * ScopedObserver: the engine's single MutationObserver
 * (docs/internal/extension_dom_engine_design.md section 5.3).
 *
 * Observes <html> (so Turbo body swaps don't kill it), drops mutations inside OctoDeck nodes,
 * attributes the rest to scopes by root containment, coalesces with a trailing debounce, and
 * delivers removal-only records of OctoDeck nodes so owners can re-insert.
 */
import type { ScopeId } from '../dom/types';
import { isOwnNode, OWN_ATTR, OWN_SELECTOR } from './constants';
import type { ScopeChange } from './types';

export interface ScopedObserverOptions {
  /** Current scope roots (re-read on every flush, so re-detected roots are picked up). */
  getRoots: () => Partial<Record<ScopeId, Element | undefined>>;
  /** Called before delivery when scope roots were detached, so the session can re-detect them. */
  onRootsDetached?: (scopes: ScopeId[]) => void;
  /** Called when <body> itself was replaced. */
  onBodySwap?: () => void;
  debounceMs?: number;
}

interface Pending {
  added: Set<Element>;
  removedOwn: Set<Element>;
}

export class ScopedObserver {
  private observer: MutationObserver | null = null;
  private readonly subscribers = new Map<ScopeId, Set<(c: ScopeChange) => void>>();
  private pending = new Map<ScopeId, Pending>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private bodySwapped = false;
  private readonly debounceMs: number;

  constructor(private readonly opts: ScopedObserverOptions) {
    this.debounceMs = opts.debounceMs ?? 150;
  }

  start(target: Node = document.documentElement): void {
    if (this.observer || typeof MutationObserver === 'undefined') return;
    this.observer = new MutationObserver((records) => this.ingest(records));
    this.observer.observe(target, { childList: true, subtree: true });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.subscribers.clear();
  }

  subscribe(scope: ScopeId, cb: (change: ScopeChange) => void, signal: AbortSignal): void {
    if (signal.aborted) return;
    const set = this.subscribers.get(scope) ?? new Set();
    this.subscribers.set(scope, set);
    set.add(cb);
    signal.addEventListener('abort', () => set.delete(cb), { once: true });
  }

  /** Exposed for tests: process records synchronously (normally called by the MutationObserver). */
  ingest(records: readonly MutationRecord[]): void {
    const roots = this.opts.getRoots();
    let touched = false;
    for (const record of records) {
      // Changes inside our own nodes never matter to anyone.
      if (isOwnNode(record.target)) continue;

      // nodeType checks (not instanceof) keep this working across realms and after test teardown.
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType !== 1 || isOwnNode(node)) continue;
        const added = node as Element;
        if (added.tagName === 'BODY') this.bodySwapped = true;
        for (const scope of scopesFor(record.target, roots)) {
          this.bucket(scope).added.add(added);
          touched = true;
        }
      }

      for (const node of Array.from(record.removedNodes)) {
        if (node.nodeType !== 1) continue;
        const removed = node as Element;
        const own = removed.hasAttribute(OWN_ATTR) ? [removed] : Array.from(removed.querySelectorAll(OWN_SELECTOR));
        const hadRoot = containsAnyRoot(removed, roots);
        if (own.length === 0 && !hadRoot) continue;
        for (const scope of scopesFor(record.target, roots)) {
          const bucket = this.bucket(scope);
          for (const el of own) bucket.removedOwn.add(el);
          touched = true;
        }
        if (hadRoot) touched = true;
      }
    }
    if (touched || this.bodySwapped) this.schedule();
  }

  private bucket(scope: ScopeId): Pending {
    let p = this.pending.get(scope);
    if (!p) {
      p = { added: new Set(), removedOwn: new Set() };
      this.pending.set(scope, p);
    }
    return p;
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  /** Delivers coalesced changes. Exposed for tests. */
  flush(): void {
    this.timer = null;
    if (this.bodySwapped) {
      this.bodySwapped = false;
      this.opts.onBodySwap?.();
    }
    const roots = this.opts.getRoots();
    const detached = (Object.keys(roots) as ScopeId[]).filter((s) => roots[s] && !roots[s]!.isConnected);
    if (detached.length > 0) this.opts.onRootsDetached?.(detached);

    const pending = this.pending;
    this.pending = new Map();
    const scopes = new Set<ScopeId>([...pending.keys(), ...detached]);
    for (const scope of scopes) {
      const p = pending.get(scope);
      const change: ScopeChange = {
        scope,
        addedElements: p ? Array.from(p.added).filter((el) => el.isConnected) : [],
        removedOwn: p ? Array.from(p.removedOwn).filter((el) => !el.isConnected) : [],
        rootReplaced: detached.includes(scope),
      };
      if (!change.rootReplaced && change.addedElements.length === 0 && change.removedOwn.length === 0) continue;
      for (const cb of Array.from(this.subscribers.get(scope) ?? [])) cb(change);
    }
  }
}

/** Scopes whose root contains the mutation target (or that the target contains, e.g. a re-rendered wrapper). */
function scopesFor(target: Node, roots: Partial<Record<ScopeId, Element | undefined>>): ScopeId[] {
  const out: ScopeId[] = [];
  for (const scope of Object.keys(roots) as ScopeId[]) {
    const root = roots[scope];
    if (!root) continue;
    if (root === target || root.contains(target) || target.contains(root)) out.push(scope);
  }
  return out;
}

function containsAnyRoot(node: Element, roots: Partial<Record<ScopeId, Element | undefined>>): boolean {
  return Object.values(roots).some((root) => root !== undefined && (node === root || node.contains(root)));
}
