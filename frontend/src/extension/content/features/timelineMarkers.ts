/**
 * Timeline markers (mutator; requires the timeline scope): "Acknowledged" and "Last Viewed"
 * dividers placed between whole timeline items, from the daemon item published on 'item:updated'.
 */
import type { Item } from '../../../api/octodeck/v1/resources_pb';
import { getAckedActivityMs } from '../../../logic/ackState';
import { calculateTimelineMarkerIndices } from '../../../logic/timelineClassify';
import { getEffectiveLastViewedMs, getOwnActivityViewedMs } from '../../../logic/viewState';
import type { TimelineCap } from '../capabilities/types';
import { isOwnNode } from '../engine/constants';
import type { BusEvents, Feature, FeatureContext, FeatureRegistration } from '../engine/types';
import { h } from './ui';

export type MarkerType = 'acked' | 'viewed';

const MARKER_LABELS: Record<MarkerType, string> = { acked: 'Acknowledged', viewed: 'Last Viewed' };

/** Coalesces bursts of timeline notifications into one re-render. */
const RENDER_DELAY_MS = 50;

class TimelineMarkers implements Feature {
  readonly id = 'timelineMarkers' as const;
  readonly kind = 'mutator' as const;
  readonly pages = ['issue', 'pr-conversation'] as const;
  readonly requires = ['timeline'] as const;
  readonly after = ['noiseCollapser'] as const;

  private ctx!: FeatureContext;
  private timeline!: TimelineCap;
  private item: Item | null = null;
  private markers: Partial<Record<MarkerType, HTMLElement>> = {};
  // The effective last-viewed time when the page was first shown. Held so that recording this
  // visit (which moves last_viewed_at to now) doesn't hide what was new on arrival.
  private initialLastViewedAtMs: number | null = null;
  // The latest own activity reported by the daemon while on the page. The user has seen
  // everything up to their own latest action, so "Last Viewed" never sits before it, even though
  // the initial view time is held.
  private ownActivityViewedMs: number | null = null;
  private hasEvaluatedInitialView = false;
  private viewMarkerShown = false;
  private scheduled = false;

  mount(ctx: FeatureContext): void {
    this.ctx = ctx;
    if (!ctx.caps.timeline) {
      ctx.setStatus({ health: 'notApplicable', detail: 'scope:timeline' });
      return;
    }
    this.timeline = ctx.caps.timeline;

    const last = ctx.bus.last('item:updated');
    if (last) this.update(last);
    ctx.bus.on('item:updated', (v) => this.update(v));

    const schedule = () => this.schedule();
    this.timeline.onItemsAdded(schedule, ctx.signal);
    ctx.bus.on('timeline:changed', schedule);
    // The Last Viewed position may fall inside a newly loaded range: recompute after each batch.
    ctx.bus.on('timeline:loading', (v) => {
      if (v.phase !== 'start') schedule();
    });
    ctx.onScopeChange('timeline', (change) => {
      if (change.rootReplaced || change.removedOwn.length > 0 || change.addedElements.length > 0) schedule();
    });
  }

  private update(v: BusEvents['item:updated']): void {
    // Keep the last known markers while the daemon is unavailable.
    if (v.daemon !== 'ok' || !v.item) return;
    const prevView = getEffectiveLastViewedMs(this.item?.local);
    const prevAck = getAckedActivityMs(this.item?.local);
    const newView = getEffectiveLastViewedMs(v.item.local);
    const newAck = getAckedActivityMs(v.item.local);
    const hadMarkers = Object.values(this.markers).some((m) => m?.isConnected);

    this.item = v.item;
    this.recordViewState();
    if (prevView !== newView || prevAck !== newAck || (!hadMarkers && (Boolean(newView) || Boolean(newAck)))) {
      this.render();
    }
  }

  /** Captures the initial view time and the latest own activity from the current item. */
  private recordViewState(): void {
    const local = this.item?.local;
    const view = getEffectiveLastViewedMs(local);
    if (this.initialLastViewedAtMs === null && view !== null) this.initialLastViewedAtMs = view;
    const own = getOwnActivityViewedMs(local);
    if (own !== null && (this.ownActivityViewedMs === null || own > this.ownActivityViewedMs)) {
      this.ownActivityViewedMs = own;
    }
  }

