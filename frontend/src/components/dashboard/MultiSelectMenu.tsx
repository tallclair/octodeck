import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from 'react';
import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import type { OptionList } from '../../logic/query/facets';
import { useStableOptions, type StableOptionItem } from '../../hooks/useStableOptions';
import {
  CHEVRON_SIZE,
  MENU_DIVIDER_CLASS,
  MENU_ICON_SIZE,
  MENU_PANEL_BELOW_LEFT,
  MENU_PANEL_BELOW_RIGHT,
  MENU_LISTBOX_SCROLL_CLASS,
  MENU_PANEL_CLASS,
  OPTION_COUNT_CLASS,
  chevronClass,
  filterTriggerClass,
  groupHeaderRowClass,
  optionCheckboxClass,
  optionRowClass,
  triggerIconClass,
} from './menuStyles';

export interface MultiSelectOption<V extends string = string> extends StableOptionItem {
  readonly value: V;
  readonly count: number | null;
  readonly label?: string;
  readonly color?: string;
  readonly pinned?: boolean;
  readonly dividerBefore?: boolean;
  readonly group?: string;
  readonly isGroupHeader?: boolean;
  readonly indented?: boolean;
}

export interface MultiSelectMenuProps<V extends string = string> {
  readonly label: string;
  readonly ariaLabel?: string;
  /** Leading trigger icon; sized and coloured (blue while a value is selected) by the menu. */
  readonly icon?: LucideIcon;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly menuRef?: Ref<HTMLDivElement>;
  readonly selected: readonly V[];
  readonly onChange: (next: V[]) => void;
  readonly buildOptions: (showAll: boolean) => OptionList<MultiSelectOption<V>>;
  readonly searchable?: boolean;
  readonly filterPlaceholder?: string;
  readonly sortOptions?: boolean;
  readonly valuePrefix?: string;
  readonly align?: 'left' | 'right';
  readonly panelPositionClassName?: string;
  readonly hideTrigger?: boolean;
  readonly externalTriggerRef?: RefObject<HTMLButtonElement | null>;
  readonly isOptionSelected?: (option: MultiSelectOption<V>, selected: readonly V[]) => boolean;
  readonly onToggleOption?: (option: MultiSelectOption<V>, isSelected: boolean) => void;
  readonly emptyMessage?: string;
}

function defaultIsSelected<V extends string>(
  option: MultiSelectOption<V>,
  selected: readonly V[]
): boolean {
  return selected.some((s) => s.toLowerCase() === option.value.toLowerCase());
}

