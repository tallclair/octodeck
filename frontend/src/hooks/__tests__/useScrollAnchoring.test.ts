import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScrollAnchoring, findAnchorItem, findItemElement } from '../useScrollAnchoring';

describe('useScrollAnchoring hook', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (container.parentElement) {
      container.parentElement.removeChild(container);
    }
  });

  it('findAnchorItem returns the top-most visible item', () => {
    container.innerHTML = `
      <div data-item-id="PR_1" style="height: 100px;">Item 1</div>
      <div data-item-id="PR_2" style="height: 100px;">Item 2</div>
      <div data-item-id="PR_3" style="height: 100px;">Item 3</div>
    `;

    // Mock getBoundingClientRect
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 500,
      left: 0,
      right: 500,
      height: 500,
      width: 500,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const items = container.querySelectorAll<HTMLElement>('[data-item-id]');
    vi.spyOn(items[0], 'getBoundingClientRect').mockReturnValue({
      top: -50,
      bottom: 50,
      left: 0,
      right: 500,
      height: 100,
      width: 500,
      x: 0,
      y: -50,
      toJSON: () => {},
    });
    vi.spyOn(items[1], 'getBoundingClientRect').mockReturnValue({
      top: 50,
      bottom: 150,
      left: 0,
      right: 500,
      height: 100,
      width: 500,
      x: 0,
      y: 50,
      toJSON: () => {},
    });
    vi.spyOn(items[2], 'getBoundingClientRect').mockReturnValue({
      top: 150,
      bottom: 250,
      left: 0,
      right: 500,
      height: 100,
      width: 500,
      x: 0,
      y: 150,
      toJSON: () => {},
    });

    const anchor = findAnchorItem(container);
    expect(anchor).toEqual({ id: 'PR_1', offset: -50 });
  });

  it('findAnchorItem returns null for empty container and fallback for offsetTop calculation', () => {
    container.innerHTML = '';
    expect(findAnchorItem(container)).toBeNull();

    container.innerHTML = `
      <div data-item-id="PR_1">Item 1</div>
    `;
    // Mock container without getBoundingClientRect
    Object.defineProperty(container, 'getBoundingClientRect', { value: undefined, configurable: true });
    const el = container.querySelector('[data-item-id="PR_1"]') as HTMLElement;
    Object.defineProperty(el, 'getBoundingClientRect', { value: undefined, configurable: true });
    Object.defineProperty(el, 'offsetTop', { value: 10, configurable: true });
    Object.defineProperty(el, 'offsetHeight', { value: 80, configurable: true });
    container.scrollTop = 0;

    const anchor = findAnchorItem(container);
    expect(anchor).toEqual({ id: 'PR_1', offset: 10 });
  });

  it('findItemElement locates elements safely even with special characters in IDs', () => {
    container.innerHTML = `
      <div data-item-id="owner/repo#123">Special PR</div>
      <div data-item-id='complex"quote'>Quoted PR</div>
    `;

    const el1 = findItemElement(container, 'owner/repo#123');
    expect(el1).not.toBeNull();
    expect(el1?.textContent).toBe('Special PR');

    const el2 = findItemElement(container, 'complex"quote');
    expect(el2).not.toBeNull();
    expect(el2?.textContent).toBe('Quoted PR');

    const nonExistent = findItemElement(container, 'non-existent');
    expect(nonExistent).toBeNull();
  });

  it('does not add animate-item-insert class on initial mount', () => {
    container.innerHTML = `
      <div data-item-id="PR_1">Item 1</div>
      <div data-item-id="PR_2">Item 2</div>
    `;

    const containerRef = { current: container };
    renderHook(
      ({ itemIds }) => useScrollAnchoring({ itemIds, containerRef }),
      { initialProps: { itemIds: ['PR_1', 'PR_2'] } }
    );

    const el1 = container.querySelector('[data-item-id="PR_1"]');
    const el2 = container.querySelector('[data-item-id="PR_2"]');
    expect(el1?.classList.contains('animate-item-insert')).toBe(false);
    expect(el2?.classList.contains('animate-item-insert')).toBe(false);
  });

  it('adds animate-item-insert to newly inserted in-view items and removes after duration', () => {
    container.innerHTML = `
      <div data-item-id="PR_1">Item 1</div>
    `;
    container.scrollTop = 0;

    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 500,
      left: 0,
      right: 500,
      height: 500,
      width: 500,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const containerRef = { current: container };
    const { rerender } = renderHook(
      ({ itemIds }) => useScrollAnchoring({ itemIds, containerRef, animationDurationMs: 400 }),
      { initialProps: { itemIds: ['PR_1'] } }
    );

    // Insert PR_NEW at top (in-view) and PR_BELOW (out-of-view below fold)
    container.innerHTML = `
      <div data-item-id="PR_NEW">New Item</div>
      <div data-item-id="PR_1">Item 1</div>
      <div data-item-id="PR_BELOW">Below Viewport Item</div>
    `;

    const newEl = container.querySelector<HTMLElement>('[data-item-id="PR_NEW"]')!;
    const oldEl = container.querySelector<HTMLElement>('[data-item-id="PR_1"]')!;
    const belowEl = container.querySelector<HTMLElement>('[data-item-id="PR_BELOW"]')!;

    vi.spyOn(newEl, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 80,
      left: 0,
      right: 500,
      height: 80,
      width: 500,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    vi.spyOn(oldEl, 'getBoundingClientRect').mockReturnValue({
      top: 80,
      bottom: 160,
      left: 0,
      right: 500,
      height: 80,
      width: 500,
      x: 0,
      y: 80,
      toJSON: () => {},
    });
    vi.spyOn(belowEl, 'getBoundingClientRect').mockReturnValue({
      top: 600,
      bottom: 680,
      left: 0,
      right: 500,
      height: 80,
      width: 500,
      x: 0,
      y: 600,
      toJSON: () => {},
    });

    act(() => {
      rerender({ itemIds: ['PR_NEW', 'PR_1', 'PR_BELOW'] });
    });

    // In-view new element gets animated class
    expect(newEl.classList.contains('animate-item-insert')).toBe(true);
    // Existing item does NOT get animated class
    expect(oldEl.classList.contains('animate-item-insert')).toBe(false);
    // Out-of-view new element does NOT get animated class
    expect(belowEl.classList.contains('animate-item-insert')).toBe(false);

    // Advance time past animation duration
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(newEl.classList.contains('animate-item-insert')).toBe(false);
  });

  it('adjusts scrollTop to preserve anchor position when items are inserted above viewport', () => {
    container.scrollTop = 200;

    container.innerHTML = `
      <div data-item-id="PR_1" style="height: 100px;">Item 1</div>
      <div data-item-id="PR_2" style="height: 100px;">Item 2</div>
      <div data-item-id="PR_3" style="height: 100px;">Item 3</div>
    `;

    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 400,
      left: 0,
      right: 500,
      height: 400,
      width: 500,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const items = container.querySelectorAll<HTMLElement>('[data-item-id]');
    // PR_3 is visible at top of viewport
    vi.spyOn(items[2], 'getBoundingClientRect').mockReturnValue({
      top: 10,
      bottom: 110,
      left: 0,
      right: 500,
      height: 100,
      width: 500,
      x: 0,
      y: 10,
      toJSON: () => {},
    });

    const containerRef = { current: container };
    const { rerender } = renderHook(
      ({ itemIds }) => useScrollAnchoring({ itemIds, containerRef }),
      { initialProps: { itemIds: ['PR_1', 'PR_2', 'PR_3'] } }
    );

    // New item PR_NEW inserted at top (above viewport)
    container.innerHTML = `
      <div data-item-id="PR_NEW" style="height: 100px;">New Item</div>
      <div data-item-id="PR_1" style="height: 100px;">Item 1</div>
      <div data-item-id="PR_2" style="height: 100px;">Item 2</div>
      <div data-item-id="PR_3" style="height: 100px;">Item 3</div>
    `;

    const newItems = container.querySelectorAll<HTMLElement>('[data-item-id]');
    // PR_3 is pushed down by 100px (new offset is 110 instead of 10)
    vi.spyOn(newItems[3], 'getBoundingClientRect').mockReturnValue({
      top: 110,
      bottom: 210,
      left: 0,
      right: 500,
      height: 100,
      width: 500,
      x: 0,
      y: 110,
      toJSON: () => {},
    });

    act(() => {
      rerender({ itemIds: ['PR_NEW', 'PR_1', 'PR_2', 'PR_3'] });
    });

    // scrollTop should be adjusted by delta: +100px -> 300px
    expect(container.scrollTop).toBe(300);
  });

  it('resets scroll and avoids spurious animations when filterKey changes', () => {
    container.scrollTop = 250;
    container.innerHTML = `
      <div data-item-id="PR_INBOX_1">Inbox Item 1</div>
      <div data-item-id="PR_INBOX_2">Inbox Item 2</div>
    `;

    const containerRef = { current: container };
    const { rerender } = renderHook(
      ({ itemIds, filterKey }) => useScrollAnchoring({ itemIds, filterKey, containerRef }),
      { initialProps: { itemIds: ['PR_INBOX_1', 'PR_INBOX_2'], filterKey: 'inbox' } }
    );

    // User switches filter to 'acked' with completely new item set
    container.innerHTML = `
      <div data-item-id="PR_ACKED_1">Acked Item 1</div>
      <div data-item-id="PR_ACKED_2">Acked Item 2</div>
    `;

    act(() => {
      rerender({ itemIds: ['PR_ACKED_1', 'PR_ACKED_2'], filterKey: 'acked' });
    });

    // Scroll should reset to top (0)
    expect(container.scrollTop).toBe(0);

    const el1 = container.querySelector('[data-item-id="PR_ACKED_1"]');
    const el2 = container.querySelector('[data-item-id="PR_ACKED_2"]');
    // None of the items should animate on filter switch
    expect(el1?.classList.contains('animate-item-insert')).toBe(false);
    expect(el2?.classList.contains('animate-item-insert')).toBe(false);
  });

  it('updates anchor on scroll event', () => {
    container.innerHTML = `
      <div data-item-id="PR_1">Item 1</div>
      <div data-item-id="PR_2">Item 2</div>
    `;

    const containerRef = { current: container };
    renderHook(
      ({ itemIds }) => useScrollAnchoring({ itemIds, containerRef }),
      { initialProps: { itemIds: ['PR_1', 'PR_2'] } }
    );

    // Dispatch scroll event
    act(() => {
      container.scrollTop = 150;
      container.dispatchEvent(new Event('scroll'));
    });

    expect(container.scrollTop).toBe(150);
  });

  it('adjusts scrollTop downwards when items are removed above the viewport', () => {
    container.scrollTop = 300;

    container.innerHTML = `
      <div data-item-id="PR_0" style="height: 100px;">Item 0</div>
      <div data-item-id="PR_1" style="height: 100px;">Item 1</div>
      <div data-item-id="PR_2" style="height: 100px;">Item 2</div>
      <div data-item-id="PR_3" style="height: 100px;">Item 3</div>
    `;

    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 400,
      left: 0,
      right: 500,
      height: 400,
      width: 500,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const items = container.querySelectorAll<HTMLElement>('[data-item-id]');
    // PR_3 is visible at top of viewport
    vi.spyOn(items[3], 'getBoundingClientRect').mockReturnValue({
      top: 10,
      bottom: 110,
      left: 0,
      right: 500,
      height: 100,
      width: 500,
      x: 0,
      y: 10,
      toJSON: () => {},
    });

    const containerRef = { current: container };
    const { rerender } = renderHook(
      ({ itemIds }) => useScrollAnchoring({ itemIds, containerRef }),
      { initialProps: { itemIds: ['PR_0', 'PR_1', 'PR_2', 'PR_3'] } }
    );

    // Item PR_0 is removed (e.g. acked/closed)
    container.innerHTML = `
      <div data-item-id="PR_1" style="height: 100px;">Item 1</div>
      <div data-item-id="PR_2" style="height: 100px;">Item 2</div>
      <div data-item-id="PR_3" style="height: 100px;">Item 3</div>
    `;

    const remainingItems = container.querySelectorAll<HTMLElement>('[data-item-id]');
    // PR_3 moved UP by 100px (new offset is -90 instead of 10)
    vi.spyOn(remainingItems[2], 'getBoundingClientRect').mockReturnValue({
      top: -90,
      bottom: 10,
      left: 0,
      right: 500,
      height: 100,
      width: 500,
      x: 0,
      y: -90,
      toJSON: () => {},
    });

    act(() => {
      rerender({ itemIds: ['PR_1', 'PR_2', 'PR_3'] });
    });

    // scrollTop adjusted down by 100px: 300 - 100 = 200
    expect(container.scrollTop).toBe(200);
  });

  it('handles anchor item removal gracefully and re-anchors to next visible item', () => {
    container.scrollTop = 100;
    container.innerHTML = `
      <div data-item-id="PR_1">Item 1</div>
      <div data-item-id="PR_2">Item 2</div>
    `;

    const containerRef = { current: container };
    const { rerender } = renderHook(
      ({ itemIds }) => useScrollAnchoring({ itemIds, containerRef }),
      { initialProps: { itemIds: ['PR_1', 'PR_2'] } }
    );

    // Anchor PR_1 is deleted entirely
    container.innerHTML = `
      <div data-item-id="PR_2">Item 2</div>
    `;

    act(() => {
      rerender({ itemIds: ['PR_2'] });
    });

    // Does not crash, maintains safe state
    expect(container.scrollTop).toBe(100);
  });

  it('adjusts scrollTop via offsetTop calculation when getBoundingClientRect is absent', () => {
    container.scrollTop = 150;
    container.innerHTML = `
      <div data-item-id="PR_1">Item 1</div>
      <div data-item-id="PR_2">Item 2</div>
    `;

    // Remove getBoundingClientRect to test fallback
    Object.defineProperty(container, 'getBoundingClientRect', { value: undefined, configurable: true });

    const el1 = container.querySelector('[data-item-id="PR_1"]') as HTMLElement;
    const el2 = container.querySelector('[data-item-id="PR_2"]') as HTMLElement;
    Object.defineProperty(el1, 'getBoundingClientRect', { value: undefined, configurable: true });
    Object.defineProperty(el2, 'getBoundingClientRect', { value: undefined, configurable: true });
    Object.defineProperty(el1, 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(el1, 'offsetHeight', { value: 100, configurable: true });
    Object.defineProperty(el2, 'offsetTop', { value: 100, configurable: true });
    Object.defineProperty(el2, 'offsetHeight', { value: 100, configurable: true });

    const containerRef = { current: container };
    const { rerender } = renderHook(
      ({ itemIds }) => useScrollAnchoring({ itemIds, containerRef }),
      { initialProps: { itemIds: ['PR_1', 'PR_2'] } }
    );

    // Insert item above PR_2, shifting PR_2's offsetTop from 100 to 200
    container.innerHTML = `
      <div data-item-id="PR_NEW">New Item</div>
      <div data-item-id="PR_1">Item 1</div>
      <div data-item-id="PR_2">Item 2</div>
    `;
    const newEl2 = container.querySelector('[data-item-id="PR_2"]') as HTMLElement;
    Object.defineProperty(newEl2, 'getBoundingClientRect', { value: undefined, configurable: true });
    Object.defineProperty(newEl2, 'offsetTop', { value: 200, configurable: true });
    Object.defineProperty(newEl2, 'offsetHeight', { value: 100, configurable: true });

    act(() => {
      rerender({ itemIds: ['PR_NEW', 'PR_1', 'PR_2'] });
    });

    expect(container.scrollTop).toBe(250);
  });

  it('handles empty list transitions ([] -> [items] -> []) safely', () => {
    container.innerHTML = '';
    const containerRef = { current: container };
    const { rerender } = renderHook(
      ({ itemIds }) => useScrollAnchoring({ itemIds, containerRef }),
      { initialProps: { itemIds: [] as string[] } }
    );

    // Transition to items
    container.innerHTML = `
      <div data-item-id="PR_1">Item 1</div>
    `;
    act(() => {
      rerender({ itemIds: ['PR_1'] });
    });
    expect(container.scrollTop).toBe(0);

    // Transition back to empty
    container.innerHTML = '';
    act(() => {
      rerender({ itemIds: [] });
    });
    expect(container.scrollTop).toBe(0);
  });
});
