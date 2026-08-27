import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseLocalTimestampMs,
  extractElementTimestamp,
  calculateTimelineMarkerIndices,
  createMarkerElement,
  getMarkerInsertionTarget,
  TimelineMarkers,
} from '../content/timelineMarkers';
import type { Item } from '../../api/octodeck/v1/resources_pb';

describe('TimelineMarkers', () => {
  describe('parseLocalTimestampMs', () => {
    it('parses numeric timestamps', () => {
      expect(parseLocalTimestampMs(1700000000000)).toBe(1700000000000);
      expect(parseLocalTimestampMs(0)).toBeNull();
      expect(parseLocalTimestampMs(-100)).toBeNull();
      expect(parseLocalTimestampMs(null)).toBeNull();
    });

    it('parses ISO date strings', () => {
      const ms = Date.parse('2026-08-12T15:30:00.000Z');
      expect(parseLocalTimestampMs('2026-08-12T15:30:00.000Z')).toBe(ms);
      expect(parseLocalTimestampMs('invalid-date')).toBeNull();
    });

    it('parses Date instances', () => {
      const d = new Date('2026-08-12T15:30:00.000Z');
      expect(parseLocalTimestampMs(d)).toBe(d.getTime());
    });

    it('parses protobuf Timestamp objects', () => {
      expect(parseLocalTimestampMs({ seconds: 1700000000n, nanos: 500000000 })).toBe(1700000000500);
      expect(parseLocalTimestampMs({ seconds: 1700000000, nanos: 0 })).toBe(1700000000000);
      expect(parseLocalTimestampMs({ seconds: 0, nanos: 0 })).toBeNull();
    });
  });

  describe('extractElementTimestamp', () => {
    it('extracts datetime from relative-time element', () => {
      const el = document.createElement('div');
      el.innerHTML = `
        <div class="timeline-comment-header">
          <relative-time datetime="2026-08-12T10:00:00Z">Aug 12</relative-time>
        </div>
      `;
      const expected = Date.parse('2026-08-12T10:00:00Z');
      expect(extractElementTimestamp(el)).toBe(expected);
    });

    it('extracts datetime from time element', () => {
      const el = document.createElement('div');
      el.innerHTML = `<time datetime="2026-08-11T09:00:00Z">Aug 11</time>`;
      const expected = Date.parse('2026-08-11T09:00:00Z');
      expect(extractElementTimestamp(el)).toBe(expected);
    });

    it('returns null when no timestamp element exists', () => {
      const el = document.createElement('div');
      el.innerHTML = `<div>No timestamp here</div>`;
      expect(extractElementTimestamp(el)).toBeNull();
    });
  });

  describe('calculateTimelineMarkerIndices', () => {
    const items = [
      { timestamp: 1000 },
      { timestamp: 2000 },
      { timestamp: 3000 },
      { timestamp: 4000 },
    ];

    it('renders both Last Viewed and Acknowledged when at different positions', () => {
      // acked at 1500 -> first newer is idx 1 (2000)
      // viewed at 2500 -> first newer is idx 2 (3000)
      const res = calculateTimelineMarkerIndices(items, 2500, 1500);
      expect(res.showAckIndex).toBe(1);
      expect(res.showViewIndex).toBe(2);
    });

    it('renders both when Last Viewed is earlier than Acknowledged', () => {
      // viewed at 1500 -> first newer is idx 1 (2000)
      // acked at 2500 -> first newer is idx 2 (3000)
      const res = calculateTimelineMarkerIndices(items, 1500, 2500);
      expect(res.showViewIndex).toBe(1);
      expect(res.showAckIndex).toBe(2);
    });

    it('suppresses Last Viewed when Acknowledged and Last Viewed are at the exact same location', () => {
      // Both at 2500 -> first newer is idx 2 (3000) for both
      const res = calculateTimelineMarkerIndices(items, 2500, 2500);
      expect(res.showAckIndex).toBe(2);
      expect(res.showViewIndex).toBe(-1);
    });

    it('suppresses markers when there are no new comments/events after them (i.e. at the end)', () => {
      // Both at 5000 -> nothing newer
      const res = calculateTimelineMarkerIndices(items, 5000, 5000);
      expect(res.showAckIndex).toBe(-1);
      expect(res.showViewIndex).toBe(-1);
    });

    it('shows Last Viewed but suppresses Acknowledged when Acked is at the end but there are new views', () => {
      // viewed at 2500 -> idx 2
      // acked at 5000 -> end (-1)
      const res = calculateTimelineMarkerIndices(items, 2500, 5000);
      expect(res.showViewIndex).toBe(2);
      expect(res.showAckIndex).toBe(-1);
    });

    it('shows Acknowledged but suppresses Last Viewed when Last Viewed is at the end', () => {
      // viewed at 5000 -> end (-1)
      // acked at 1500 -> idx 1
      const res = calculateTimelineMarkerIndices(items, 5000, 1500);
      expect(res.showAckIndex).toBe(1);
      expect(res.showViewIndex).toBe(-1);
    });

    it('handles null / unset timestamps gracefully', () => {
      const res1 = calculateTimelineMarkerIndices(items, 2500, null);
      expect(res1.showViewIndex).toBe(2);
      expect(res1.showAckIndex).toBe(-1);

      const res2 = calculateTimelineMarkerIndices(items, null, 1500);
      expect(res2.showViewIndex).toBe(-1);
      expect(res2.showAckIndex).toBe(1);

      const res3 = calculateTimelineMarkerIndices([], 2500, 1500);
      expect(res3.showViewIndex).toBe(-1);
      expect(res3.showAckIndex).toBe(-1);
    });

    it('suppresses Last Viewed when wasViewMarkerShown is false in options', () => {
      const res = calculateTimelineMarkerIndices(items, 2500, null, { wasViewMarkerShown: false });
      expect(res.showViewIndex).toBe(-1);
      expect(res.showAckIndex).toBe(-1);
    });
  });

  describe('createMarkerElement', () => {
    it('creates Acknowledged marker element with correct classes and label', () => {
      const el = createMarkerElement('acked');
      expect(el.classList.contains('TimelineItem')).toBe(true);
      expect(el.classList.contains('octodeck-gh-timeline-marker')).toBe(true);
      expect(el.classList.contains('octodeck-gh-timeline-marker-acked')).toBe(true);
      expect(el.querySelector('.octodeck-gh-timeline-marker-label')?.textContent).toBe('Acknowledged');
    });

    it('creates Last Viewed marker element with correct classes and label', () => {
      const el = createMarkerElement('viewed');
      expect(el.classList.contains('TimelineItem')).toBe(true);
      expect(el.classList.contains('octodeck-gh-timeline-marker')).toBe(true);
      expect(el.classList.contains('octodeck-gh-timeline-marker-viewed')).toBe(true);
      expect(el.querySelector('.octodeck-gh-timeline-marker-label')?.textContent).toBe('Last Viewed');
    });
  });

  describe('getMarkerInsertionTarget', () => {
    it('returns element directly if not preceded by dense timeline item', () => {
      const el = document.createElement('div');
      expect(getMarkerInsertionTarget(el)).toBe(el);
    });

    it('returns dense wrapper if target element is preceded by dense timeline item', () => {
      const container = document.createElement('div');
      const denseWrapper = document.createElement('div');
      denseWrapper.className = 'TimelineItem octodeck-gh-dense-timeline-item';
      const commentEl = document.createElement('div');
      commentEl.className = 'TimelineItem octodeck-gh-collapsed-comment';

      container.appendChild(denseWrapper);
      container.appendChild(commentEl);

      expect(getMarkerInsertionTarget(commentEl)).toBe(denseWrapper);
    });
  });

  describe('TimelineMarkers DOM integration', () => {
    let container: HTMLElement;
    let activeMarkers: TimelineMarkers[] = [];

    beforeEach(() => {
      container = document.createElement('div');
      container.id = 'js-discussion';
      container.innerHTML = `
        <div class="TimelineItem" id="issuecomment-1">
          <div class="timeline-comment-header">
            <relative-time datetime="2026-08-10T10:00:00Z">Aug 10, 2026</relative-time>
          </div>
          <div class="comment-body">Comment 1</div>
        </div>
        <div class="TimelineItem" id="issuecomment-2">
          <div class="timeline-comment-header">
            <relative-time datetime="2026-08-11T12:00:00Z">Aug 11, 2026</relative-time>
          </div>
          <div class="comment-body">Comment 2</div>
        </div>
        <div class="TimelineItem" id="issuecomment-3">
          <div class="timeline-comment-header">
            <relative-time datetime="2026-08-12T15:00:00Z">Aug 12, 2026</relative-time>
          </div>
          <div class="comment-body">Comment 3</div>
        </div>
      `;
      document.body.appendChild(container);
    });

    afterEach(() => {
      for (const m of activeMarkers) {
        m.destroy();
      }
      activeMarkers = [];
      if (container && container.parentNode) {
        container.parentNode.removeChild(container);
      }
    });

    const createMarkers = (c: HTMLElement) => {
      const m = new TimelineMarkers(c);
      activeMarkers.push(m);
      return m;
    };

    it('inserts Acknowledged and Last Viewed markers before the correct timeline items', () => {
      const markers = createMarkers(container);
      const mockItem = {
        id: 'kubernetes/kubernetes#123',
        local: {
          ackedAt: '2026-08-10T11:00:00Z', // Before issuecomment-2 (2026-08-11T12:00:00Z)
          lastViewedAt: '2026-08-11T13:00:00Z', // Before issuecomment-3 (2026-08-12T15:00:00Z)
        },
      } as unknown as Item;

      markers.update(mockItem);

      const ackMarker = container.querySelector('[data-testid="octodeck-timeline-marker-acked"]') as HTMLElement;
      const viewMarker = container.querySelector('[data-testid="octodeck-timeline-marker-viewed"]') as HTMLElement;

      expect(ackMarker).not.toBeNull();
      expect(viewMarker).not.toBeNull();

      // Check DOM ordering:
      // comment-1 -> ackMarker -> comment-2 -> viewMarker -> comment-3
      const children = Array.from(container.children);
      const c1Idx = children.findIndex((el) => el.id === 'issuecomment-1');
      const ackIdx = children.findIndex((el) => el === ackMarker);
      const c2Idx = children.findIndex((el) => el.id === 'issuecomment-2');
      const viewIdx = children.findIndex((el) => el === viewMarker);
      const c3Idx = children.findIndex((el) => el.id === 'issuecomment-3');

      expect(c1Idx).toBeLessThan(ackIdx);
      expect(ackIdx).toBeLessThan(c2Idx);
      expect(c2Idx).toBeLessThan(viewIdx);
      expect(viewIdx).toBeLessThan(c3Idx);
    });

    it('suppresses Last Viewed marker when Acknowledged is at the same location', () => {
      const markers = createMarkers(container);
      const mockItem = {
        id: 'kubernetes/kubernetes#123',
        local: {
          ackedAt: '2026-08-10T11:00:00Z',
          lastViewedAt: '2026-08-10T11:00:00Z',
        },
      } as unknown as Item;

      markers.update(mockItem);

      const ackMarker = container.querySelector('[data-testid="octodeck-timeline-marker-acked"]');
      const viewMarker = container.querySelector('[data-testid="octodeck-timeline-marker-viewed"]');

      expect(ackMarker).not.toBeNull();
      expect(viewMarker).toBeNull();
    });

    it('suppresses both markers when both are after the last timeline item', () => {
      const markers = createMarkers(container);
      const mockItem = {
        id: 'kubernetes/kubernetes#123',
        local: {
          ackedAt: '2026-08-12T16:00:00Z',
          lastViewedAt: '2026-08-12T16:00:00Z',
        },
      } as unknown as Item;

      markers.update(mockItem);

      expect(container.querySelector('[data-testid="octodeck-timeline-marker-acked"]')).toBeNull();
      expect(container.querySelector('[data-testid="octodeck-timeline-marker-viewed"]')).toBeNull();
    });

    it('never shows Last Viewed marker when new updates are added if Last Viewed was not previously shown', () => {
      const markers = createMarkers(container);
      // All existing comments (up to 2026-08-12T15:00:00Z) were viewed
      const mockItem = {
        id: 'kubernetes/kubernetes#123',
        local: {
          lastViewedAt: '2026-08-12T16:00:00Z',
        },
      } as unknown as Item;

      markers.update(mockItem);

      // Initial render: no Last Viewed marker because user was caught up
      expect(container.querySelector('[data-testid="octodeck-timeline-marker-viewed"]')).toBeNull();

      // User responds or live update adds a new comment to DOM
      const newComment = document.createElement('div');
      newComment.className = 'TimelineItem';
      newComment.id = 'issuecomment-4';
      newComment.innerHTML = `
        <div class="timeline-comment-header">
          <relative-time datetime="2026-08-13T10:00:00Z">Aug 13, 2026</relative-time>
        </div>
        <div class="comment-body">New Comment by User</div>
      `;
      container.appendChild(newComment);

      // Rerender markers
      markers.render();

      // Should NEVER show Last Viewed marker since it wasn't previously shown
      expect(container.querySelector('[data-testid="octodeck-timeline-marker-viewed"]')).toBeNull();
    });

    it('maintains Last Viewed marker position when new updates are added if Last Viewed was previously shown', () => {
      const markers = createMarkers(container);
      // Last viewed before comment 3
      const mockItem = {
        id: 'kubernetes/kubernetes#123',
        local: {
          lastViewedAt: '2026-08-11T13:00:00Z',
        },
      } as unknown as Item;

      markers.update(mockItem);

      // Initial render: Last Viewed marker is before comment 3
      let viewMarker = container.querySelector('[data-testid="octodeck-timeline-marker-viewed"]');
      expect(viewMarker).not.toBeNull();

      // User responds with comment 4
      const newComment = document.createElement('div');
      newComment.className = 'TimelineItem';
      newComment.id = 'issuecomment-4';
      newComment.innerHTML = `
        <div class="timeline-comment-header">
          <relative-time datetime="2026-08-13T10:00:00Z">Aug 13, 2026</relative-time>
        </div>
        <div class="comment-body">Comment 4</div>
      `;
      container.appendChild(newComment);

      markers.render();

      viewMarker = container.querySelector('[data-testid="octodeck-timeline-marker-viewed"]');
      expect(viewMarker).not.toBeNull();

      const children = Array.from(container.children);
      const c2Idx = children.findIndex((el) => el.id === 'issuecomment-2');
      const viewIdx = children.findIndex((el) => el === viewMarker);
      const c3Idx = children.findIndex((el) => el.id === 'issuecomment-3');
      const c4Idx = children.findIndex((el) => el.id === 'issuecomment-4');

      expect(c2Idx).toBeLessThan(viewIdx);
      expect(viewIdx).toBeLessThan(c3Idx);
      expect(c3Idx).toBeLessThan(c4Idx);
    });

    it('cleans up markers when update is called with null or cleanup is called', () => {
      const markers = createMarkers(container);
      const mockItem = {
        id: 'kubernetes/kubernetes#123',
        local: {
          ackedAt: '2026-08-10T11:00:00Z',
        },
      } as unknown as Item;

      markers.update(mockItem);
      expect(container.querySelector('[data-testid="octodeck-timeline-marker-acked"]')).not.toBeNull();

      markers.cleanup();
      expect(container.querySelector('[data-testid="octodeck-timeline-marker-acked"]')).toBeNull();
    });
  });
});
