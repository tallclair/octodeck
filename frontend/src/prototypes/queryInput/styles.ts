// Throwaway UX prototype: shared Tailwind class maps for token rendering.

import type { SegmentRole, TokenStatus } from './parser';

// Text colors per segment role. Only colors/decorations (no font-weight or
// padding changes), so the overlay design can render them under a textarea
// without shifting glyph positions.
export const SEGMENT_CLASS: Record<SegmentRole, string> = {
  neg: 'text-rose-600 dark:text-rose-400',
  key: 'text-slate-500 dark:text-slate-400',
  badkey: 'text-red-600 dark:text-red-400 underline decoration-wavy decoration-red-500',
  colon: 'text-slate-400 dark:text-slate-500',
  value: 'text-blue-700 dark:text-blue-300',
  badvalue: 'text-red-600 dark:text-red-400 line-through decoration-red-500',
  comma: 'text-slate-400 dark:text-slate-500',
  text: 'text-slate-800 dark:text-slate-200',
};

// Pill background/border per token status for qualifier tokens.
export const PILL_CLASS: Record<TokenStatus, string> = {
  ok: 'bg-blue-50 dark:bg-blue-500/15 ring-1 ring-inset ring-blue-200 dark:ring-blue-500/30',
  incomplete: 'bg-slate-100 dark:bg-slate-800 ring-1 ring-inset ring-slate-300 dark:ring-slate-600',
  error: 'bg-red-50 dark:bg-red-500/15 ring-1 ring-inset ring-red-300 dark:ring-red-500/40',
};

export const NEGATED_PILL_CLASS = 'bg-rose-50 dark:bg-rose-500/10 ring-1 ring-inset ring-rose-200 dark:ring-rose-500/30';
