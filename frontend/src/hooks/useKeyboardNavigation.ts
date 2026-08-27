import { useState, useEffect, useCallback } from 'react';
import type { Item } from '../api/octodeck/v1/resources_pb';

export interface UseKeyboardNavigationOptions {
  items: Item[];
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
  onAckItem?: (id: string) => Promise<void> | void;
  onStarItem?: (id: string, starred: boolean) => Promise<void> | void;
  isDetailsOpen: boolean;
  disabled?: boolean;
  onOpenGitHub?: (url: string) => void;
}

export function isInputFocused(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!active || !(active instanceof HTMLElement)) return false;
  const tag = active.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    active.isContentEditable
  );
}

export function useKeyboardNavigation({
  items,
  selectedItemId,
  onSelectItem,
  onAckItem,
  onStarItem,
  isDetailsOpen,
  disabled = false,
  onOpenGitHub,
}: UseKeyboardNavigationOptions) {
  const [internalFocusedId, setInternalFocusedId] = useState<string | null>(() => selectedItemId);
  const [prevSelectedId, setPrevSelectedId] = useState<string | null>(selectedItemId);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);

  // Sync internal focused ID when selectedItemId prop changes from parent
  if (selectedItemId !== prevSelectedId) {
    setPrevSelectedId(selectedItemId);
    if (selectedItemId !== null) {
      setInternalFocusedId(selectedItemId);
    }
  }

  // Derive effective focused ID to ensure it is always an existing item in the current filtered list
  const focusedItemId = (internalFocusedId && items.some(i => i.id === internalFocusedId))
    ? internalFocusedId
    : null;

  const setFocusedItemId = useCallback((id: string | null) => {
    setInternalFocusedId(id);
  }, []);

  // Scroll focused element into view smoothly
  useEffect(() => {
    if (!focusedItemId || typeof document === 'undefined') return;
    const el = document.querySelector(`[data-item-id="${focusedItemId}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusedItemId]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Allow Escape and ? even inside shortcuts modal
      if (showShortcutsModal) {
        if (e.key === 'Escape' || e.key === '?') {
          e.preventDefault();
          setShowShortcutsModal(false);
        }
        return;
      }

      // If user is typing in an input/textarea or navigation is disabled, ignore
      if (disabled || isInputFocused()) {
        return;
      }

      // Ignore if modifier keys are pressed (e.g. Cmd+R, Ctrl+C), except Shift for '?'
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      const activeItemId = (isDetailsOpen && selectedItemId) ? selectedItemId : focusedItemId;
      const currentIndex = activeItemId ? items.findIndex(i => i.id === activeItemId) : -1;

      switch (e.key) {
        case '?': {
          e.preventDefault();
          setShowShortcutsModal(true);
          break;
        }

        case 'j':
        case 'ArrowDown': {
          e.preventDefault();
          if (items.length === 0) return;
          let nextIndex = 0;
          if (currentIndex !== -1) {
            nextIndex = Math.min(currentIndex + 1, items.length - 1);
          }
          const nextItem = items[nextIndex];
          if (nextItem) {
            setFocusedItemId(nextItem.id);
            if (isDetailsOpen) {
              onSelectItem(nextItem.id);
            }
          }
          break;
        }

        case 'k':
        case 'ArrowUp': {
          e.preventDefault();
          if (items.length === 0) return;
          let prevIndex = 0;
          if (currentIndex !== -1) {
            prevIndex = Math.max(currentIndex - 1, 0);
          }
          const prevItem = items[prevIndex];
          if (prevItem) {
            setFocusedItemId(prevItem.id);
            if (isDetailsOpen) {
              onSelectItem(prevItem.id);
            }
          }
          break;
        }

        case 'Enter': {
          e.preventDefault();
          const targetItem = activeItemId
            ? items.find(i => i.id === activeItemId)
            : items[0];

          if (targetItem) {
            setFocusedItemId(targetItem.id);
            onSelectItem(targetItem.id);
          }
          break;
        }

        case 'x':
        case 'e': {
          e.preventDefault();
          if (!activeItemId || !onAckItem) return;
          const targetItem = items.find(i => i.id === activeItemId);
          if (!targetItem) return;

          // Calculate next active item before calling ack
          let nextActiveId: string | null = null;
          if (items.length > 1 && currentIndex !== -1) {
            if (currentIndex < items.length - 1) {
              nextActiveId = items[currentIndex + 1].id;
            } else if (currentIndex > 0) {
              nextActiveId = items[currentIndex - 1].id;
            }
          }

          onAckItem(targetItem.id);

          if (isDetailsOpen) {
            if (nextActiveId) {
              onSelectItem(nextActiveId);
            } else {
              onSelectItem(null);
            }
          }
          setFocusedItemId(nextActiveId);
          break;
        }

        case 's': {
          e.preventDefault();
          if (!activeItemId || !onStarItem) return;
          const targetItem = items.find(i => i.id === activeItemId);
          if (!targetItem) return;
          const isStarred = Boolean(targetItem.local?.starred);
          onStarItem(targetItem.id, !isStarred);
          break;
        }

        case 'o': {
          e.preventDefault();
          if (!activeItemId) return;
          const targetItem = items.find(i => i.id === activeItemId);
          if (!targetItem?.url) return;

          if (onOpenGitHub) {
            onOpenGitHub(targetItem.url);
          } else if (typeof window !== 'undefined') {
            window.open(targetItem.url, '_blank', 'noopener,noreferrer');
          }
          break;
        }

        case 'Escape': {
          if (isDetailsOpen) {
            e.preventDefault();
            onSelectItem(null);
          } else if (focusedItemId) {
            e.preventDefault();
            setFocusedItemId(null);
          }
          break;
        }

        default:
          break;
      }
    },
    [
      items,
      focusedItemId,
      selectedItemId,
      isDetailsOpen,
      disabled,
      showShortcutsModal,
      onSelectItem,
      onAckItem,
      onStarItem,
      onOpenGitHub,
      setFocusedItemId,
    ]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return {
    focusedItemId,
    setFocusedItemId,
    showShortcutsModal,
    setShowShortcutsModal,
  };
}