export function MultiSelectMenu<V extends string = string>({
  label,
  ariaLabel,
  icon: Icon,
  open,
  onToggle,
  onClose,
  menuRef,
  selected,
  onChange,
  buildOptions,
  searchable = true,
  filterPlaceholder,
  sortOptions = true,
  valuePrefix = '',
  align = 'right',
  panelPositionClassName,
  hideTrigger = false,
  externalTriggerRef,
  isOptionSelected = defaultIsSelected,
  onToggleOption,
  emptyMessage,
}: MultiSelectMenuProps<V>) {
  const [showAll, setShowAll] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [prevOpen, setPrevOpen] = useState(open);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      if (showAll) setShowAll(false);
      if (filterText) setFilterText('');
      if (focusedIndex !== -1) setFocusedIndex(-1);
    }
  }

  const internalTriggerRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = externalTriggerRef ?? internalTriggerRef;
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (open) {
      if (searchable) {
        filterInputRef.current?.focus();
      } else {
        listboxRef.current?.focus();
      }
    }
  }, [open, searchable]);

  const { list: currentOptions, hasMore } = buildOptions(showAll);
  const stableOptions = useStableOptions(open, currentOptions, { sort: sortOptions });

  const normalizedFilter = filterText.trim().toLowerCase();
  const matchesFilter = (opt: MultiSelectOption<V>) => {
    const display = opt.label ?? `${valuePrefix}${opt.value}`;
    return (
      opt.value.toLowerCase().includes(normalizedFilter) ||
      display.toLowerCase().includes(normalizedFilter)
    );
  };

  const visibleOptions = normalizedFilter
    ? stableOptions.filter((opt) => {
        if (opt.group !== undefined) {
          if (opt.isGroupHeader) {
            return (
              matchesFilter(opt) ||
              stableOptions.some((o) => o.group === opt.group && matchesFilter(o))
            );
          }
          const header = stableOptions.find(
            (o) => o.isGroupHeader && o.group === opt.group
          );
          return matchesFilter(opt) || (header !== undefined && matchesFilter(header));
        }
        return matchesFilter(opt);
      })
    : stableOptions;

  const handleToggleOption = (option: MultiSelectOption<V>) => {
    const currentlySelected = isOptionSelected(option, selected);
    if (onToggleOption) {
      onToggleOption(option, currentlySelected);
      return;
    }
    if (currentlySelected) {
      onChange(selected.filter((s) => s.toLowerCase() !== option.value.toLowerCase()));
    } else {
      onChange([...selected, option.value]);
    }
  };

  const focusOptionAt = (index: number) => {
    if (visibleOptions.length === 0) return;
    const clamped = Math.max(0, Math.min(index, visibleOptions.length - 1));
    setFocusedIndex(clamped);
    optionRefs.current[clamped]?.focus();
  };

  const handlePanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.focus();
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      triggerRef.current?.focus();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusOptionAt(focusedIndex < 0 ? 0 : focusedIndex + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (focusedIndex <= 0) {
        setFocusedIndex(-1);
        if (searchable) {
          filterInputRef.current?.focus();
        }
      } else {
        focusOptionAt(focusedIndex - 1);
      }
      return;
    }
    if ((e.key === ' ' || e.key === 'Enter') && focusedIndex >= 0 && focusedIndex < visibleOptions.length) {
      const target = e.target as HTMLElement | null;
      const isFilterInput = target?.tagName === 'INPUT';
      if (!isFilterInput || e.key === 'Enter') {
        e.preventDefault();
        handleToggleOption(visibleOptions[focusedIndex]);
      }
    }
  };

  const hasSelection = selected.length > 0;
  const triggerAriaLabel = ariaLabel ?? `Filter by ${label.toLowerCase()}`;
  const placeholder = filterPlaceholder ?? `Filter ${label.toLowerCase()}s…`;
  const emptyText = emptyMessage ?? `No ${label.toLowerCase()}s found`;

  const positionClasses =
    panelPositionClassName ?? (align === 'left' ? MENU_PANEL_BELOW_LEFT : MENU_PANEL_BELOW_RIGHT);

  const panel = open ? (
    <div
      onKeyDown={handlePanelKeyDown}
      className={`${MENU_PANEL_CLASS} ${positionClasses} w-64 flex flex-col overflow-hidden`}
    >
      {searchable && (
        <div className="p-2 border-b border-slate-100 dark:border-slate-800/80 shrink-0">
          <input
            ref={filterInputRef}
            type="text"
            value={filterText}
            onChange={(e) => {
              setFilterText(e.target.value);
              setFocusedIndex(-1);
            }}
            onFocus={() => setFocusedIndex(-1)}
            placeholder={placeholder}
            aria-label={placeholder}
            className="w-full px-2 py-1 text-xs rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      )}

      {hasSelection && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-900/50 shrink-0 text-xs">
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            {selected.length} selected
          </span>
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
          >
            Clear
          </button>
        </div>
      )}

      <div
        ref={listboxRef}
        role="listbox"
        aria-multiselectable="true"
        aria-label={label}
        tabIndex={searchable ? -1 : 0}
        className={`${MENU_LISTBOX_SCROLL_CLASS} py-1 focus:outline-none`}
      >
        {visibleOptions.length === 0 ? (
          <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500 italic">
            {emptyText}
          </div>
        ) : (
          visibleOptions.map((option, idx) => {
            const isSelected = isOptionSelected(option, selected);
            // A selected option is never dimmed, even when it currently matches nothing.
            const isZeroCount = option.count === 0 && !isSelected;
            const displayLabel = option.label ?? `${valuePrefix}${option.value}`;
            const cleanColor = option.color ? option.color.replace(/^#/, '') : '';

            const showDivider =
              option.dividerBefore ||
              (idx > 0 && Boolean(visibleOptions[idx - 1].pinned) && !option.pinned);

            const isFocused = focusedIndex === idx;
            const rowClassName = option.isGroupHeader
              ? groupHeaderRowClass({ selected: isSelected, focused: isFocused })
              : optionRowClass({
                  selected: isSelected,
                  focused: isFocused,
                  zeroCount: isZeroCount,
                  indented: option.indented,
                });

            return (
              <div key={option.isGroupHeader ? `group:${option.value}` : option.value}>
                {showDivider && (
                  <div aria-hidden="true" className={MENU_DIVIDER_CLASS} />
                )}
                <div
                  ref={(el) => {
                    optionRefs.current[idx] = el;
                  }}
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  data-zero-count={isZeroCount ? 'true' : undefined}
                  onClick={() => {
                    setFocusedIndex(idx);
                    handleToggleOption(option);
                  }}
                  onFocus={() => setFocusedIndex(idx)}
                  className={rowClassName}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span aria-hidden="true" className={optionCheckboxClass(isSelected)}>
                      {isSelected && <Check size={10} strokeWidth={3} />}
                    </span>
                    {cleanColor && (
                      <span
                        aria-hidden="true"
                        className="w-2.5 h-2.5 rounded-full shrink-0 border border-black/10 dark:border-white/15"
                        style={{ backgroundColor: `#${cleanColor}` }}
                      />
                    )}
                    <span className="truncate">{displayLabel}</span>
                  </span>
                  {option.count !== null && (
                    <span aria-hidden="true" className={OPTION_COUNT_CLASS}>
                      {option.count}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}

        {!showAll && hasMore && (
          <div className="border-t border-slate-200 dark:border-slate-800 mt-1 pt-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowAll(true);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium cursor-pointer"
            >
              Show all
            </button>
          </div>
        )}
      </div>
    </div>
  ) : null;

  if (hideTrigger) {
    return panel;
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        ref={internalTriggerRef}
        type="button"
        onClick={onToggle}
        className={filterTriggerClass(hasSelection)}
        aria-label={triggerAriaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {Icon && <Icon size={MENU_ICON_SIZE} className={triggerIconClass(hasSelection)} />}
        <span className="truncate max-w-[140px]">
          {label}
        </span>
        <ChevronDown size={CHEVRON_SIZE} className={chevronClass(open)} />
      </button>

      {panel}
    </div>
  );
}
