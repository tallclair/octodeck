/**
 * MutationLedger: the only way features change the page
 * (docs/internal/extension_dom_engine_design.md section 5.5).
 *
 * Allowed on GitHub nodes: inserting OctoDeck-created siblings/children, adding/removing
 * `octodeck-gh-*` classes, and setting `data-octodeck-*` attributes. Everything is recorded so
 * revert() restores GitHub's DOM. Operations after the feature's signal aborts are ignored.
 */
import type { FeatureId } from '../dom/types';
import { OWN_ATTR, OWN_CLASS_PREFIX, OWN_KEY_ATTR, OWN_SELECTOR } from './constants';
import type { FeatureLedger, LedgerPosition, OwnClass, OwnDataName } from './types';

export interface LedgerOptions {
  /** Max re-insertions of keyed nodes removed by someone else, per feature, within the window. */
  reinjectLimit?: number;
  reinjectWindowMs?: number;
  now?: () => number;
  /** Called once per feature when its re-inject budget is exceeded (the host trips the breaker). */
  onBudgetExceeded?: (feature: FeatureId) => void;
}

interface FeatureRecord {
  created: Set<Element>;
  /** [element, class, whether the element had a class attribute before]. */
  classes: Array<[Element, string, boolean]>;
  data: Array<[Element, string, string | null]>;
  /** Last inserted node per key, to detect external removal before a re-insert. */
  keyed: Map<string, Element>;
  removedByLedger: WeakSet<Element>;
  reinjectTimes: number[];
  budgetTripped: boolean;
}

function newRecord(): FeatureRecord {
  return {
    created: new Set(),
    classes: [],
    data: [],
    keyed: new Map(),
    removedByLedger: new WeakSet(),
    reinjectTimes: [],
    budgetTripped: false,
  };
}

const STRIP_ON_CLONE = new Set(['id', 'for', 'name']);

