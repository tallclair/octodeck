/* eslint-disable @typescript-eslint/no-explicit-any */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useKeyboardNavigation } from '../useKeyboardNavigation';
import type { Item } from '../../api/octodeck/v1/resources_pb';

const mockItems: Item[] = [
  {
    id: 'item-1',
    repo: 'kubernetes/kubernetes',
    number: 101,
    title: 'Item 1',
    url: 'https://github.com/kubernetes/kubernetes/pull/101',
    local: { starred: false } as any,
  } as Item,
  {
    id: 'item-2',
    repo: 'kubernetes/kubernetes',
    number: 102,
    title: 'Item 2',
    url: 'https://github.com/kubernetes/kubernetes/pull/102',
    local: { starred: true } as any,
  } as Item,
  {
    id: 'item-3',
    repo: 'kubernetes/kubernetes',
    number: 103,
    title: 'Item 3',
    url: 'https://github.com/kubernetes/kubernetes/pull/103',
    local: { starred: false } as any,
  } as Item,
];

describe('useKeyboardNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('navigates down and up with j and k keys', () => {
    const onSelectItem = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardNavigation({
        items: mockItems,
        selectedItemId: null,
        onSelectItem,
        isDetailsOpen: false,
      })
    );

    expect(result.current.focusedItemId).toBeNull();

    // Press 'j' -> should focus first item
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    });
    expect(result.current.focusedItemId).toBe('item-1');

    // Press 'j' -> should focus second item
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    });
    expect(result.current.focusedItemId).toBe('item-2');

    // Press 'ArrowDown' -> should focus third item
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    });
    expect(result.current.focusedItemId).toBe('item-3');

    // Press 'j' at bottom -> stays on third item
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    });
    expect(result.current.focusedItemId).toBe('item-3');

    // Press 'k' -> moves to second item
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }));
    });
    expect(result.current.focusedItemId).toBe('item-2');

    // Press 'ArrowUp' -> moves to first item
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    });
    expect(result.current.focusedItemId).toBe('item-1');

    // Press 'k' at top -> stays on first item
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }));
    });
    expect(result.current.focusedItemId).toBe('item-1');
  });

  it('opens details panel on Enter for focused item', () => {
    const onSelectItem = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardNavigation({
        items: mockItems,
        selectedItemId: null,
        onSelectItem,
        isDetailsOpen: false,
      })
    );

    // Focus item-2
    act(() => {
      result.current.setFocusedItemId('item-2');
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });

    expect(onSelectItem).toHaveBeenCalledWith('item-2');
  });

  it('updates selected item when details pane is open while navigating j/k', () => {
    const onSelectItem = vi.fn();
    renderHook(() =>
      useKeyboardNavigation({
        items: mockItems,
        selectedItemId: 'item-1',
        onSelectItem,
        isDetailsOpen: true,
      })
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    });

    expect(onSelectItem).toHaveBeenCalledWith('item-2');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }));
    });

    expect(onSelectItem).toHaveBeenCalledWith('item-1');
  });

  it('handles ack action with e or x key and advances focus', () => {
    const onAckItem = vi.fn();
    const onSelectItem = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardNavigation({
        items: mockItems,
        selectedItemId: 'item-1',
        onSelectItem,
        onAckItem,
        isDetailsOpen: true,
      })
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    });

    expect(onAckItem).toHaveBeenCalledWith('item-1');
    expect(onSelectItem).toHaveBeenCalledWith('item-2');
    expect(result.current.focusedItemId).toBe('item-2');
  });

  it('handles acking the last item by selecting previous item or closing details', () => {
    const onAckItem = vi.fn();
    const onSelectItem = vi.fn();
    const singleItemList = [mockItems[0]];
    const { result } = renderHook(() =>
      useKeyboardNavigation({
        items: singleItemList,
        selectedItemId: 'item-1',
        onSelectItem,
        onAckItem,
        isDetailsOpen: true,
      })
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }));
    });

    expect(onAckItem).toHaveBeenCalledWith('item-1');
    expect(onSelectItem).toHaveBeenCalledWith(null);
    expect(result.current.focusedItemId).toBeNull();
  });

  it('handles star toggle with s key', () => {
    const onStarItem = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardNavigation({
        items: mockItems,
        selectedItemId: null,
        onSelectItem: vi.fn(),
        onStarItem,
        isDetailsOpen: false,
      })
    );

    act(() => {
      result.current.setFocusedItemId('item-1'); // item-1 has starred: false
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
    });

    expect(onStarItem).toHaveBeenCalledWith('item-1', true);
  });

  it('opens GitHub link with o key', () => {
    const onOpenGitHub = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardNavigation({
        items: mockItems,
        selectedItemId: null,
        onSelectItem: vi.fn(),
        onOpenGitHub,
        isDetailsOpen: false,
      })
    );

    act(() => {
      result.current.setFocusedItemId('item-2');
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o' }));
    });

    expect(onOpenGitHub).toHaveBeenCalledWith('https://github.com/kubernetes/kubernetes/pull/102');
  });

  it('toggles shortcuts modal with ? key and closes with Escape', () => {
    const { result } = renderHook(() =>
      useKeyboardNavigation({
        items: mockItems,
        selectedItemId: null,
        onSelectItem: vi.fn(),
        isDetailsOpen: false,
      })
    );

    expect(result.current.showShortcutsModal).toBe(false);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    });
    expect(result.current.showShortcutsModal).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(result.current.showShortcutsModal).toBe(false);
  });

  it('closes details pane on Escape if open', () => {
    const onSelectItem = vi.fn();
    renderHook(() =>
      useKeyboardNavigation({
        items: mockItems,
        selectedItemId: 'item-1',
        onSelectItem,
        isDetailsOpen: true,
      })
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(onSelectItem).toHaveBeenCalledWith(null);
  });

  it('clears focus on Escape if details pane is closed', () => {
    const { result } = renderHook(() =>
      useKeyboardNavigation({
        items: mockItems,
        selectedItemId: null,
        onSelectItem: vi.fn(),
        isDetailsOpen: false,
      })
    );

    act(() => {
      result.current.setFocusedItemId('item-1');
    });
    expect(result.current.focusedItemId).toBe('item-1');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(result.current.focusedItemId).toBeNull();
  });

  it('ignores shortcuts when typing in input or textarea', () => {
    const onSelectItem = vi.fn();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const { result } = renderHook(() =>
      useKeyboardNavigation({
        items: mockItems,
        selectedItemId: null,
        onSelectItem,
        isDetailsOpen: false,
      })
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    });
    expect(result.current.focusedItemId).toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    });
    expect(result.current.showShortcutsModal).toBe(false);

    document.body.removeChild(input);
  });

  it('ignores shortcuts when modifier keys are pressed', () => {
    const onSelectItem = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardNavigation({
        items: mockItems,
        selectedItemId: null,
        onSelectItem,
        isDetailsOpen: false,
      })
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true }));
    });
    expect(result.current.focusedItemId).toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }));
    });
    expect(result.current.focusedItemId).toBeNull();
  });

  it('does nothing when disabled is true', () => {
    const onSelectItem = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardNavigation({
        items: mockItems,
        selectedItemId: null,
        onSelectItem,
        isDetailsOpen: false,
        disabled: true,
      })
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    });
    expect(result.current.focusedItemId).toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    });
    expect(result.current.showShortcutsModal).toBe(false);
  });
});
