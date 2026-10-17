// Shared class strings and metrics for the query input (components/query/QueryInput.tsx).
//
// The textarea and the decoration layer under it must lay out text identically, so every metric
// that affects glyph positions lives here and is applied to both: font, line height, padding,
// word spacing, wrapping, and disabled kerning/ligatures/contextual alternates (so splitting the
// text into coloured spans can never change a glyph's advance). Emphasis is colour only: a font
// weight change on the decoration layer would move its glyphs away from the caret.
import type { CSSProperties } from 'react';
import { TOOLBAR_CONTROL_HEIGHT_PX } from '../dashboard/menuStyles';
import type { ClauseTone } from '../../logic/query/clauseDisplay';
import type { SegmentRole } from '../../logic/query/syntax';

/** Pill border width (the `border` class); the inset remove button stays inside it. */
export const PILL_BORDER_PX = 1;

/**
 * One text line. Pills (22px) sit centred in it with 3px above and below, so wrapped pill rows
 * are evenly spaced; with the frame border the text box adds QUERY_PAD_Y_PX at the top and bottom.
 */
export const QUERY_LINE_HEIGHT_PX = TOOLBAR_CONTROL_HEIGHT_PX + 2;

/**
 * Vertical text-box padding on both layers: 28px lines leave 3px around each 22px pill, and this
 * adds 1px more above the first row and below the last (4px inside the border, a 32px
 * single-line field) without spreading wrapped rows apart.
 */
export const QUERY_PAD_Y_PX = 1;

/** Lines shown before the field stops growing and scrolls. */
export const QUERY_MAX_LINES = 4;

/** Text box padding: left leaves room for the search icon, right for the pin and clear buttons. */
const PAD_RIGHT_PX = 48;

/** Horizontal room between a pill's glyphs and its border. */
const PILL_PAD_X_PX = 3.5;

/** Search icon size (px) and its left offset in the frame's padding box. */
export const SEARCH_ICON_SIZE_PX = 14;
const SEARCH_ICON_LEFT_PX = 6;
/**
 * Horizontal extent of the lucide Search glyph's ink inside its box, stroke included (its 24px
 * view box draws from x = 2 to x = 22), so the icon is centred on what is visible.
 */
const SEARCH_ICON_INK_LEFT_PX = (SEARCH_ICON_SIZE_PX * 2) / 24;
const SEARCH_ICON_INK_RIGHT_PX = (SEARCH_ICON_SIZE_PX * 22) / 24;
/** Gap between the frame's inner edge and the icon's ink. */
const SEARCH_ICON_GAP_PX = SEARCH_ICON_LEFT_PX + SEARCH_ICON_INK_LEFT_PX;
/**
 * Text inset: the icon sits centred between the frame's inner edge and the first pill's box,
 * which starts PILL_PAD_X_PX + PILL_BORDER_PX left of the text (the same gap on both sides).
 */
const PAD_LEFT_PX =
  SEARCH_ICON_LEFT_PX + SEARCH_ICON_INK_RIGHT_PX + SEARCH_ICON_GAP_PX + PILL_PAD_X_PX + PILL_BORDER_PX;
/** Painted pill height, centred in its 28px line (3px above and below). */
const PILL_HEIGHT_PX = 22;

/** Font classes; identical on the textarea and the decoration layer. */
const FONT_CLASS = 'font-sans text-[14px] font-normal';

/** Box classes shared by the textarea and the decoration layer (they must wrap identically). */
export const QUERY_TEXT_BOX_CLASS = `${FONT_CLASS} whitespace-pre-wrap break-words`;

/**
 * Inline text metrics shared by the textarea and the decoration layer. The 0.5em word spacing
 * makes the gutters between clauses; quoted spaces are shown as U+2005, which word spacing does
 * not widen (logic/query/displayText.ts).
 */
