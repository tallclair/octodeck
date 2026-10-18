/**
 * Noise collapser (mutator; requires the timeline scope).
 *
 * - Collapses runs of noise comments (bot authors, including /apps/ authors per decision 13, and
 *   slash-command-only comments) into one dense OctoDeck box. Only plain comments can be noise:
 *   reviews, with or without comments, are never collapsed.
 * - With Hide events on, hides rows whose kind is positively identified as noise (decision 11
 *   allowlist) and that carry no body. A grouped item is hidden only when every row is.
 *
 * Collapse runs are made of whole timeline items; hiding is per row (design section 7). All page
 * changes go through the ledger, so unmount restores GitHub's DOM exactly.
 */
import {
  classifyNoise,
  computeCollapseRuns,
  extractFirstNonBlankLine,
  extractRemainingLines,
  hideSanityAnomaly,
  isCommentMultiLine,
  isRowHideable,
  type ClassifyEvidence,
} from '../../../logic/timelineClassify';
import type { TimelineCap, TimelineItem } from '../capabilities/types';
import type { Feature, FeatureContext, FeatureLedger, FeatureRegistration } from '../engine/types';
import { button, h } from './ui';

export const HIDDEN_EVENT_CLASS = 'octodeck-gh-hidden-event';
export const COLLAPSED_CLASS = 'octodeck-gh-collapsed-comment';

/** Coalesces bursts of timeline notifications into one regroup. */
const REGROUP_DELAY_MS = 50;

const MEDIA_TAGS = new Set(['IMG', 'SVG', 'IFRAME', 'CANVAS', 'VIDEO']);

interface DenseRow {
  key: string;
  expanded: boolean;
  restEl: HTMLElement | null;
  expandBtn: HTMLButtonElement | null;
  author: string;
}

interface Group {
  key: string;
  wrapper: HTMLElement;
  items: TimelineItem[];
}

/** Stable identity for an item across rescans (node id, then first anchor). */
function itemKey(item: TimelineItem, index: number): string {
  return item.nodeId ?? item.anchors[0] ?? `idx-${index}`;
}

/** Builds the "rest of the comment" element from a sanitized clone of the markdown body. */
export function createRestContentElement(ledger: FeatureLedger, bodyEl: Element | null, fallbackText: string): HTMLElement {
  const container = h('div', 'octodeck-gh-dense-rest');
  if (!bodyEl) {
    container.append(...linkifiedNodes(extractRemainingLines(fallbackText)));
    return container;
  }

  const clone = ledger.cloneForDisplay(bodyEl);
  let removedFirst = false;
  const removeFirstTextLine = (node: Node): void => {
    if (removedFirst) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const lines = (node.nodeValue || '').split('\n');
      const foundIdx = lines.findIndex((l) => l.trim());
      if (foundIdx !== -1) {
        const newText = lines
          .slice(foundIdx + 1)
          .join('\n')
          .replace(/^\n+/, '');
        if (newText) {
          node.nodeValue = newText;
        } else {
          const next = node.nextSibling;
          if (next && next.nodeName === 'BR') next.parentNode?.removeChild(next);
          node.parentNode?.removeChild(node);
        }
        removedFirst = true;
        return;
      }
    }
    for (const child of Array.from(node.childNodes)) {
      removeFirstTextLine(child);
      if (removedFirst) break;
    }
  };
  removeFirstTextLine(clone);

  const hasMedia = (node: Element): boolean =>
    MEDIA_TAGS.has(node.tagName.toUpperCase()) || Array.from(node.children).some(hasMedia);
  // Drop wrappers left empty by removing the first line.
  const cleanEmpty = (node: Element): void => {
    for (const child of Array.from(node.children)) cleanEmpty(child);
    if (node !== clone && !node.textContent?.trim() && !hasMedia(node)) node.parentNode?.removeChild(node);
  };
  cleanEmpty(clone);

  while (clone.firstChild) container.appendChild(clone.firstChild);
  return container;
}

