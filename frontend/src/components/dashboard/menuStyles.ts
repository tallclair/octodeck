/**
 * Shared Tailwind class strings for the dashboard filter toolbar, its dropdown menus and the
 * list-level menus (sort, triage title).
 *
 * Every toolbar control and menu panel takes its classes from here so heights, borders, colours
 * and row metrics cannot drift apart between hand-written components (StateMenu, SortMenu,
 * OverflowFilterMenu, ...) and MultiSelectMenu. Prefer adding a new helper here over writing a
 * one-off class string in a component.
 */

/**
 * Fixed height shared by every control in the filter toolbar row (segmented control, bordered
 * triggers, icon-only triggers), so they line up regardless of padding, borders or icon-only
 * content.
 */
const TOOLBAR_CONTROL_HEIGHT = 'h-6.5';

/**
 * TOOLBAR_CONTROL_HEIGHT in px, for controls that size themselves from text metrics instead of a
 * height class (the query input's single-line height). Keep in sync with the class above.
 */
export const TOOLBAR_CONTROL_HEIGHT_PX = 26;

/** Keyboard focus ring for toolbar controls; mouse clicks do not show it. */
const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500';

/** Size (px) for lucide icons inside triggers and menu rows. */
export const MENU_ICON_SIZE = 13;

/** Size (px) for the trigger chevrons. */
export const CHEVRON_SIZE = 12;

/** Frame shared by all bordered toolbar triggers: height, border, radius, type and focus ring. */
const TRIGGER_FRAME = `inline-flex ${TOOLBAR_CONTROL_HEIGHT} shrink-0 items-center rounded-md border text-xs font-medium transition-colors cursor-pointer select-none shadow-2xs ${FOCUS_RING}`;

const TRIGGER_ACTIVE =
  'bg-blue-50 dark:bg-blue-950/80 border-blue-300 dark:border-blue-500/80 text-blue-700 dark:text-blue-200';

const TRIGGER_INACTIVE =
  'bg-white dark:bg-slate-900/60 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-slate-200';

/** Inactive trigger whose menu is open (used by the icon-only overflow trigger). */
const TRIGGER_OPEN =
  'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-200';

/** Bordered dropdown or toggle trigger in the filter toolbar (State, Repository, Author, ...). */
export function filterTriggerClass(active: boolean): string {
  return `${TRIGGER_FRAME} gap-1.5 px-2.5 ${active ? TRIGGER_ACTIVE : TRIGGER_INACTIVE}`;
}

/**
 * Bordered, square icon-only trigger in the filter toolbar (the overflow "..." menu). Same frame
 * and colours as filterTriggerClass, plus a neutral pressed look while its menu is open.
 */
export function iconTriggerClass(active: boolean, open: boolean): string {
  return `${TRIGGER_FRAME} w-6.5 justify-center ${
    active ? TRIGGER_ACTIVE : open ? TRIGGER_OPEN : TRIGGER_INACTIVE
  }`;
}

/**
 * Leading icon of a toolbar trigger or menu row; turns blue together with the trigger or row when
 * a filter is set.
 */
export function triggerIconClass(active: boolean): string {
  return `shrink-0 ${
    active ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400 dark:text-slate-500'
  }`;
}

/**
 * Trailing chevron of a dropdown trigger. It inherits the trigger's text colour (muted while
 * closed) so it works on both the neutral and the blue active trigger, and flips while open.
 */
export function chevronClass(open: boolean): string {
  return `shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : 'opacity-70'}`;
}

/** Container of the PRs / Issues segmented control; same outer height as the triggers. */
export const SEGMENTED_GROUP_CLASS = `inline-flex ${TOOLBAR_CONTROL_HEIGHT} shrink-0 p-0.5 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900 shadow-2xs`;

/**
 * Segment button. The font weight is the same for both states so selecting a segment does not
 * change its width and shift the rest of the toolbar.
 */
export function segmentedButtonClass(active: boolean): string {
  return `inline-flex items-center gap-1.5 px-2.5 rounded text-xs font-medium transition-colors cursor-pointer select-none ${FOCUS_RING} ${
    active
      ? 'bg-white dark:bg-blue-600 text-slate-900 dark:text-white shadow-xs'
      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
  }`;
}

/** Dropdown panel surface (position and width are supplied separately). */
export const MENU_PANEL_CLASS =
  'absolute z-50 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl focus:outline-none';

/** Panel anchored below its trigger, aligned to the trigger's right edge. */
export const MENU_PANEL_BELOW_RIGHT = 'right-0 top-full mt-1.5';

