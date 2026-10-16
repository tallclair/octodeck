import { useRef, type Ref } from 'react';
import { Check, ChevronDown, Disc, GitPullRequest } from 'lucide-react';
import { MENU_ITEM_PROPS, useMenuPanelKeyboard } from '../../hooks/useMenuPanelKeyboard';
import type { ControlKey, FilterControls } from '../../types/filters';
import {
  CHEVRON_SIZE,
  MENU_ICON_SIZE,
  MENU_PANEL_BELOW_RIGHT,
  MENU_PANEL_CLASS,
  MENU_ROW_CHECK_CLASS,
  chevronClass,
  filterTriggerClass,
  menuRowClass,
  triggerIconClass,
} from './menuStyles';

export interface TypeMenuProps {
  readonly type: FilterControls['type'];
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly menuRef?: Ref<HTMLDivElement>;
  readonly setFilter: <K extends ControlKey>(
    key: K,
    value: FilterControls[K]
  ) => void;
}

const TYPE_OPTIONS = [
  { value: 'pr' as const, label: 'Pull requests', Icon: GitPullRequest },
  { value: 'issue' as const, label: 'Issues', Icon: Disc },
];

export function TypeMenu({
  type,
  open,
  onToggle,
  onClose,
  menuRef,
  setFilter,
}: TypeMenuProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const handlePanelKeyDown = useMenuPanelKeyboard({ open, panelRef, triggerRef, onClose });

  const isActive = type !== 'all';

  const handleSelect = (val: 'pr' | 'issue') => {
    setFilter('type', type === val ? 'all' : val);
    triggerRef.current?.focus();
    onClose();
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={onToggle}
        aria-label="Filter by type"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={filterTriggerClass(isActive)}
      >
        <GitPullRequest size={MENU_ICON_SIZE} className={triggerIconClass(isActive)} />
        <span>Type</span>
        <ChevronDown size={CHEVRON_SIZE} className={chevronClass(open)} />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Type filter"
          tabIndex={-1}
          onKeyDown={handlePanelKeyDown}
          className={`${MENU_PANEL_CLASS} ${MENU_PANEL_BELOW_RIGHT} w-44 py-1`}
        >
          {TYPE_OPTIONS.map((opt) => {
            const isOptionActive = type === opt.value;
            return (
              <button
                {...MENU_ITEM_PROPS}
                key={opt.value}
                type="button"
                tabIndex={-1}
                onClick={() => handleSelect(opt.value)}
                className={menuRowClass(isOptionActive)}
              >
                <span className="flex items-center gap-2">
                  <opt.Icon size={MENU_ICON_SIZE} className={triggerIconClass(isOptionActive)} />
                  <span>{opt.label}</span>
                </span>
                {isOptionActive && (
                  <Check size={MENU_ICON_SIZE} className={MENU_ROW_CHECK_CLASS} />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
