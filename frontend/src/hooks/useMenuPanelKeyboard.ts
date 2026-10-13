import { useCallback, useEffect, type KeyboardEvent, type RefObject } from 'react';

/**
 * Attribute marking the focusable rows of a hand-rolled menu panel for arrow-key navigation by
 * useMenuPanelKeyboard. Spread onto each row element.
 */
export const MENU_ITEM_PROPS = { 'data-menu-item': '' } as const;

const MENU_ITEM_SELECTOR = '[data-menu-item]';

export interface MenuPanelKeyboardOptions {
  /** Whether the panel is open; the panel receives focus when this becomes true. */
  readonly open: boolean;
  /** The panel element; must be focusable (tabIndex={-1}). */
  readonly panelRef: RefObject<HTMLElement | null>;
  /** The trigger that opened the panel; focus returns here on Escape or Tab. */
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}

/**
 * Keyboard behaviour for hand-rolled dropdown panels, matching MultiSelectMenu:
 * the panel takes focus when it opens, ArrowUp/ArrowDown/Home/End move between rows marked with
 * MENU_ITEM_PROPS (clamped at the ends), Escape closes and returns focus to the trigger, and Tab
 * closes and returns focus to the trigger so the browser's default Tab then moves past it.
 *
 * Key events coming from elements that are not this panel's own rows (for example a nested
 * MultiSelectMenu flyout) are ignored so that widget can handle them itself.
 */
export function useMenuPanelKeyboard({
  open,
  panelRef,
  triggerRef,
  onClose,
}: MenuPanelKeyboardOptions): (e: KeyboardEvent<HTMLElement>) => void {
  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
    }
  }, [open, panelRef]);

  return useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
      const target = e.target as HTMLElement;
      const index = items.indexOf(target);
      if (target !== panel && index < 0) return;

      const focusAt = (i: number) => {
        if (items.length === 0) return;
        items[Math.max(0, Math.min(i, items.length - 1))].focus();
      };

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          // Keep the menu group's window-level Escape handler from also firing.
          e.stopPropagation();
          triggerRef.current?.focus();
          onClose();
          return;
        case 'Tab':
          triggerRef.current?.focus();
          onClose();
          return;
        case 'ArrowDown':
          e.preventDefault();
          focusAt(index < 0 ? 0 : index + 1);
          return;
        case 'ArrowUp':
          e.preventDefault();
          focusAt(index < 0 ? items.length - 1 : index - 1);
          return;
        case 'Home':
          e.preventDefault();
          focusAt(0);
          return;
        case 'End':
          e.preventDefault();
          focusAt(items.length - 1);
          return;
      }
    },
    [panelRef, triggerRef, onClose]
  );
}