export const QUERY_TEXT_BOX_STYLE: CSSProperties = {
  fontKerning: 'none',
  fontVariantLigatures: 'none',
  fontFeatureSettings: '"kern" 0, "liga" 0, "calt" 0',
  letterSpacing: 'normal',
  wordSpacing: '0.5em',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'break-word',
  wordBreak: 'normal',
  lineHeight: `${QUERY_LINE_HEIGHT_PX}px`,
  paddingLeft: PAD_LEFT_PX,
  paddingRight: PAD_RIGHT_PX,
  paddingTop: QUERY_PAD_Y_PX,
  paddingBottom: QUERY_PAD_Y_PX,
};

/** Height cap of the text box (the frame adds its border). */
export const QUERY_MAX_TEXT_HEIGHT_PX = QUERY_MAX_LINES * QUERY_LINE_HEIGHT_PX + 2 * QUERY_PAD_Y_PX;

/** Minimum text box height: one line plus padding. */
export const QUERY_MIN_TEXT_HEIGHT_PX = QUERY_LINE_HEIGHT_PX + 2 * QUERY_PAD_Y_PX;

/**
 * Geometry of the painted pill boxes (logic/query/fieldGeometry.ts pillBoxes): absolutely
 * positioned behind the glyphs, sized from where the glyphs render horizontally and from the line
 * box vertically, so they never change any glyph's advance and have the same height at any font
 * or zoom.
 */
export const PILL_METRICS = {
  lineHeight: QUERY_LINE_HEIGHT_PX,
  padTop: QUERY_PAD_Y_PX,
  pillHeight: PILL_HEIGHT_PX,
  padX: PILL_PAD_X_PX,
  border: PILL_BORDER_PX,
} as const;

/** Outer frame. Focus only cross-fades colours; nothing changes size. */
export function queryFrameClass(focused: boolean): string {
  return `relative w-full rounded-md border transition-[border-color,box-shadow,background-color] duration-150 motion-reduce:transition-none cursor-text ${
    focused
      ? 'bg-white dark:bg-slate-950 border-blue-500 dark:border-blue-500/80 ring-3 ring-blue-500/15 dark:ring-blue-400/15'
      : 'bg-slate-100 dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
  }`;
}

/**
 * The real textarea: transparent glyphs over the decoration layer, a visible caret, no visible
 * scrollbar (it would narrow the text box and break wrapping parity with the decoration layer).
 * Selection keeps the app's global ::selection (opaque blue, white glyphs), which reads like a
 * native selection on top of the pills.
 */
export const QUERY_TEXTAREA_CLASS = `${QUERY_TEXT_BOX_CLASS} absolute inset-0 z-10 m-0 h-full w-full resize-none overflow-x-hidden overflow-y-auto border-0 bg-transparent outline-none text-transparent caret-slate-900 dark:caret-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`;

/** Search icon at the left of the first line (positioned with SEARCH_ICON_STYLE). */
export const SEARCH_ICON_STYLE: CSSProperties = { left: SEARCH_ICON_LEFT_PX };

export function querySearchIconClass(focused: boolean): string {
  return `absolute top-[8px] z-20 pointer-events-none transition-colors ${
    focused ? 'text-blue-500 dark:text-blue-400' : 'text-slate-400 dark:text-slate-500'
  }`;
}

/** Clear-all button at the right of the first line. */
export const QUERY_CLEAR_BUTTON_CLASS =
  'absolute right-1.5 top-[6px] z-30 inline-flex items-center justify-center size-4.5 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-200/80 dark:text-slate-500 dark:hover:text-slate-200 dark:hover:bg-slate-800 cursor-pointer transition-colors';

/**
 * Pill fill per tone, identical at rest and while editing (focus only toggles the border). Every
 * fill is opaque so it looks the same on the rest frame and the focused frame; dark tints are
 * translucent tones pre-mixed with the rest frame background (slate-900). The inset remove button
 * reuses the fill so it covers the glyphs with the pill's own surface.
 */
