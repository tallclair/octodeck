import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Progressive collapse state for a single-line toolbar.
 *
 * `level` is how many collapse steps are applied (0 = everything visible). `expandWidths[i]` is
 * the width the row needed at level `i`, recorded when it collapsed from `i` to `i + 1`. The row
 * only expands back to level `i` once the available width is at least `expandWidths[i]`, so it
 * cannot oscillate between two levels at a width just below what the wider level needs.
 */
export interface ToolbarCollapseState {
  readonly level: number;
  readonly expandWidths: readonly number[];
}

export const INITIAL_TOOLBAR_COLLAPSE: ToolbarCollapseState = { level: 0, expandWidths: [] };

export interface ToolbarMeasurement {
  /** Width the row has (its client width). */
  readonly available: number;
  /** Width the row's content needs at the current level (its scroll width). */
  readonly required: number;
}

/**
 * Pure transition: collapse one level when the content overflows, expand one level when the
 * width recorded for the previous level fits again, otherwise keep the state (same object, so a
 * React state update is a no-op).
 */
export function nextToolbarCollapse(
  state: ToolbarCollapseState,
  { available, required }: ToolbarMeasurement,
  maxLevel: number
): ToolbarCollapseState {
  if (required > available && state.level < maxLevel) {
    const expandWidths = state.expandWidths.slice(0, state.level);
    expandWidths[state.level] = required;
    return { level: state.level + 1, expandWidths };
  }
  if (state.level > 0) {
    const needed = state.expandWidths[state.level - 1];
    if (needed !== undefined && available >= needed) {
      return { level: state.level - 1, expandWidths: state.expandWidths.slice(0, state.level - 1) };
    }
  }
  return state;
}

/**
 * Measures a single-line toolbar row and returns how many collapse levels (0..maxLevel) should
 * be applied so its controls fit. The row must not wrap, so overflow shows up as
 * scrollWidth > clientWidth. Re-measures when the row resizes (ResizeObserver) and after every
 * level change (the content width changes with the level). Without ResizeObserver (jsdom) the
 * toolbar stays fully expanded.
 */
export function useToolbarCollapse<T extends HTMLElement>(
  maxLevel: number
): { readonly ref: RefObject<T | null>; readonly level: number } {
  const ref = useRef<T | null>(null);
  const [state, setState] = useState<ToolbarCollapseState>(INITIAL_TOOLBAR_COLLAPSE);
  const supported = typeof ResizeObserver !== 'undefined';

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const measurement = { available: el.clientWidth, required: el.scrollWidth };
    setState((prev) => nextToolbarCollapse(prev, measurement, maxLevel));
  }, [maxLevel]);

  // Runs before paint, so an overflowing level is replaced before the user sees it.
  useLayoutEffect(() => {
    if (supported) measure();
  }, [supported, measure, state.level]);

  useEffect(() => {
    const el = ref.current;
    if (!supported || !el) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [supported, measure]);

  return { ref, level: state.level };
}
