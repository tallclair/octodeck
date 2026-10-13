import { useState, useEffect, useCallback, useMemo, useRef, type RefObject } from 'react';

export type DashboardMenuId =
  | 'status'
  | 'state'
  | 'repo'
  | 'author'
  | 'label'
  | 'more'
  | 'assignee'
  | 'milestone'
  | 'sort';

export interface MenuGroup<T extends string = DashboardMenuId> {
  readonly open: T | null;
  readonly anyOpen: boolean;
  isOpen(id: T): boolean;
  toggle(id: T): void;
  openMenu(id: T): void;
  close(): void;
  refFor(id: T): RefObject<HTMLDivElement | null>;
}

/**
 * Manages mutually-exclusive dropdown menus across the dashboard header, toolbar, and list body.
 * Opening any menu closes the others; Escape or a pointer-down outside the active menu container
 * closes it. Per-id container refs are stable across renders.
 */
export function useMenuGroup<T extends string = DashboardMenuId>(): MenuGroup<T> {
  const [open, setOpen] = useState<T | null>(null);
  const refsMap = useRef<Map<T, RefObject<HTMLDivElement | null>>>(new Map());

  const refFor = useCallback((id: T): RefObject<HTMLDivElement | null> => {
    let ref = refsMap.current.get(id);
    if (!ref) {
      ref = { current: null };
      refsMap.current.set(id, ref);
    }
    return ref;
  }, []);

  const isOpen = useCallback((id: T) => open === id, [open]);
  const toggle = useCallback((id: T) => {
    setOpen((prev) => (prev === id ? null : id));
  }, []);
  const openMenu = useCallback((id: T) => {
    setOpen(id);
  }, []);
  const close = useCallback(() => {
    setOpen(null);
  }, []);

  useEffect(() => {
    if (open === null) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (open === null) return;
    const handlePointerDownOutside = (e: MouseEvent) => {
      const container = refsMap.current.get(open)?.current;
      if (container && !container.contains(e.target as Node)) {
        setOpen(null);
      }
    };
    document.addEventListener('mousedown', handlePointerDownOutside);
    return () => document.removeEventListener('mousedown', handlePointerDownOutside);
  }, [open]);

  return useMemo(
    () => ({
      open,
      anyOpen: open !== null,
      isOpen,
      toggle,
      openMenu,
      close,
      refFor,
    }),
    [open, isOpen, toggle, openMenu, close, refFor]
  );
}