const PILL_FILL: Readonly<Record<ClauseTone, string>> = {
  ok: 'bg-blue-50 dark:bg-[color-mix(in_srgb,var(--color-blue-950)_60%,var(--color-slate-900))]',
  negated: 'bg-rose-50 dark:bg-[color-mix(in_srgb,var(--color-rose-950)_60%,var(--color-slate-900))]',
  error: 'bg-red-50 dark:bg-[color-mix(in_srgb,var(--color-red-950)_60%,var(--color-slate-900))]',
  incomplete: 'bg-amber-50 dark:bg-[color-mix(in_srgb,var(--color-amber-950)_40%,var(--color-slate-900))]',
  draft: 'bg-white dark:bg-[color-mix(in_srgb,var(--color-slate-800)_60%,var(--color-slate-900))]',
  term: 'bg-white dark:bg-[color-mix(in_srgb,var(--color-slate-800)_70%,var(--color-slate-900))]',
  negatedTerm: 'bg-white dark:bg-[color-mix(in_srgb,var(--color-slate-800)_70%,var(--color-slate-900))]',
};

/** Pill border per tone, shown on chips (borders, not outlines, so wrapped pills slice cleanly). */
const PILL_BORDER: Readonly<Record<ClauseTone, string>> = {
  ok: 'border-blue-200 dark:border-blue-700/50',
  negated: 'border-rose-200 dark:border-rose-800/50',
  error: 'border-red-400 dark:border-red-500/70',
  incomplete: 'border-dashed border-amber-400 dark:border-amber-500/60',
  draft: 'border-dashed border-slate-300 dark:border-slate-600',
  term: 'border-slate-200 dark:border-slate-700',
  negatedTerm: 'border-rose-200 dark:border-rose-800/50',
};

/**
 * Shape of one pill box: bordered and rounded, except at a line break inside a wrapped pill,
 * where the fragment is open (no border, square corners) like a sliced inline box.
 */
function pillShapeClass(first: boolean, last: boolean): string {
  return `absolute box-border border rounded-md ${first ? '' : 'border-l-0 rounded-l-none'} ${
    last ? '' : 'border-r-0 rounded-r-none'
  }`;
}

/**
 * Pill box classes. Every pill keeps its tone's fill; at rest every pill is a bordered chip, and
 * while editing only the caret's clause keeps its border (the others' border turns transparent,
 * so nothing changes size).
 */
export function pillClass(tone: ClauseTone, chip: boolean, first = true, last = true): string {
  return `${pillShapeClass(first, last)} transition-[border-color] duration-150 motion-reduce:transition-none ${
    PILL_FILL[tone]
  } ${chip ? PILL_BORDER[tone] : 'border-transparent'}`;
}

/**
 * The hovered pill's last box again, above the textarea: same geometry with a transparent
 * border, so its padding box (where the remove button sits) is exactly inside the painted
 * pill's border.
 */
export const PILL_OVERLAY_CLASS = `${pillShapeClass(false, true)} border-transparent pointer-events-none`;

/** Wavy underline marking the offending part of an error clause. Never strikethrough. */
export const ERROR_UNDERLINE_CLASS =
  'underline decoration-wavy decoration-red-500 dark:decoration-red-400 underline-offset-[3px] decoration-[1.5px]';

interface ToneText {
  readonly key: string;
  readonly value: string;
  readonly punct: string;
}

const TONE_TEXT: Readonly<Record<ClauseTone, ToneText>> = {
  ok: {
    key: 'text-blue-700/70 dark:text-blue-300/70',
    value: 'text-blue-800 dark:text-blue-200',
    punct: 'text-blue-700/40 dark:text-blue-300/40',
  },
  negated: {
    key: 'text-rose-700/70 dark:text-rose-300/70',
    value: 'text-rose-800 dark:text-rose-200',
    punct: 'text-rose-700/40 dark:text-rose-300/40',
  },
  error: {
    key: 'text-red-700/75 dark:text-red-300/75',
    value: 'text-red-800 dark:text-red-200',
    punct: 'text-red-700/40 dark:text-red-300/40',
  },
  incomplete: {
    key: 'text-amber-700/80 dark:text-amber-300/80',
    value: 'text-amber-800 dark:text-amber-200',
    punct: 'text-amber-700/50 dark:text-amber-300/50',
  },
  draft: {
    key: 'text-slate-500 dark:text-slate-400',
    value: 'text-slate-800 dark:text-slate-100',
    punct: 'text-slate-400 dark:text-slate-500',
  },
  term: {
    key: 'text-slate-800 dark:text-slate-100',
    value: 'text-slate-800 dark:text-slate-100',
    punct: 'text-slate-400 dark:text-slate-500',
  },
  negatedTerm: {
    key: 'text-rose-700 dark:text-rose-300',
    value: 'text-rose-700 dark:text-rose-300',
    punct: 'text-rose-400 dark:text-rose-500',
  },
};

