/**
 * timeline capability: whole items and their rows, read through the recognized timeline variant
 * (design section 6.2). Loading is delegated to the variant's load adapter through the shared
 * bounded loader (capabilities/loadUntil.ts, WP2).
 */
import type { Diagnostic } from '../../types';
import type { Resolver } from '../dom/resolver';
import type { EventBus, ScopeChange } from '../engine/types';
import { isOwnNode } from '../engine/constants';
import type { TimelineAdapter, TimelineLoadAdapter, VariantModule } from '../variants/types';
import { gidPrefix, kindFromGid } from './timelineKinds';
import type {
  HiddenItemsInfo,
  LoadResult,
  TimelineAuthor,
  TimelineCap,
  TimelineItem,
  TimelineItemKind,
  TimelineRow,
} from './types';

/** Factory for the bounded loader (capabilities/loadUntil.ts). Injected so tests and WP2 stay decoupled. */
export type LoadUntilFactory = (deps: {
  items: () => readonly TimelineItem[];
  hidden: () => readonly HiddenItemsInfo[];
  adapter: TimelineLoadAdapter;
  bus?: EventBus;
  doc: Document;
  report?: (d: Diagnostic) => void;
}) => TimelineCap['loadUntil'];

export interface TimelineCapDeps {
  resolver: Resolver;
  module: VariantModule;
  doc: Document;
  /** Session bus; the loader emits timeline:loading / timeline:changed on it. */
  bus?: EventBus;
  /** Scope-change subscription (ScopedObserver); drives onItemsAdded. */
  onScopeChange: (scope: 'timeline', cb: (change: ScopeChange) => void, signal: AbortSignal) => void;
  report?: (d: Diagnostic) => void;
  createLoadUntil?: LoadUntilFactory;
}

const FOCUSED_LOAD_TIMEOUT_MS = 5000;
const NOT_SUPPORTED: LoadResult = { status: 'exhausted', added: 0, batches: 0 };

/** Lazily computed, memoized read. */
function lazy<T>(fn: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}

/** Normalizes a URL hash: strips '#', decodes percent-escapes (falls back to the raw text). */
function normalizeHash(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function createTimelineCap(deps: TimelineCapDeps): TimelineCap {
  const { resolver, module, doc } = deps;
  const adapter: TimelineAdapter | undefined = module.adapters.timeline;
  const load = module.adapters.load;
  const reportedPrefixes = new Set<string>();
  // Stable wrappers per element, so callers can compare items across calls.
  const wrappers = new WeakMap<Element, TimelineItem>();

  const root = (): Element | null => {
    const det = resolver.detection('timeline');
    return det?.status === 'recognized' && det.root?.isConnected ? det.root : null;
  };

  const reportUnknown = (nodeId: string | null) => {
    const prefix = gidPrefix(nodeId) ?? '(none)';
    if (reportedPrefixes.has(prefix)) return;
    reportedPrefixes.add(prefix);
    deps.report?.({ code: 'TIMELINE_UNKNOWN_KIND', severity: 'info', scope: 'timeline', anchor: 'timeline.item', message: `prefix ${prefix}` });
  };

  const makeRow = (el: Element, item: Element, itemKind: TimelineItemKind): TimelineRow => {
    const detected = adapter?.rowKind(el) ?? null;
    // A single row that is the item itself shares the item's kind.
    const kind = detected?.kind ?? (el === item ? itemKind : 'unknown');
    return {
      el,
      kind,
      kindSource: detected?.source ?? 'structure',
      anchors: adapter ? adapter.anchors(el) : [],
      timestamp: lazy(() => adapter?.timestamp(el) ?? null),
      body: lazy(() => adapter?.body(el) ?? null),
    };
  };

  const wrap = (el: Element): TimelineItem => {
    const cached = wrappers.get(el);
    if (cached) return cached;
    const nodeId = adapter?.itemNodeId(el) ?? null;
    const gidKind = kindFromGid(nodeId);
    const kind: TimelineItemKind = gidKind ?? 'unknown';
    if (kind === 'unknown') reportUnknown(nodeId);
    const item: TimelineItem = {
      el,
      nodeId,
      kind,
      anchors: adapter ? adapter.anchors(el) : [],
      // Not memoized: grouped items can gain rows through live updates.
      rows: () => (adapter ? adapter.rows(el) : [el]).map((r) => makeRow(r, el, kind)),
      author: lazy((): TimelineAuthor | null => adapter?.author(el) ?? null),
      timestamp: lazy(() => adapter?.timestamp(el) ?? null),
      body: lazy(() => adapter?.body(el) ?? null),
    };
    wrappers.set(el, item);
    return item;
  };

  const items = (): readonly TimelineItem[] => {
    const r = root();
    if (!r) return [];
    // Resolved with an explicit base so the result is never a stale memo (items are added live).
    return resolver.all('timeline.item', r).map(wrap);
  };

  const hidden = (): readonly HiddenItemsInfo[] => {
    const r = root();
    return r && load ? load.hidden(r) : [];
  };

  const loadUntil: TimelineCap['loadUntil'] =
    load && deps.createLoadUntil
      ? deps.createLoadUntil({ items, hidden, adapter: load, bus: deps.bus, doc, report: deps.report })
      : () => Promise.resolve(NOT_SUPPORTED);

  const findByAnchor = (hash: string): { item: TimelineItem; target: Element } | null => {
    const id = normalizeHash(hash);
    const r = root();
    if (!id || !r) return null;
    const list = items();
    const owning = (target: Element) => list.find((it) => it.el === target || it.el.contains(target)) ?? null;

    // 1. Exact id (getElementById: the hash is never interpolated into a selector).
    const exact = doc.getElementById(id);
    if (exact && r.contains(exact) && !isOwnNode(exact)) {
      const item = owning(exact);
      if (item) return { item, target: exact };
    }
    // 2. Suffix match: React variants may prefix anchor ids (e.g. "<prefix>-issuecomment-123").
    const suffixed = Array.from(r.querySelectorAll('[id]')).find(
      (el) => el.id.length > id.length && el.id.endsWith(id) && !/[A-Za-z0-9]/.test(el.id[el.id.length - id.length - 1]) && !isOwnNode(el)
    );
    if (suffixed) {
      const item = owning(suffixed);
      if (item) return { item, target: suffixed };
    }
    return null;
  };

  return {
    items,
    supportsLoadMore: () => Boolean(load?.supportsLoadMore()),
    hidden,
    loadUntil,
    focusedLoad: (hash, opts) =>
      load?.focusedLoad ? load.focusedLoad(normalizeHash(hash), { signal: opts.signal, timeoutMs: FOCUSED_LOAD_TIMEOUT_MS }) : Promise.resolve(false),
    findByAnchor,
    reveal: (target, opts) => (load ? load.reveal(target, opts) : Promise.resolve(false)),
    onItemsAdded: (cb, signal) => {
      const seen = new WeakSet<Element>(items().map((it) => it.el));
      deps.onScopeChange(
        'timeline',
        () => {
          const added = items().filter((it) => !seen.has(it.el));
          for (const it of added) seen.add(it.el);
          if (added.length > 0 && !signal.aborted) cb(added);
        },
        signal
      );
    },
  };
}
