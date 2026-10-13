import { useState } from 'react';

export interface StableOptionItem {
  readonly value: string;
  readonly count: number | null;
  readonly pinned?: boolean;
  readonly group?: string;
  readonly isGroupHeader?: boolean;
}

export interface UseStableOptionsConfig {
  /**
   * Whether to sort options case-insensitively by value (keeping `pinned` options first).
   * Defaults to true. Set to false for fixed-order menus such as Activity or grouped menus
   * such as Repository (where rows are ordered by group and header-first).
   */
  readonly sort?: boolean;
}

const byValue = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

function byGroupThenValue<T extends StableOptionItem>(a: T, b: T): number {
  const groupCmp = byValue(a.group ?? '', b.group ?? '');
  if (groupCmp !== 0) return groupCmp;
  const headerCmp = (b.isGroupHeader ? 1 : 0) - (a.isGroupHeader ? 1 : 0);
  if (headerCmp !== 0) return headerCmp;
  return byValue(a.value, b.value);
}

function shallowEqualOption<T extends StableOptionItem>(a: T, b: T): boolean {
  if (a === b) return true;
  const keysA = Object.keys(a) as (keyof T)[];
  const keysB = Object.keys(b) as (keyof T)[];
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]);
}

function buildInitialMap<T extends StableOptionItem>(
  open: boolean,
  options: readonly T[]
): ReadonlyMap<string, T> {
  if (!open) return new Map();
  const map = new Map<string, T>();
  for (const opt of options) {
    map.set(opt.value.toLowerCase(), opt);
  }
  return map;
}

/**
 * Keeps the set of option rows stable while a menu is open (`open === true`).
 *
 * - Any option value seen while the menu is open remains in the returned list until the menu
 *   closes, even if a subsequent facet refresh omits it (its count becomes `0`).
 * - Counts and metadata (such as color or label) are always taken from the latest `options`
 *   when present.
 * - When `sort` is true (default), non-pinned rows are sorted case-insensitively by `value`
 *   so checking/unchecking or count updates never move rows under the pointer.
 */
export function useStableOptions<T extends StableOptionItem>(
  open: boolean,
  options: readonly T[],
  config?: UseStableOptionsConfig
): T[] {
  const shouldSort = config?.sort ?? true;
  const [seen, setSeen] = useState<ReadonlyMap<string, T>>(() => buildInitialMap(open, options));

  if (!open) {
    if (seen.size > 0) {
      setSeen(new Map());
    }
    return [...options];
  }

  const nextSeen = new Map<string, T>(seen);
  const currentKeys = new Set<string>();
  let changed = false;

  for (const opt of options) {
    const key = opt.value.toLowerCase();
    currentKeys.add(key);
    const prev = nextSeen.get(key);
    if (!prev || !shallowEqualOption(prev, opt)) {
      nextSeen.set(key, opt);
      changed = true;
    }
  }

  for (const [key, prev] of nextSeen.entries()) {
    if (!currentKeys.has(key) && prev.count !== null && prev.count !== 0) {
      nextSeen.set(key, { ...prev, count: 0 });
      changed = true;
    }
  }

  if (changed) {
    setSeen(nextSeen);
  }

  const merged = [...nextSeen.values()];
  if (!shouldSort) {
    if (merged.some((o) => o.group !== undefined)) {
      return merged.sort(byGroupThenValue);
    }
    return merged;
  }

  const pinned = merged.filter((o) => o.pinned);
  const rest = merged.filter((o) => !o.pinned).sort((a, b) => byValue(a.value, b.value));
  return [...pinned, ...rest];
}
