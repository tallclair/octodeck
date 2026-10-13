import { useRef, type RefObject } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { MENU_ITEM_PROPS, useMenuPanelKeyboard } from '../../hooks/useMenuPanelKeyboard';
import type { SortOption, SortOrder } from '../../types/filters';
import {
  CHEVRON_SIZE,
  MENU_DIVIDER_CLASS,
  MENU_ICON_SIZE,
  MENU_PANEL_BELOW_RIGHT,
  MENU_PANEL_CLASS,
  MENU_ROW_CHECK_CLASS,
  chevronClass,
  menuRowClass,
} from './menuStyles';

export interface SortMenuProps {
  sort: SortOption;
  order: SortOrder;
  onSelectSort: (sort: SortOption) => void;
  onSelectOrder: (order: SortOrder) => void;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  menuRef: RefObject<HTMLDivElement | null>;
}

const SORT_LABELS: Record<SortOption, string> = {
  updated: 'Latest Activity',
  acked: 'Last Acked',
  created: 'Creation Date',
};

const SORT_ROWS: readonly SortOption[] = ['updated', 'acked', 'created'];

const ORDER_ROWS: readonly { readonly value: SortOrder; readonly label: string }[] = [
  { value: 'asc', label: 'Ascending' },
  { value: 'desc', label: 'Descending' },
];

export function SortMenu({
  sort,
  order,
  onSelectSort,
  onSelectOrder,
  isOpen,
  onToggle,
  onClose,
  menuRef,
}: SortMenuProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const handlePanelKeyDown = useMenuPanelKeyboard({ open: isOpen, panelRef, triggerRef, onClose });

  const pick = (select: () => void) => {
    select();
    triggerRef.current?.focus();
    onClose();
  };

  return (
    <div className="relative" ref={menuRef}>
      {/* Deliberately borderless and quieter than the filter toolbar triggers: it sits in the list body. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={onToggle}
        aria-label="Sort options"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        className="flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 px-1 py-0.5 rounded transition-colors cursor-pointer text-xs select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
      >
        <span>{SORT_LABELS[sort]}</span>
        <ChevronDown size={CHEVRON_SIZE} className={chevronClass(isOpen)} />
      </button>

      {isOpen && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Sort options"
          tabIndex={-1}
          onKeyDown={handlePanelKeyDown}
          className={`${MENU_PANEL_CLASS} ${MENU_PANEL_BELOW_RIGHT} w-36 py-1`}
        >
          {SORT_ROWS.map((value) => (
            <button
              {...MENU_ITEM_PROPS}
              key={value}
              type="button"
              tabIndex={-1}
              onClick={() => pick(() => onSelectSort(value))}
              className={menuRowClass(sort === value)}
            >
              <span>{SORT_LABELS[value]}</span>
              {sort === value && <Check size={MENU_ICON_SIZE} className={MENU_ROW_CHECK_CLASS} />}
            </button>
          ))}

          <div aria-hidden="true" className={MENU_DIVIDER_CLASS} />

          {ORDER_ROWS.map(({ value, label }) => (
            <button
              {...MENU_ITEM_PROPS}
              key={value}
              type="button"
              tabIndex={-1}
              onClick={() => pick(() => onSelectOrder(value))}
              className={menuRowClass(order === value)}
            >
              <span>{label}</span>
              {order === value && <Check size={MENU_ICON_SIZE} className={MENU_ROW_CHECK_CLASS} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
