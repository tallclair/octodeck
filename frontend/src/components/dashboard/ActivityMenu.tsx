import { useMemo, useRef, type KeyboardEvent, type Ref, type RefObject } from 'react';
import { Activity, Check, ChevronDown } from 'lucide-react';
import type { FacetValue } from '../../api/octodeck/v1/query_pb';
import { buildActivityOptions } from '../../logic/query/facets';
import { useStableOptions } from '../../hooks/useStableOptions';
import { MENU_ITEM_PROPS, useMenuPanelKeyboard } from '../../hooks/useMenuPanelKeyboard';
import type { ActivityValue, ControlKey, FilterControls } from '../../types/filters';
import type { MultiSelectOption } from './MultiSelectMenu';
import {
  CHEVRON_SIZE,
  MENU_DIVIDER_CLASS,
  MENU_ICON_SIZE,
  MENU_PANEL_BELOW_RIGHT,
  MENU_PANEL_CLASS,
  MENU_ROW_CHECK_CLASS,
  OPTION_COUNT_CLASS,
  chevronClass,
  filterTriggerClass,
  groupHeaderRowClass,
  menuRowClass,
  optionCheckboxClass,
  optionRowClass,
  triggerIconClass,
} from './menuStyles';

export interface ActivityMenuData {
  readonly tracking: FilterControls['tracking'];
  readonly triage: FilterControls['triage'];
  readonly activity: FilterControls['activity'];
  readonly activityFacets: readonly FacetValue[];
  readonly setFilter: <K extends ControlKey>(
    key: K,
    value: FilterControls[K]
  ) => void;
}

export interface ActivityMenuProps extends ActivityMenuData {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly menuRef?: Ref<HTMLDivElement>;
  /**
   * When set, the menu renders only its panel, as a flyout to the left of a parent menu (the
   * overflow "..." menu), and returns focus to this trigger on Escape/Tab.
   */
  readonly hideTrigger?: boolean;
  readonly externalTriggerRef?: RefObject<HTMLButtonElement | null>;
  readonly panelPositionClassName?: string;
}

const TRACKING_ROWS = [
  { value: 'tracked' as const, label: 'Subscribed' },
  { value: 'untracked' as const, label: 'Unsubscribed' },
];

export function ActivityMenu({
  tracking,
  triage,
  activity,
  activityFacets,
  open,
  onToggle,
  onClose,
  menuRef,
  setFilter,
  hideTrigger = false,
  externalTriggerRef,
  panelPositionClassName,
}: ActivityMenuProps) {
  const internalTriggerRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = externalTriggerRef ?? internalTriggerRef;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const handlePanelKeyDown = useMenuPanelKeyboard({ open, panelRef, triggerRef, onClose });

  const rawActivityOptions = useMemo<readonly MultiSelectOption<ActivityValue>[]>(
    () => buildActivityOptions(activityFacets),
    [activityFacets]
  );

  const activityOptions = useStableOptions(open, rawActivityOptions, { sort: false });

  const hasSelection =
    tracking !== 'all' ||
    (triage !== 'activity' && activity.length > 0);

  const handleSelectTracking = (val: 'tracked' | 'untracked') => {
    setFilter('tracking', tracking === val ? 'all' : val);
    triggerRef.current?.focus();
    onClose();
  };

  const toggleActivity = (val: ActivityValue, currentlySelected: boolean) => {
    const next = currentlySelected
      ? activity.filter((v) => v !== val)
      : [...activity, val];
    setFilter('activity', next);
  };

  // Option rows are divs (role="option"), so Space/Enter must be wired up by hand.
  const handleOptionKeyDown = (
    e: KeyboardEvent<HTMLDivElement>,
    val: ActivityValue,
    currentlySelected: boolean
  ) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggleActivity(val, currentlySelected);
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      {!hideTrigger && (
        <button
          ref={triggerRef}
          type="button"
          onClick={onToggle}
          aria-label="Filter by activity"
          aria-haspopup="dialog"
          aria-expanded={open}
          className={filterTriggerClass(hasSelection)}
        >
          <Activity size={MENU_ICON_SIZE} className={triggerIconClass(hasSelection)} />
          <span>Activity</span>
          <ChevronDown size={CHEVRON_SIZE} className={chevronClass(open)} />
        </button>
      )}

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Activity filters"
          tabIndex={-1}
          onKeyDown={handlePanelKeyDown}
          className={`${MENU_PANEL_CLASS} ${panelPositionClassName ?? MENU_PANEL_BELOW_RIGHT} w-56 py-1`}
        >
          {TRACKING_ROWS.map((row) => {
            const isActive = tracking === row.value;
            return (
              <button
                {...MENU_ITEM_PROPS}
                key={row.value}
                type="button"
                tabIndex={-1}
                onClick={() => handleSelectTracking(row.value)}
                className={menuRowClass(isActive)}
              >
                <span>{row.label}</span>
                {isActive && <Check size={MENU_ICON_SIZE} className={MENU_ROW_CHECK_CLASS} />}
              </button>
            );
          })}

          <div aria-hidden="true" className={MENU_DIVIDER_CLASS} />

          <div
            role="listbox"
            aria-multiselectable="true"
            aria-label="New activity"
          >
            {activityOptions.map((option) => {
              const isSelected = activity.includes(option.value);
              const isZeroCount = option.count === 0 && !isSelected;
              return (
                <div key={option.value}>
                  <div
                    {...MENU_ITEM_PROPS}
                    role="option"
                    tabIndex={-1}
                    aria-selected={isSelected}
                    data-zero-count={isZeroCount ? 'true' : undefined}
                    onClick={() => toggleActivity(option.value, isSelected)}
                    onKeyDown={(e) => handleOptionKeyDown(e, option.value, isSelected)}
                    className={
                      option.isGroupHeader
                        ? groupHeaderRowClass({ selected: isSelected })
                        : optionRowClass({
                            selected: isSelected,
                            zeroCount: isZeroCount,
                            indented: option.indented,
                          })
                    }
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span aria-hidden="true" className={optionCheckboxClass(isSelected)}>
                        {isSelected && <Check size={10} strokeWidth={3} />}
                      </span>
                      <span className="truncate">{option.label ?? option.value}</span>
                    </span>
                    {option.count !== null && option.count !== undefined && (
                      <span aria-hidden="true" className={OPTION_COUNT_CLASS}>
                        {option.count}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