export class MutationLedger {
  private readonly records = new Map<FeatureId, FeatureRecord>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: LedgerOptions = {}) {
    this.limit = opts.reinjectLimit ?? 5;
    this.windowMs = opts.reinjectWindowMs ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  private record(id: FeatureId): FeatureRecord {
    let rec = this.records.get(id);
    if (!rec) {
      rec = newRecord();
      this.records.set(id, rec);
    }
    return rec;
  }

  /** A ledger view bound to one feature mount. */
  forFeature(id: FeatureId, signal: AbortSignal): FeatureLedger {
    const rec = this.record(id);
    const live = () => !signal.aborted;
    const assertOwn = (node: Element) => {
      if (node.getAttribute(OWN_ATTR) !== id || !rec.created.has(node)) {
        throw new Error(`[OctoDeck] ledger(${id}): node was not created by this feature`);
      }
    };

    return {
      create: (tag, key) => {
        const el = document.createElement(tag);
        el.setAttribute(OWN_ATTR, id);
        if (key) el.setAttribute(OWN_KEY_ATTR, key);
        rec.created.add(el);
        return el;
      },
      insert: (node, where) => {
        if (!live()) return;
        assertOwn(node);
        const key = node.getAttribute(OWN_KEY_ATTR);
        if (key) this.trackKeyedInsert(id, rec, key, node);
        place(node, where);
      },
      remove: (node) => {
        if (!live()) return;
        assertOwn(node);
        rec.removedByLedger.add(node);
        node.remove();
      },
      addClass: (el, cls) => {
        if (!live()) return;
        assertOwnClass(cls);
        if (el.classList.contains(cls)) return;
        const hadClassAttr = el.hasAttribute('class');
        el.classList.add(cls);
        rec.classes.push([el, cls, hadClassAttr]);
      },
      removeClass: (el, cls: OwnClass) => {
        if (!live()) return;
        assertOwnClass(cls);
        el.classList.remove(cls);
      },
      setData: (el, name: OwnDataName, value) => {
        if (!live()) return;
        if (!name.startsWith('octodeck-')) throw new Error(`[OctoDeck] ledger(${id}): data-${name} is not an OctoDeck attribute`);
        const attr = `data-${name}`;
        rec.data.push([el, attr, el.getAttribute(attr)]);
        el.setAttribute(attr, value);
      },
      cloneForDisplay: (el) => cloneForDisplay(el),
      revert: () => this.revert(id),
    };
  }

  private trackKeyedInsert(id: FeatureId, rec: FeatureRecord, key: string, node: Element): void {
    const prev = rec.keyed.get(key);
    rec.keyed.set(key, node);
    if (!prev || prev.isConnected || rec.removedByLedger.has(prev)) return;
    // The previous node with this key was detached by someone else and we are putting it back.
    const t = this.now();
    rec.reinjectTimes = rec.reinjectTimes.filter((x) => t - x < this.windowMs);
    rec.reinjectTimes.push(t);
    if (rec.reinjectTimes.length > this.limit && !rec.budgetTripped) {
      rec.budgetTripped = true;
      this.opts.onBudgetExceeded?.(id);
    }
  }

  /** Undo everything a feature did. Idempotent; also resets its re-inject budget. */
  revert(id: FeatureId): void {
    const rec = this.records.get(id);
    if (!rec) return;
    for (const el of rec.created) el.remove();
    for (const [el, cls, hadClassAttr] of rec.classes) {
      el.classList.remove(cls);
      // Restore byte-identical markup: drop the empty class attribute we caused.
      if (!hadClassAttr && el.classList.length === 0) el.removeAttribute('class');
    }
    for (const [el, attr, prev] of rec.data.reverse()) {
      if (prev === null) el.removeAttribute(attr);
      else el.setAttribute(attr, prev);
    }
    this.records.delete(id);
  }

  revertAll(): void {
    for (const id of Array.from(this.records.keys())) this.revert(id);
  }

  /** Nodes currently created (and not reverted) by a feature; for tests and health checks. */
  createdBy(id: FeatureId): Element[] {
    return Array.from(this.records.get(id)?.created ?? []);
  }
}

function assertOwnClass(cls: string): void {
  if (!cls.startsWith(OWN_CLASS_PREFIX)) throw new Error(`[OctoDeck] ledger: class ${cls} is not an OctoDeck class`);
}

function place(node: Element, where: LedgerPosition): void {
  if ('before' in where) where.before.parentNode?.insertBefore(node, where.before);
  else if ('after' in where) where.after.parentNode?.insertBefore(node, where.after.nextSibling);
  else where.appendTo.appendChild(node);
}

/** Deep clone for display: strips id/for/name, inline handlers and any nested OctoDeck nodes. */
export function cloneForDisplay<E extends Element>(el: E): E {
  const clone = el.cloneNode(true) as E;
  for (const own of Array.from(clone.querySelectorAll(OWN_SELECTOR))) own.remove();
  for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    for (const attr of Array.from(node.attributes)) {
      if (STRIP_ON_CLONE.has(attr.name) || attr.name.startsWith('on')) node.removeAttribute(attr.name);
    }
  }
  return clone;
}

/**
 * Boot hygiene: removes nodes and classes left behind by an orphaned earlier instance of the
 * content script (section 5.2, guarantee 7).
 */
export function sweepStaleOwnState(root: ParentNode = document): void {
  for (const el of Array.from(root.querySelectorAll(OWN_SELECTOR))) el.remove();
  for (const el of Array.from(root.querySelectorAll(`[class*="${OWN_CLASS_PREFIX}"]`))) {
    for (const cls of Array.from(el.classList)) if (cls.startsWith(OWN_CLASS_PREFIX)) el.classList.remove(cls);
  }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('data-octodeck-') && attr.name !== 'data-octodeck-instance') el.removeAttribute(attr.name);
    }
  }
}
