/**
 * Test fakes for the capability layer (docs/internal/extension_dom_engine_design.md section 11.5).
 *
 * Features are tested against these instead of GitHub markup, so feature tests never contain
 * GitHub selectors. Elements are real DOM nodes (jsdom) so ledger insertions can be asserted.
 */
import type {
  ActionsCap,
  Capabilities,
  ComposerCap,
  HiddenItemsInfo,
  InsertionPoint,
  LoadResult,
  LoadUntilOptions,
  NavigationCap,
  PageCap,
  SidebarCap,
  TimelineAuthor,
  TimelineCap,
  TimelineItem,
  TimelineItemKind,
  TimelineRow,
  ToastHandle,
} from '../../content/capabilities/types';
import type { PageFacts } from '../../content/dom/types';

export function fakePageFacts(overrides: Partial<PageFacts> = {}): PageFacts {
  return {
    kind: 'issue',
    item: { owner: 'octo', repo: 'deck', number: 1, itemId: 'octo/deck#1' },
    viewerLogin: 'octodeck-viewer',
    signedIn: true,
    locked: false,
    archived: false,
    ghRelease: null,
    variants: {},
    ...overrides,
  };
}

export function createFakePage(facts: Partial<PageFacts> = {}): PageCap & { setFacts(f: Partial<PageFacts>): void } {
  let current = fakePageFacts(facts);
  return {
    facts: () => current,
    setFacts: (f) => {
      current = { ...current, ...f };
    },
  };
}

export interface FakeRowSpec {
  el?: Element;
  kind?: TimelineItemKind;
  anchors?: string[];
  timestamp?: number | null;
}

export interface FakeItemSpec {
  el?: Element;
  nodeId?: string | null;
  kind?: TimelineItemKind;
  anchors?: string[];
  /** Defaults to one row mirroring the item. */
  rows?: FakeRowSpec[];
  author?: TimelineAuthor | null;
  timestamp?: number | null;
  /** true creates a body element inside the item; an Element is used as-is. */
  body?: boolean | Element | null;
  /** Optional text placed in the item element (and body when created). */
  text?: string;
}

/** Builds a TimelineItem backed by a real element (created when not supplied). */
export function createFakeTimelineItem(spec: FakeItemSpec = {}): TimelineItem {
  const el = spec.el ?? document.createElement('div');
  if (spec.nodeId && !el.getAttribute('data-fake-node-id')) el.setAttribute('data-fake-node-id', spec.nodeId);
  let bodyEl: Element | null = null;
  if (spec.body instanceof Element) {
    bodyEl = spec.body;
  } else if (spec.body) {
    bodyEl = document.createElement('div');
    bodyEl.textContent = spec.text ?? '';
    el.appendChild(bodyEl);
  } else if (spec.text) {
    el.textContent = spec.text;
  }
  const kind = spec.kind ?? 'comment';
  const timestamp = spec.timestamp ?? null;
  const rows: TimelineRow[] = (spec.rows ?? [{ el, kind, anchors: spec.anchors, timestamp }]).map((r) => {
    const rowEl = r.el ?? el;
    if (rowEl !== el && !rowEl.parentElement) el.appendChild(rowEl);
    return {
      el: rowEl,
      kind: r.kind ?? kind,
      kindSource: 'gid' as const,
      anchors: r.anchors ?? [],
      timestamp: () => r.timestamp ?? null,
    };
  });
  return {
    el,
    nodeId: spec.nodeId ?? null,
    kind,
    anchors: spec.anchors ?? [],
    rows: () => rows,
    author: () => spec.author ?? null,
    timestamp: () => timestamp,
    body: () => bodyEl,
  };
}

export interface FakeTimelineOptions {
  items?: TimelineItem[];
  /** Container the item elements are appended to (created and attached to document.body when omitted). */
  root?: Element;
  hidden?: HiddenItemsInfo[];
  supportsLoadMore?: boolean;
  /** Scripted loadUntil; default resolves 'exhausted' immediately. */
  loadUntil?: (pred: () => boolean, opts: LoadUntilOptions) => Promise<LoadResult>;
  focusedLoad?: (hash: string) => Promise<boolean>;
  reveal?: (target: Element | HiddenItemsInfo) => Promise<boolean>;
}

