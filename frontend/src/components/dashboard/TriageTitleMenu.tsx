import { useRef, type ReactNode, type RefObject } from 'react';
import { Filter, Zap, CheckCircle, Layers, ChevronDown, Check } from 'lucide-react';
import { MENU_ITEM_PROPS, useMenuPanelKeyboard } from '../../hooks/useMenuPanelKeyboard';
import type { TriageFilter } from '../../types/filters';
import {
  MENU_DIVIDER_CLASS,
  MENU_ICON_SIZE,
  MENU_PANEL_BELOW_LEFT,
  MENU_PANEL_CLASS,
  MENU_ROW_CHECK_CLASS,
  menuRowClass,
} from './menuStyles';

export interface TriageTitleMenuProps {
  triage: TriageFilter;
  onSelect: (tab: TriageFilter) => void;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  menuRef: RefObject<HTMLDivElement | null>;
}

export function TriageTitleMenu({
  triage,
  onSelect,
  isOpen,
  onToggle,
  onClose,
  menuRef,
}: TriageTitleMenuProps) {
  const titleText =
    triage === 'inbox'
      ? 'Inbox'
      : triage === 'activity'
      ? 'New Activity'
      : triage === 'acked'
      ? 'Acked'
      : 'All Items';

  const titleIcon =
    triage === 'inbox' ? (
      <Filter size={18} className="text-blue-400" />
    ) : triage === 'activity' ? (
      <Zap size={18} className="text-orange-400" />
    ) : triage === 'acked' ? (
      <CheckCircle size={18} className="text-emerald-400" />
    ) : (
      <Layers size={18} className="text-slate-400" />
    );

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const handlePanelKeyDown = useMenuPanelKeyboard({ open: isOpen, panelRef, triggerRef, onClose });

  const pick = (tab: TriageFilter) => {
    onSelect(tab);
    triggerRef.current?.focus();
    onClose();
  };

  const rows: readonly {
    readonly tab: TriageFilter;
    readonly label: string;
    readonly icon: ReactNode;
    readonly dividerBefore?: boolean;
  }[] = [
    {
      tab: 'inbox',
      label: 'Inbox',
      icon: <Filter size={MENU_ICON_SIZE} className="shrink-0 text-blue-600 dark:text-blue-400" />,
    },
    {
      tab: 'activity',
      label: 'New Activity',
      icon: <Zap size={MENU_ICON_SIZE} className="shrink-0 text-orange-500 dark:text-orange-400" />,
    },
    {
      tab: 'acked',
      label: 'Acked',
      icon: (
        <CheckCircle size={MENU_ICON_SIZE} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
      ),
    },
    {
      tab: 'all',
      label: 'All Items',
      icon: <Layers size={MENU_ICON_SIZE} className="shrink-0 text-slate-500 dark:text-slate-400" />,
      dividerBefore: true,
    },
  ];

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3 relative" ref={menuRef}>
        <button
          ref={triggerRef}
          type="button"
          onClick={onToggle}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-label="Select triage status"
          className="flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-white tracking-tight hover:text-blue-600 dark:hover:text-blue-300 transition-colors group cursor-pointer select-none rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
        >
          {titleIcon}
          <span>{titleText}</span>
          <ChevronDown
            size={18}
            className={`transition-transform duration-200 ${
              isOpen
                ? 'rotate-180 text-blue-600 dark:text-blue-400'
                : 'text-slate-400 group-hover:text-blue-600 dark:group-hover:text-blue-300'
            }`}
          />
        </button>

        {isOpen && (
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Triage status"
            tabIndex={-1}
            onKeyDown={handlePanelKeyDown}
            className={`${MENU_PANEL_CLASS} ${MENU_PANEL_BELOW_LEFT} w-48 py-1`}
          >
            {rows.map(({ tab, label, icon, dividerBefore }) => (
              <div key={tab}>
                {dividerBefore && <div aria-hidden="true" className={MENU_DIVIDER_CLASS} />}
                <button
                  {...MENU_ITEM_PROPS}
                  type="button"
                  tabIndex={-1}
                  onClick={() => pick(tab)}
                  className={menuRowClass(triage === tab)}
                >
                  <span className="flex items-center gap-2">
                    {icon}
                    <span>{label}</span>
                  </span>
                  {triage === tab && <Check size={MENU_ICON_SIZE} className={MENU_ROW_CHECK_CLASS} />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