/** Text colour of one syntax segment of a pill (colour and underline only, never weight). */
export function segmentClass(tone: ClauseTone, role: SegmentRole): string {
  const t = TONE_TEXT[tone];
  switch (role) {
    case 'neg':
      return 'text-rose-600 dark:text-rose-400';
    case 'key':
      return t.key;
    case 'colon':
    case 'comma':
      return t.punct;
    case 'badkey':
    case 'badvalue':
      return `text-red-700 dark:text-red-300 ${ERROR_UNDERLINE_CLASS}`;
    case 'value':
    case 'text':
      return t.value;
  }
}

/**
 * The inset remove button: it covers the pill's trailing glyphs with an opaque copy of the pill's
 * fill (PILL_FILL) whose left edge fades out, so the glyphs fade underneath the x.
 */
const REMOVE_TEXT: Readonly<Record<ClauseTone, string>> = {
  ok: 'text-blue-700/80 hover:text-blue-950 dark:text-blue-300/80 dark:hover:text-blue-100',
  negated: 'text-rose-700/80 hover:text-rose-950 dark:text-rose-300/80 dark:hover:text-rose-100',
  error: 'text-red-700/80 hover:text-red-950 dark:text-red-300/80 dark:hover:text-red-100',
  incomplete: 'text-amber-700/80 hover:text-amber-950 dark:text-amber-300/80 dark:hover:text-amber-100',
  draft: 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100',
  term: 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100',
  negatedTerm: 'text-rose-600 hover:text-rose-900 dark:text-rose-300/80 dark:hover:text-rose-100',
};

/**
 * The remove button: pinned to the right of the overlay box's padding box (inset-y-0 right-0),
 * so CSS layout keeps it inside the pill border and vertically centred, with the pill's inner
 * corner radius (rounded-md minus the 1px border).
 */
export function removeButtonClass(tone: ClauseTone): string {
  return `group/x pointer-events-auto absolute inset-y-0 right-0 w-6 pl-1.5 inline-flex items-center justify-center rounded-r-[5px] cursor-pointer [mask-image:linear-gradient(to_right,transparent,#000_6px)] transition-[opacity,color] duration-150 ease-out starting:opacity-0 motion-reduce:transition-none ${PILL_FILL[tone]} ${REMOVE_TEXT[tone]}`;
}

/** Tinted circle behind the remove icon, shown while the x itself is hovered. */
const REMOVE_HOVER_CIRCLE: Readonly<Record<ClauseTone, string>> = {
  ok: 'group-hover/x:bg-blue-200/80 dark:group-hover/x:bg-blue-800/70',
  negated: 'group-hover/x:bg-rose-200/80 dark:group-hover/x:bg-rose-800/70',
  error: 'group-hover/x:bg-red-200/80 dark:group-hover/x:bg-red-800/70',
  incomplete: 'group-hover/x:bg-amber-200/80 dark:group-hover/x:bg-amber-800/60',
  draft: 'group-hover/x:bg-slate-200 dark:group-hover/x:bg-slate-700',
  term: 'group-hover/x:bg-slate-200 dark:group-hover/x:bg-slate-700',
  negatedTerm: 'group-hover/x:bg-rose-200/80 dark:group-hover/x:bg-rose-800/70',
};

export function removeIconClass(tone: ClauseTone): string {
  return `inline-flex size-4 items-center justify-center rounded-full transition-colors duration-150 motion-reduce:transition-none ${REMOVE_HOVER_CIRCLE[tone]}`;
}

/** Muted summary line under the field. */
export const QUERY_SUMMARY_CLASS =
  'mt-1.5 px-1 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5';
