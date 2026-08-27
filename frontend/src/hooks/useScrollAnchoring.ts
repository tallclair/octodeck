import { useRef, useEffect, useLayoutEffect } from 'react';

export interface UseScrollAnchoringOptions {
  itemIds: string[];
  filterKey?: string;
  animationDurationMs?: number;
  containerRef?: React.RefObject<HTMLDivElement | null>;
}

export interface UseScrollAnchoringResult {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

function safeEscape(str: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(str);
  }
  return str.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

/**
 * Safely finds an element within the container by its data-item-id attribute.
 */
export function findItemElement(container: HTMLElement, id: string): HTMLElement | null {
  try {
    const escaped = safeEscape(id);
    const el = container.querySelector<HTMLElement>(`[data-item-id="${escaped}"]`);
    if (el) return el;
  } catch {
    // Fallback if querySelector throws on unusual characters
  }

  // Safe DOM traversal fallback
  const itemElements = container.querySelectorAll<HTMLElement>('[data-item-id]');
  for (let i = 0; i < itemElements.length; i++) {
    if (itemElements[i].getAttribute('data-item-id') === id) {
      return itemElements[i];
    }
  }
  return null;
}

/**
 * Finds the top-most visible item within the scrollable container.
 */
export function findAnchorItem(container: HTMLElement): { id: string; offset: number } | null {
  const itemElements = container.querySelectorAll<HTMLElement>('[data-item-id]');
  if (itemElements.length === 0) return null;

  const containerRect = container.getBoundingClientRect ? container.getBoundingClientRect() : null;
  const scrollTop = container.scrollTop || 0;

  for (let i = 0; i < itemElements.length; i++) {
    const el = itemElements[i];
    const id = el.getAttribute('data-item-id');
    if (!id) continue;

    if (containerRect && el.getBoundingClientRect) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > containerRect.top + 1) {
        return { id, offset: rect.top - containerRect.top };
      }
    } else {
      const elTop = el.offsetTop || 0;
      const elHeight = el.offsetHeight || 80;
      if (elTop + elHeight > scrollTop) {
        return { id, offset: elTop - scrollTop };
      }
    }
  }

  const firstId = itemElements[0]?.getAttribute('data-item-id');
  return firstId ? { id: firstId, offset: 0 } : null;
}

/**
 * Hook to provide scroll anchoring and smooth in-view insertion animations for lists.
 *
 * 1. Scroll Anchoring: If items are inserted/updated above the user's current scroll viewport,
 *    adjusts container.scrollTop so visible items remain completely stationary without jumping.
 * 2. In-View Animation: If items are inserted within the visible viewport (e.g. at top of list),
 *    smoothly animates them into view via CSS class without triggering React re-renders.
 * 3. Filter Reset: When user switches filters or workflows (filterKey changes), resets scroll to top
 *    and avoids triggering spurious insertion animations on existing items.
 */
export function useScrollAnchoring({
  itemIds,
  filterKey,
  animationDurationMs = 400,
  containerRef: externalContainerRef,
}: UseScrollAnchoringOptions): UseScrollAnchoringResult {
  const internalContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = externalContainerRef || internalContainerRef;

  const anchorIdRef = useRef<string | null>(null);
  const anchorOffsetRef = useRef<number>(0);
  const prevItemIdsRef = useRef<string[] | null>(null);
  const prevFilterKeyRef = useRef<string | undefined>(filterKey);

  // Attach scroll listener to keep track of current anchor item as user scrolls
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const anchor = findAnchorItem(container);
      if (anchor) {
        anchorIdRef.current = anchor.id;
        anchorOffsetRef.current = anchor.offset;
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [scrollContainerRef]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const prevItemIds = prevItemIdsRef.current;
    const prevFilterKey = prevFilterKeyRef.current;

    // Filter/Navigation change: user switched filter view or search query
    if (prevFilterKey !== filterKey) {
      prevFilterKeyRef.current = filterKey;
      prevItemIdsRef.current = itemIds;
      container.scrollTop = 0;
      const anchor = findAnchorItem(container);
      if (anchor) {
        anchorIdRef.current = anchor.id;
        anchorOffsetRef.current = anchor.offset;
      } else {
        anchorIdRef.current = null;
        anchorOffsetRef.current = 0;
      }
      return;
    }

    // Initial render: record IDs and anchor, do not animate or adjust scroll
    if (prevItemIds === null) {
      prevItemIdsRef.current = itemIds;
      const anchor = findAnchorItem(container);
      if (anchor) {
        anchorIdRef.current = anchor.id;
        anchorOffsetRef.current = anchor.offset;
      }
      return;
    }

    const isSameList =
      prevItemIds.length === itemIds.length &&
      prevItemIds.every((id, idx) => id === itemIds[idx]);

    // Update tracked item IDs immediately
    prevItemIdsRef.current = itemIds;

    if (isSameList) {
      const newAnchor = findAnchorItem(container);
      if (newAnchor) {
        anchorIdRef.current = newAnchor.id;
        anchorOffsetRef.current = newAnchor.offset;
      }
      return;
    }

    const prevAnchorId = anchorIdRef.current;
    const prevAnchorOffset = anchorOffsetRef.current;
    const wasScrolled = (container.scrollTop || 0) > 0;

    // 1. SCROLL ANCHORING: If scrolled down and we have a tracked anchor item
    if (wasScrolled && prevAnchorId) {
      const anchorEl = findItemElement(container, prevAnchorId);
      if (anchorEl) {
        let currentOffset = 0;
        if (container.getBoundingClientRect && anchorEl.getBoundingClientRect) {
          const containerRect = container.getBoundingClientRect();
          const currentRect = anchorEl.getBoundingClientRect();
          currentOffset = currentRect.top - containerRect.top;
        } else {
          currentOffset = (anchorEl.offsetTop || 0) - (container.scrollTop || 0);
        }

        const delta = currentOffset - prevAnchorOffset;
        if (Math.abs(delta) > 0.5) {
          container.scrollTop += delta;
        }
      }
    }

    // 2. IN-VIEW SMOOTH INSERTION ANIMATION:
    const prevSet = new Set(prevItemIds);
    const newlyAdded = itemIds.filter(id => !prevSet.has(id));

    if (newlyAdded.length > 0) {
      const containerRect = container.getBoundingClientRect ? container.getBoundingClientRect() : null;

      for (const newId of newlyAdded) {
        const el = findItemElement(container, newId);
        if (el) {
          let isInView = false;
          if (containerRect && el.getBoundingClientRect) {
            const rect = el.getBoundingClientRect();
            isInView = rect.bottom > containerRect.top && rect.top < containerRect.bottom;
          } else {
            const elTop = el.offsetTop || 0;
            const elHeight = el.offsetHeight || 80;
            const scrollTop = container.scrollTop || 0;
            const clientHeight = container.clientHeight || 800;
            isInView = elTop + elHeight > scrollTop && elTop < scrollTop + clientHeight;
          }

          if (isInView) {
            el.classList.add('animate-item-insert');
            const cleanUp = () => {
              el.classList.remove('animate-item-insert');
            };
            el.addEventListener('animationend', cleanUp, { once: true });
            setTimeout(cleanUp, animationDurationMs + 50);
          }
        }
      }
    }

    const newAnchor = findAnchorItem(container);
    if (newAnchor) {
      anchorIdRef.current = newAnchor.id;
      anchorOffsetRef.current = newAnchor.offset;
    }
  }, [itemIds, filterKey, scrollContainerRef, animationDurationMs]);

  return {
    scrollContainerRef,
  };
}
