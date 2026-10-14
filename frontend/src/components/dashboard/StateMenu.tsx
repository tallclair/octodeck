import { useMemo, useRef, type KeyboardEvent, type Ref } from 'react';
import { Check, ChevronDown, CircleDot } from 'lucide-react';
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

export interface StateMenuProps {
  readonly state: FilterControls['state'];
  readonly tracking: FilterControls['tracking'];
  readonly triage: FilterControls['triage'];
  readonly activity: FilterControls['activity'];
  readonly activityFacets: readonly FacetValue[];
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly menuRef?: Ref<HTMLDivElement>;
  readonly setFilter: <K extends ControlKey>(
    key: K,
    value: FilterControls[K]
  ) => void;
}

type StateMenuRow =
  | {
      readonly key: 'state';
      readonly value: Exclude<FilterControls['state'], 'all'>;
      readonly label: string;
      readonly dividerBefore?: boolean;
    }
  | {
      readonly key: 'tracking';
      readonly value: Exclude<FilterControls['tracking'], 'all'>;
      readonly label: string;
      readonly dividerBefore?: boolean;
    };

const STATE_MENU_ROWS: readonly StateMenuRow[] = [
  { key: 'state', value: 'open', label: 'Open' },
  { key: 'state', value: 'closed', label: 'Closed' },
  { key: 'state', value: 'merged', label: 'Merged' },
  { key: 'tracking', value: 'tracked', label: 'Tracked', dividerBefore: true },
  { key: 'tracking', value: 'untracked', label: 'Untracked' },
];

export function StateMenu({
  state,
  tracking,
  triage,
  activity,
  activityFacets,
  open,
  onToggle,
  onClose,
  menuRef,
  setFilter,
}: StateMenuProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const handlePanelKeyDown = useMenuPanelKeyboard({ open, panelRef, triggerRef, onClose });

  const rawActivityOptions = useMemo< readonly MultiSelectOption<ActivityValue>[] >(
    () => buildActivityOptions(activityFacets),
    [activityFacets]
  );

  const activityOptions = useStableOptions(open, rawActivityOptions, { sort: false });

  const hasSelection =
    state !== 'all' ||
    tracking !== 'all' ||
    (triage !== 'activity' && activity.length > 0);

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
      <button
        ref={triggerRef}
        type="button"
        onClick={onToggle}
        aria-label="Filter by state"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={filterTriggerClass(hasSelection)}
      >
        <CircleDot size={MENU_ICON_SIZE} className={triggerIconClass(hasSelection)} />
        <span>State</span>
        <ChevronDown size={CHEVRON_SIZE} className={chevronClass(open)} />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="State and activity filters"
          tabIndex={-1}
          onKeyDown={handlePanelKeyDown}
          className={`${MENU_PANEL_CLASS} ${MENU_PANEL_BELOW_RIGHT} w-56 py-1`}
        >
          {STATE_MENU_ROWS.map((row) => {
            const isActive =
              row.key === 'state' ? state === row.value : tracking === row.value;
            return (
              <div key={`${row.key}:${row.value}`}>
                {row.dividerBefore && <div aria-hidden="true" className={MENU_DIVIDER_CLASS} />}
                <button
                  {...MENU_ITEM_PROPS}
                  type="button"
                  tabIndex={-1}
                  onClick={() => {
                    if (row.key === 'state') {
                      setFilter('state', row.value);
                    } else {
                      setFilter('tracking', row.value);
                    }
                    triggerRef.current?.focus();
                    onClose();
                  }}
                  className={menuRowClass(isActive)}
                >
                  <span>{row.label}</span>
                  {isActive && <Check size={MENU_ICON_SIZE} className={MENU_ROW_CHECK_CLASS} />}
                </button>
              </div>
            );
          })}

          <div aria-hidden="true" className={MENU_DIVIDER_CLASS} />
          {/* "New Activity" is both the section heading and the new:any option, styled like an
              organization header in the Repository menu, with the specific flags indented. */}
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
