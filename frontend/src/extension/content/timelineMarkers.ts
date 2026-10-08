import type { Item } from '../../api/octodeck/v1/resources_pb';
import { getAckedActivityMs, isAfterWatermark } from '../../logic/ackState';
import { getEffectiveLastViewedMs, getOwnActivityViewedMs } from '../../logic/viewState';
import { queryTimelineElements } from './noiseCollapser';

export function extractElementTimestamp(el: HTMLElement): number | null {
  const timeEl = el.querySelector<HTMLElement>('relative-time, time, time-ago, local-time, [datetime]');
  if (timeEl) {
    const dt = timeEl.getAttribute('datetime') || timeEl.getAttribute('data-datetime');
    if (dt) {
      const ms = Date.parse(dt);
      if (!isNaN(ms) && ms > 0) return ms;
    }
  }
  return null;
}

export interface MarkerIndices {
  showViewIndex: number;
  showAckIndex: number;
}

export function calculateTimelineMarkerIndices(
  items: Array<{ timestamp: number }>,
  lastViewedAtMs: number | null,
  ackedActivityMs: number | null,
  options?: { wasViewMarkerShown?: boolean }
): MarkerIndices {
  if (items.length === 0) {
    return { showViewIndex: -1, showAckIndex: -1 };
  }

  // Both markers go before the first entry newer than their timestamp, compared at whole-second
  // precision: the effective last-viewed time may be the GitHub timestamp of the user's own
  // activity, which must not be placed after its own (possibly millisecond-precision) DOM entry.
  const newViewIndex =
    lastViewedAtMs && lastViewedAtMs > 0
      ? items.findIndex((item) => isAfterWatermark(item.timestamp, lastViewedAtMs))
      : -1;

  const newAckIndex =
    ackedActivityMs && ackedActivityMs > 0
      ? items.findIndex((item) => isAfterWatermark(item.timestamp, ackedActivityMs))
      : -1;

  // Suppress "Last Viewed" if:
  // 1. Both would appear at the exact same timeline position (newViewIndex === newAckIndex)
  // 2. Both are at the end (-1)
  const suppressLastViewed =
    ackedActivityMs !== null &&
    ackedActivityMs !== undefined &&
    ackedActivityMs > 0 &&
    ((newViewIndex !== -1 && newViewIndex === newAckIndex) ||
      (newViewIndex === -1 && newAckIndex === -1));

  let showViewIndex = suppressLastViewed ? -1 : newViewIndex;
  if (options?.wasViewMarkerShown === false) {
    showViewIndex = -1;
  }
  const showAckIndex = newAckIndex;

  return { showViewIndex, showAckIndex };
}

export function createMarkerElement(type: 'acked' | 'viewed'): HTMLElement {
  if (typeof document === 'undefined') {
    return {} as HTMLElement;
  }
  const wrapper = document.createElement('div');
  wrapper.className = `TimelineItem octodeck-gh-timeline-marker octodeck-gh-timeline-marker-${type}`;
  wrapper.setAttribute('data-testid', `octodeck-timeline-marker-${type}`);

  const body = document.createElement('div');
  body.className = 'TimelineItem-body octodeck-gh-timeline-marker-body';

  const divider = document.createElement('div');
  divider.className = 'octodeck-gh-timeline-marker-divider';

  const lineLeft = document.createElement('div');
  lineLeft.className = 'octodeck-gh-timeline-marker-line';

  const label = document.createElement('span');
  label.className = 'octodeck-gh-timeline-marker-label';
  label.textContent = type === 'acked' ? 'Acknowledged' : 'Last Viewed';

  const lineRight = document.createElement('div');
  lineRight.className = 'octodeck-gh-timeline-marker-line';

  divider.appendChild(lineLeft);
  divider.appendChild(label);
  divider.appendChild(lineRight);
  body.appendChild(divider);
  wrapper.appendChild(body);

  return wrapper;
}

export function getMarkerInsertionTarget(el: HTMLElement): HTMLElement {
  // If the target element was collapsed or dense-wrapped, find the dense wrapper if it precedes it
  const prev = el.previousElementSibling as HTMLElement | null;
  if (prev && prev.classList.contains('octodeck-gh-dense-timeline-item')) {
    return prev;
  }
  return el;
}

export class TimelineMarkers {
  private container: HTMLElement;
  private currentItem: Item | null = null;
  private markers: HTMLElement[] = [];
  private domObserver: MutationObserver | null = null;
  private debounceTimer: number | null = null;
  // The effective last-viewed time when the page was first shown. Held so that recording this
  // visit (which moves last_viewed_at to now) doesn't hide what was new on arrival.
  private initialLastViewedAtMs: number | null = null;
  // The latest own activity reported by the daemon while on the page. The user has seen
  // everything up to their own latest action, so "Last Viewed" never sits before it, even though
  // the initial view time is held.
  private ownActivityViewedMs: number | null = null;
  private hasEvaluatedInitialView = false;
  private viewMarkerShown = false;

  constructor(container: HTMLElement = document.body) {
    this.container = container;
  }

  public update(item: Item | null): void {
    const prevView = getEffectiveLastViewedMs(this.currentItem?.local);
    const prevAck = getAckedActivityMs(this.currentItem?.local);
    const newView = getEffectiveLastViewedMs(item?.local);
    const newAck = getAckedActivityMs(item?.local);

    this.currentItem = item;
    this.recordViewState();

    // Only re-render markers if the timestamps actually changed or markers were never placed
    if (prevView !== newView || prevAck !== newAck || (this.markers.length === 0 && (Boolean(newView) || Boolean(newAck)))) {
      this.render();
    }
  }