/** Text with markdown links and bare URLs turned into safe anchors (no innerHTML). */
export function linkifiedNodes(text: string): Node[] {
  const nodes: Node[] = [];
  const urlRegex = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>"')]+)/g;
  const link = (href: string, label: string) => {
    const a = h('a', 'octodeck-gh-dense-link', label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  };
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(document.createTextNode(text.substring(lastIndex, match.index)));
    if (match[1]) {
      nodes.push(link(match[3], match[2]));
    } else if (match[4]) {
      let url = match[4];
      const trailing = url.match(/[.,:;!?)]+$/)?.[0] ?? '';
      if (trailing) url = url.slice(0, -trailing.length);
      nodes.push(link(url, url));
      if (trailing) nodes.push(document.createTextNode(trailing));
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(document.createTextNode(text.substring(lastIndex)));
  return nodes;
}

class NoiseCollapser implements Feature {
  readonly id = 'noiseCollapser' as const;
  readonly kind = 'mutator' as const;
  readonly pages = ['issue', 'pr-conversation'] as const;
  readonly requires = ['timeline'] as const;
  readonly after = ['sidebarWidget'] as const;

  private ctx!: FeatureContext;
  private timeline!: TimelineCap;
  private groups = new Map<string, Group>();
  private collapsed = new Set<Element>();
  private hidden = new Set<Element>();
  /** Item and row elements revealed on request (anchor navigation); never collapsed or hidden again this session. */
  private revealed = new Set<Element>();
  /** Dense rows the user expanded, kept across regroups. */
  private expandedKeys = new Set<string>();
  private loading = false;
  private scheduled = false;
  private anomalyReported = false;

  mount(ctx: FeatureContext): void {
    this.ctx = ctx;
    if (!ctx.caps.timeline) {
      ctx.setStatus({ health: 'notApplicable', detail: 'scope:timeline' });
      return;
    }
    this.timeline = ctx.caps.timeline;

    this.apply();

    const schedule = () => this.schedule();
    this.timeline.onItemsAdded(schedule, ctx.signal);
    ctx.bus.on('timeline:changed', schedule);
    ctx.bus.on('timeline:loading', (v) => {
      // Defer regrouping while expand-all / anchor-nav load batches; regroup once at the end.
      this.loading = v.phase !== 'end';
      if (v.phase === 'end') this.schedule();
    });
    ctx.onScopeChange('timeline', (change) => {
      if (change.rootReplaced || change.removedOwn.length > 0 || change.addedElements.length > 0) this.schedule();
    });
    ctx.prefs.onChange(() => this.apply(), ctx.signal);
    ctx.bus.on('reveal:request', ({ target }) => this.reveal(target));
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.ctx.setTimer(() => {
      this.scheduled = false;
      if (!this.loading) this.apply();
    }, REGROUP_DELAY_MS);
  }

  /** Recomputes hiding and collapse runs and applies only the differences to the page. */
  private apply(): void {
    const items = this.timeline.items();
    const prefs = this.ctx.prefs.current();
    const viewer = this.ctx.caps.page.facts().viewerLogin;

    // 1. Hide events (row granularity, allowlist).
    let desiredHidden = new Set<Element>();
    let fullyHidden = new Set<TimelineItem>();
    if (prefs.hideEvents) {
      const itemEvidence: ClassifyEvidence[] = [];
      const rowEvidence: ClassifyEvidence[] = [];
      for (const item of items) {
        const rows = item.rows();
        itemEvidence.push({ kind: item.kind, hasBody: item.body() !== null });
        for (const r of rows) rowEvidence.push({ kind: r.kind, kindSource: r.kindSource, hasBody: r.body() !== null });
        if (item.kind === 'description' || this.revealed.has(item.el)) continue;
        const hideRows = rows.filter(
          (r) => !this.revealed.has(r.el) && isRowHideable({ kind: r.kind, hasBody: r.body() !== null })
        );
        if (rows.length > 0 && hideRows.length === rows.length) {
          fullyHidden.add(item);
          desiredHidden.add(item.el);
        } else {
          for (const r of hideRows) if (r.el !== item.el) desiredHidden.add(r.el);
        }
      }
      const anomaly = hideSanityAnomaly(itemEvidence, rowEvidence);
      if (anomaly) {
        desiredHidden = new Set();
        fullyHidden = new Set();
        if (!this.anomalyReported) {
          this.anomalyReported = true;
          this.ctx.report({ code: 'DOM_CLASSIFY_ANOMALY', severity: 'warn', scope: 'timeline', message: anomaly });
          this.ctx.setStatus({ health: 'degraded', detail: 'classify-anomaly' });
        }
      }
    }
    this.syncClass(this.hidden, desiredHidden, HIDDEN_EVENT_CLASS);
    this.hidden = desiredHidden;

    // 2. Noise runs (whole items).
    const inputs = items.map((item) => {
      const author = item.author();
      const verdict = classifyNoise(
        {
          kind: item.kind,
          authorLogin: author?.login ?? '',
          isBotHint: author?.isBotHint ?? false,
          isApp: author?.isApp ?? false,
          bodyText: item.body()?.textContent?.trim() ?? '',
        },
        prefs.knownBots,
        viewer
      );
      return {
        isNoise: verdict.isNoise && !this.revealed.has(item.el),
        fullyHidden: fullyHidden.has(item),
        kind: item.kind,
      };
    });
    const runs = computeCollapseRuns(inputs, prefs.hideEvents).map((run) => run.map((i) => items[i]));

    const desiredKeys = new Set<string>();
    const desiredCollapsed = new Set<Element>();
    for (const run of runs) {
      const key = `run:${run.map((item) => itemKey(item, items.indexOf(item))).join(',')}`;
      desiredKeys.add(key);
      for (const item of run) desiredCollapsed.add(item.el);
      const existing = this.groups.get(key);
      if (existing) {
        // GitHub may have re-rendered around us; put the box back in front of the run.
        if (!existing.wrapper.isConnected) this.ctx.ledger.insert(existing.wrapper, { before: run[0].el });
        existing.items = run;
      } else {
        const wrapper = this.buildGroup(key, run);
        this.ctx.ledger.insert(wrapper, { before: run[0].el });
        this.groups.set(key, { key, wrapper, items: run });
      }
    }
    for (const [key, group] of Array.from(this.groups)) {
      if (desiredKeys.has(key)) continue;
      if (group.wrapper.isConnected) this.ctx.ledger.remove(group.wrapper);
      this.groups.delete(key);
    }
    this.syncClass(this.collapsed, desiredCollapsed, COLLAPSED_CLASS);
    this.collapsed = desiredCollapsed;
  }

  private syncClass(current: Set<Element>, desired: Set<Element>, cls: typeof HIDDEN_EVENT_CLASS | typeof COLLAPSED_CLASS): void {
    for (const el of current) if (!desired.has(el)) this.ctx.ledger.removeClass(el, cls);
    for (const el of desired) if (!current.has(el)) this.ctx.ledger.addClass(el, cls);
  }

  private buildGroup(key: string, run: readonly TimelineItem[]): HTMLElement {
    const parentTag = run[0].el.parentElement?.tagName;
    // Keep list semantics valid when GitHub's timeline is an <ol>/<ul>.
    const tag = parentTag === 'OL' || parentTag === 'UL' ? 'li' : 'div';
    const wrapper = this.ctx.ledger.create(tag, key);
    wrapper.className = 'octodeck-gh-dense-timeline-item';
    const variant = this.ctx.session.facts.variants.timeline;
    if (variant) wrapper.setAttribute('data-octodeck-variant', variant);

    const body = h('div', 'octodeck-gh-dense-body');
    const box = h('div', 'octodeck-gh-dense-box');
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Collapsed activity');
    const list = h('div', 'octodeck-gh-dense-list');
    run.forEach((item, i) => list.appendChild(this.buildRow(item, itemKey(item, i))));
    box.appendChild(list);
    body.appendChild(box);
    wrapper.appendChild(body);
    return wrapper;
  }

  private buildRow(item: TimelineItem, key: string): HTMLElement {
    const login = item.author()?.login;
    const author = login ? `@${login}` : '@ghost';
    const bodyEl = item.body();
    const bodyText = bodyEl?.textContent?.trim() ?? '';
    const isMultiLine = isCommentMultiLine(bodyText);

    const rowEl = h('div', 'octodeck-gh-dense-row');
    const previewEl = h('div', 'octodeck-gh-dense-preview');
    const contentEl = h('div', 'octodeck-gh-dense-content');
    contentEl.append(
      h('span', 'octodeck-gh-dense-author', author),
      h('span', 'octodeck-gh-dense-text', extractFirstNonBlankLine(bodyText) || '(empty comment)')
    );
    previewEl.appendChild(contentEl);
    rowEl.appendChild(previewEl);

    if (isMultiLine) {
      const row: DenseRow = {
        key,
        expanded: this.expandedKeys.has(key),
        restEl: createRestContentElement(this.ctx.ledger, bodyEl, bodyText),
        expandBtn: button('octodeck-gh-dense-expand-btn'),
        author,
      };
      row.expandBtn!.addEventListener(
        'click',
        this.ctx.guard((e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          this.toggleRow(row);
        })
      );
      this.renderRowState(row);
      previewEl.appendChild(row.expandBtn!);
      rowEl.appendChild(row.restEl!);
    }
    return rowEl;
  }

  private toggleRow(row: DenseRow): void {
    row.expanded = !row.expanded;
    if (row.expanded) this.expandedKeys.add(row.key);
    else this.expandedKeys.delete(row.key);
    this.renderRowState(row);
  }

  private renderRowState(row: DenseRow): void {
    if (!row.restEl || !row.expandBtn) return;
    row.restEl.hidden = !row.expanded;
    row.expandBtn.textContent = row.expanded ? '[-]' : '[+]';
    row.expandBtn.setAttribute('aria-label', `${row.expanded ? 'Collapse' : 'Expand'} comment from ${row.author}`);
    row.expandBtn.setAttribute('aria-expanded', String(row.expanded));
  }

  /**
   * Handles 'reveal:request' synchronously: un-collapses the item or un-hides the row containing
   * the target, so anchor navigation can scroll to it.
   */
  private reveal(target: Element): void {
    let changed = false;
    for (const item of this.timeline.items()) {
      if (!item.el.contains(target)) continue;
      if (this.collapsed.has(item.el) || this.hidden.has(item.el)) {
        this.revealed.add(item.el);
        changed = true;
      }
      for (const row of item.rows()) {
        if (row.el !== item.el && row.el.contains(target) && this.hidden.has(row.el)) {
          this.revealed.add(row.el);
          changed = true;
        }
      }
    }
    if (changed) this.apply();
  }
}

export const noiseCollapser: FeatureRegistration = {
  id: 'noiseCollapser',
  create: () => new NoiseCollapser(),
};