export type FakeTimeline = TimelineCap & {
  readonly root: Element;
  setItems(items: TimelineItem[]): void;
  /** Appends items to the DOM and the list, then notifies onItemsAdded listeners. */
  addItems(items: TimelineItem[]): void;
  setHidden(hidden: HiddenItemsInfo[]): void;
};

export function createFakeTimeline(opts: FakeTimelineOptions = {}): FakeTimeline {
  const root = opts.root ?? document.body.appendChild(document.createElement('div'));
  let items: TimelineItem[] = [];
  let hidden = opts.hidden ?? [];
  const listeners = new Set<(added: readonly TimelineItem[]) => void>();
  const attach = (list: TimelineItem[]) => {
    for (const item of list) if (!item.el.parentElement) root.appendChild(item.el);
  };
  items = opts.items ?? [];
  attach(items);

  return {
    root,
    items: () => items,
    supportsLoadMore: () => opts.supportsLoadMore ?? false,
    hidden: () => hidden,
    loadUntil: (pred, o) =>
      opts.loadUntil ? opts.loadUntil(pred, o) : Promise.resolve({ status: 'exhausted', added: 0, batches: 0 }),
    focusedLoad: (hash) => (opts.focusedLoad ? opts.focusedLoad(hash) : Promise.resolve(false)),
    findByAnchor: (hash) => {
      for (const item of items) {
        if (!item.anchors.includes(hash)) continue;
        const target = item.el.querySelector(`#${CSS.escape(hash)}`) ?? item.el;
        return { item, target };
      }
      return null;
    },
    reveal: (target) => (opts.reveal ? opts.reveal(target) : Promise.resolve(false)),
    onItemsAdded: (cb, signal) => {
      if (signal.aborted) return;
      listeners.add(cb);
      signal.addEventListener('abort', () => listeners.delete(cb), { once: true });
    },
    setItems: (list) => {
      items = list;
      attach(items);
    },
    addItems: (list) => {
      attach(list);
      items = [...items, ...list];
      for (const cb of Array.from(listeners)) cb(list);
    },
    setHidden: (h) => {
      hidden = h;
    },
  };
}

/** Composer/sidebar fakes return whatever insertion point the test supplies. */
export function createFakeComposer(submit: Element | null, point?: InsertionPoint | null): ComposerCap {
  return {
    submitButton: () => submit,
    insertionPoint: () => (point !== undefined ? point : submit ? { before: submit } : null),
  };
}

export function createFakeSidebar(point: InsertionPoint | null): SidebarCap {
  return { insertionPoint: () => point };
}

export type FakeNavigation = NavigationCap & {
  setHash(hash: string): void;
  readonly highlighted: Element[];
  readonly toasts: Array<{ text: string; dismissed: boolean }>;
};

export function createFakeNavigation(initialHash = ''): FakeNavigation {
  let hash = initialHash;
  const listeners = new Set<(h: string) => void>();
  const highlighted: Element[] = [];
  const toasts: Array<{ text: string; dismissed: boolean }> = [];
  return {
    hash: () => hash,
    onHash: (cb, signal) => {
      if (signal.aborted) return;
      listeners.add(cb);
      signal.addEventListener('abort', () => listeners.delete(cb), { once: true });
    },
    scrollToAndHighlight: (target) => {
      highlighted.push(target);
    },
    showToast: (text, { signal }): ToastHandle => {
      const entry = { text, dismissed: false };
      toasts.push(entry);
      const dismiss = () => {
        entry.dismissed = true;
      };
      signal.addEventListener('abort', dismiss, { once: true });
      return {
        update: (t) => {
          entry.text = t;
        },
        dismiss,
      };
    },
    setHash: (h) => {
      hash = h;
      for (const cb of Array.from(listeners)) cb(h);
    },
    highlighted,
    toasts,
  };
}

export function createFakeActions(classify: ActionsCap['classify'] = () => null): ActionsCap {
  return { classify };
}

/** Full Capabilities with inert defaults; override any member. */
export function createFakeCapabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    page: createFakePage(),
    timeline: null,
    composer: null,
    sidebar: null,
    navigation: createFakeNavigation(),
    actions: createFakeActions(),
    ...overrides,
  };
}