  /** Captures the initial view time and the latest own activity from the current item. */
  private recordViewState(): void {
    const local = this.currentItem?.local;
    const view = getEffectiveLastViewedMs(local);
    if (this.initialLastViewedAtMs === null && view !== null) {
      this.initialLastViewedAtMs = view;
    }
    const own = getOwnActivityViewedMs(local);
    if (own !== null && (this.ownActivityViewedMs === null || own > this.ownActivityViewedMs)) {
      this.ownActivityViewedMs = own;
    }
  }

  /** The time the "Last Viewed" marker follows: the held initial view, raised to own activity. */
  private markerLastViewedMs(): number | null {
    const view = this.initialLastViewedAtMs ?? getEffectiveLastViewedMs(this.currentItem?.local);
    if (view === null) return this.ownActivityViewedMs;
    if (this.ownActivityViewedMs === null) return view;
    return Math.max(view, this.ownActivityViewedMs);
  }

  public render(): void {
    if (typeof document === 'undefined' || !this.container) return;
    this.cleanup();

    if (!this.currentItem || !this.currentItem.local) {
      this.ensureObserver();
      return;
    }

    this.recordViewState();
    const lastViewedAtMs = this.markerLastViewedMs();
    const ackedActivityMs = getAckedActivityMs(this.currentItem.local);

    if ((!lastViewedAtMs || lastViewedAtMs <= 0) && (!ackedActivityMs || ackedActivityMs <= 0)) {
      this.ensureObserver();
      return;
    }

    const rawElements = queryTimelineElements(this.container);
    if (rawElements.length === 0) {
      this.ensureObserver();
      return;
    }

    // Extract elements and their timestamps
    const itemEntries: Array<{ element: HTMLElement; timestamp: number }> = [];
    for (const el of rawElements) {
      const ts = extractElementTimestamp(el);
      if (ts !== null && ts > 0) {
        itemEntries.push({ element: el, timestamp: ts });
      }
    }

    if (itemEntries.length === 0) {
      this.ensureObserver();
      return;
    }

    const { showViewIndex, showAckIndex } = calculateTimelineMarkerIndices(
      itemEntries,
      lastViewedAtMs,
      ackedActivityMs,
      this.hasEvaluatedInitialView ? { wasViewMarkerShown: this.viewMarkerShown } : undefined
    );

    if (!this.hasEvaluatedInitialView) {
      this.hasEvaluatedInitialView = true;
      this.viewMarkerShown = showViewIndex !== -1;
    }

    // Render markers
    if (showAckIndex !== -1 && showViewIndex !== -1) {
      if (showAckIndex === showViewIndex) {
        // Suppress view and only show ack
        this.insertMarker('acked', itemEntries[showAckIndex].element);
      } else if (showAckIndex < showViewIndex) {
        // Ack is earlier than Last Viewed
        this.insertMarker('acked', itemEntries[showAckIndex].element);
        this.insertMarker('viewed', itemEntries[showViewIndex].element);
      } else {
        // Last Viewed is earlier than Ack
        this.insertMarker('viewed', itemEntries[showViewIndex].element);
        this.insertMarker('acked', itemEntries[showAckIndex].element);
      }
    } else if (showAckIndex !== -1) {
      this.insertMarker('acked', itemEntries[showAckIndex].element);
    } else if (showViewIndex !== -1) {
      this.insertMarker('viewed', itemEntries[showViewIndex].element);
    }

    this.ensureObserver();
  }

  private insertMarker(type: 'acked' | 'viewed', targetEl: HTMLElement): void {
    const marker = createMarkerElement(type);
    const insertionPoint = getMarkerInsertionTarget(targetEl);
    if (insertionPoint.parentElement) {
      insertionPoint.parentElement.insertBefore(marker, insertionPoint);
      this.markers.push(marker);
    }
  }

  public cleanup(): void {
    for (const marker of this.markers) {
      if (marker.parentNode) {
        marker.parentNode.removeChild(marker);
      }
    }
    this.markers = [];
  }

  public destroy(): void {
    this.cleanup();
    if (this.domObserver) {
      this.domObserver.disconnect();
      this.domObserver = null;
    }
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.hasEvaluatedInitialView = false;
    this.viewMarkerShown = false;
    this.initialLastViewedAtMs = null;
    this.ownActivityViewedMs = null;
  }

  private ensureObserver(): void {
    if (this.domObserver || typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !this.container) return;

    this.domObserver = new MutationObserver((mutations) => {
      if (typeof document === 'undefined' || !this.container) return;
      let hasRelevantAdditions = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) {
          for (let i = 0; i < m.addedNodes.length; i++) {
            const node = m.addedNodes[i];
            if (
              node instanceof HTMLElement &&
              !node.classList.contains('octodeck-gh-timeline-marker') &&
              !node.classList.contains('octodeck-gh-dense-timeline-item') &&
              !node.classList.contains('octodeck-gh-dense-box')
            ) {
              hasRelevantAdditions = true;
              break;
            }
          }
        }
        if (hasRelevantAdditions) break;
      }

      if (hasRelevantAdditions) {
        if (this.debounceTimer !== null) {
          window.clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = window.setTimeout(() => {
          this.render();
        }, 150);
      }
    });

    this.domObserver.observe(this.container, { childList: true, subtree: true });
  }
}