/** Panel anchored below its trigger, aligned to the trigger's left edge. */
export const MENU_PANEL_BELOW_LEFT = 'left-0 top-full mt-1.5';

/** Flyout submenu panel opening to the left of its parent panel, aligned to the parent's top. */
export const MENU_PANEL_FLYOUT_LEFT = 'right-full top-0 mr-0.5';

/**
 * Scrollable option list inside a dropdown panel. The list caps its own height instead of
 * flex-shrinking inside a max-height panel: that relied on the flex column resolving the
 * auto-height, absolutely positioned panel's size before sizing the list, and when it did not
 * (first layout after opening) the list kept its full content height and the panel's
 * overflow-hidden clipped it with no scrollbar. A self-capped list scrolls on the first paint.
 */
export const MENU_LISTBOX_SCROLL_CLASS = 'max-h-64 min-h-0 overflow-y-auto overscroll-contain';

/** Horizontal divider between groups of menu rows. */
export const MENU_DIVIDER_CLASS = 'my-1 border-t border-slate-200 dark:border-slate-800';

/** Small uppercase heading for a non-interactive section inside a panel (e.g. "Activity"). */
export const MENU_SECTION_HEADER_CLASS =
  'px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 select-none';

/** Row background shown for the keyboard-focused option. */
const ROW_FOCUS_VISIBLE = 'focus:outline-none focus-visible:bg-slate-100 dark:focus-visible:bg-slate-800';

/**
 * Single-select / action row (State, Sort, triage title, overflow submenu rows).
 * `highlighted` marks a row whose submenu is currently open.
 */
export function menuRowClass(active: boolean, highlighted = false): string {
  return `w-full px-3 py-1.5 text-xs text-left flex items-center justify-between gap-2 transition-colors cursor-pointer select-none ${ROW_FOCUS_VISIBLE} ${
    active
      ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
      : highlighted
        ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white'
        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
  }`;
}

/** Check mark icon class for the active single-select row. */
export const MENU_ROW_CHECK_CLASS = 'shrink-0 text-blue-600 dark:text-blue-400';

export interface OptionRowState {
  readonly selected: boolean;
  /** Option holds the roving focus (tracked in component state rather than DOM focus). */
  readonly focused?: boolean;
  /** Option currently matches nothing; dimmed unless it is selected. */
  readonly zeroCount?: boolean;
  /** Nested under a group header. */
  readonly indented?: boolean;
}

/** Checkbox-style multi-select option row (MultiSelectMenu, StateMenu activity section). */
export function optionRowClass({
  selected,
  focused = false,
  zeroCount = false,
  indented = false,
}: OptionRowState): string {
  const background = focused
    ? 'bg-slate-100 dark:bg-slate-800/80'
    : selected
      ? 'bg-blue-50/70 dark:bg-blue-950/40'
      : 'hover:bg-slate-100 dark:hover:bg-slate-800';
  const text = selected
    ? 'text-blue-600 dark:text-blue-400 font-semibold'
    : 'text-slate-700 dark:text-slate-300';
  return `w-full text-left ${indented ? 'pl-6 pr-3' : 'px-3'} py-1.5 text-xs flex items-center justify-between gap-2 transition-colors cursor-pointer select-none ${ROW_FOCUS_VISIBLE} ${background} ${text}${
    zeroCount ? ' opacity-50' : ''
  }`;
}

/**
 * Selectable group header row with options indented beneath it (organizations in the Repository
 * menu, "New Activity" in the State menu): bold uppercase label on a tinted background.
 */
export function groupHeaderRowClass({
  selected,
  focused = false,
}: Pick<OptionRowState, 'selected' | 'focused'>): string {
  const background = focused
    ? 'bg-slate-100 dark:bg-slate-800/80'
    : selected
      ? 'bg-blue-50/70 dark:bg-blue-950/40'
      : 'bg-slate-100/50 dark:bg-slate-950/40 hover:bg-slate-100 dark:hover:bg-slate-800';
  const text = selected
    ? 'text-blue-700 dark:text-blue-300'
    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white';
  return `w-full text-left px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between gap-2 transition-colors cursor-pointer select-none ${ROW_FOCUS_VISIBLE} ${background} ${text}`;
}

/** Square checkbox drawn at the start of a multi-select option row. */
export function optionCheckboxClass(selected: boolean): string {
  return `w-3.5 h-3.5 rounded-xs border flex items-center justify-center shrink-0 ${
    selected
      ? 'bg-blue-600 border-blue-600 text-white'
      : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900'
  }`;
}

/** Facet count shown at the end of an option row. */
export const OPTION_COUNT_CLASS = 'text-[11px] font-mono text-slate-400 dark:text-slate-500 shrink-0';