  /** The time the "Last Viewed" marker follows: the held initial view, raised to own activity. */
  private markerLastViewedMs(): number | null {
    const view = this.initialLastViewedAtMs ?? getEffectiveLastViewedMs(this.item?.local);
    if (view === null) return this.ownActivityViewedMs;
    if (this.ownActivityViewedMs === null) return view;
    return Math.max(view, this.ownActivityViewedMs);
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.ctx.setTimer(() => {
      this.scheduled = false;
      this.render();
    }, RENDER_DELAY_MS);
  }

  private render(): void {
    const targets: Partial<Record<MarkerType, Element>> = {};
    const local = this.item?.local;
    const lastViewedAtMs = local ? this.markerLastViewedMs() : null;
    const ackedActivityMs = local ? getAckedActivityMs(local) : null;

    if ((lastViewedAtMs && lastViewedAtMs > 0) || (ackedActivityMs && ackedActivityMs > 0)) {
      const entries: Array<{ el: Element; timestamp: number }> = [];
      for (const item of this.timeline.items()) {
        const ts = item.timestamp();
        if (ts !== null && ts > 0) entries.push({ el: item.el, timestamp: ts });
      }
      if (entries.length > 0) {
        const { showViewIndex, showAckIndex } = calculateTimelineMarkerIndices(
          entries,
          lastViewedAtMs,
          ackedActivityMs,
          this.hasEvaluatedInitialView ? { wasViewMarkerShown: this.viewMarkerShown } : undefined
        );
        if (!this.hasEvaluatedInitialView) {
          this.hasEvaluatedInitialView = true;
          this.viewMarkerShown = showViewIndex !== -1;
        }
        if (showAckIndex !== -1) targets.acked = entries[showAckIndex].el;
        // At the same position only the Acknowledged marker is shown.
        if (showViewIndex !== -1 && showViewIndex !== showAckIndex) targets.viewed = entries[showViewIndex].el;
      }
    }

    // Place the earlier marker first so the walk-back in insertionTarget sees a stable layout.
    for (const type of ['acked', 'viewed'] as const) {
      const target = targets[type];
      const marker = this.markers[type];
      if (!target) {
        if (marker?.isConnected) this.ctx.ledger.remove(marker);
        continue;
      }
      const el = marker ?? this.createMarker(type);
      const before = this.insertionTarget(target);
      if (!el.isConnected || el.nextElementSibling !== before) this.ctx.ledger.insert(el, { before });
    }
  }

  /**
   * Markers go right before the target item, and before any other OctoDeck nodes attached in front
   * of it (e.g. a collapsed-noise box that stands in for the item).
   */
  private insertionTarget(itemEl: Element): Element {
    let target = itemEl;
    let prev = itemEl.previousElementSibling;
    while (prev && isOwnNode(prev) && !this.isMarker(prev)) {
      target = prev;
      prev = prev.previousElementSibling;
    }
    return target;
  }

  private isMarker(el: Element): boolean {
    return el === this.markers.acked || el === this.markers.viewed;
  }

  private createMarker(type: MarkerType): HTMLElement {
    const target = this.timeline.items()[0]?.el.parentElement?.tagName;
    // Keep list semantics valid when GitHub's timeline is an <ol>/<ul>.
    const tag = target === 'OL' || target === 'UL' ? 'li' : 'div';
    const wrapper = this.ctx.ledger.create(tag, `marker-${type}`);
    wrapper.className = `octodeck-gh-timeline-marker octodeck-gh-timeline-marker-${type}`;
    wrapper.setAttribute('data-testid', `octodeck-timeline-marker-${type}`);
    wrapper.setAttribute('role', 'separator');
    wrapper.setAttribute('aria-label', MARKER_LABELS[type]);
    const variant = this.ctx.session.facts.variants.timeline;
    if (variant) wrapper.setAttribute('data-octodeck-variant', variant);

    const body = h('div', 'octodeck-gh-timeline-marker-body');
    const divider = h('div', 'octodeck-gh-timeline-marker-divider');
    divider.append(
      h('div', 'octodeck-gh-timeline-marker-line'),
      h('span', 'octodeck-gh-timeline-marker-label', MARKER_LABELS[type]),
      h('div', 'octodeck-gh-timeline-marker-line')
    );
    body.appendChild(divider);
    wrapper.appendChild(body);
    this.markers[type] = wrapper;
    return wrapper;
  }
}

export const timelineMarkers: FeatureRegistration = {
  id: 'timelineMarkers',
  create: () => new TimelineMarkers(),
};
