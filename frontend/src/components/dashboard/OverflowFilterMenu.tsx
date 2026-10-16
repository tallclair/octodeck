import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import {
  Activity as ActivityIcon,
  ChevronRight,
  FolderGit,
  Milestone as MilestoneIcon,
  MoreVertical,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { FacetValue } from '../../api/octodeck/v1/query_pb';
import type { DashboardMenuId, MenuGroup } from '../../hooks/useMenuGroup';
import {
  buildAssigneeMenuOptions,
  buildOptions,
  isAssigneeOptionSelected,
  toggleAssigneeOption,
  type OptionList,
} from '../../logic/query/facets';
import { MENU_ITEM_PROPS, useMenuPanelKeyboard } from '../../hooks/useMenuPanelKeyboard';
import type { ControlKey, FilterControls } from '../../types/filters';
import { ActivityMenu, type ActivityMenuData } from './ActivityMenu';
import { MultiSelectMenu, type MultiSelectOption } from './MultiSelectMenu';
import { RepoOrgMenu, type RepoOrgMenuData } from './RepoOrgMenu';
import {
  MENU_ICON_SIZE,
  MENU_PANEL_BELOW_RIGHT,
  MENU_PANEL_CLASS,
  MENU_PANEL_FLYOUT_LEFT,
  iconTriggerClass,
  menuRowClass,
  triggerIconClass,
} from './menuStyles';

export interface OverflowFilterMenuProps {
  readonly assignee: FilterControls['assignee'];
  readonly milestone: FilterControls['milestone'];
  readonly assigneeFacets: readonly FacetValue[];
  readonly milestoneFacets: readonly FacetValue[];
  readonly currentUser: string | null;
  readonly menus: MenuGroup<DashboardMenuId>;
  readonly setFilter: <K extends ControlKey>(
    key: K,
    value: FilterControls[K]
  ) => void;
  /**
   * Set when the toolbar is too narrow for the Repository selector: the menu then gets a
   * Repository row that opens the Repository menu as a flyout (menu id 'repo').
   */
  readonly repository?: RepoOrgMenuData;
  /**
   * Set when the toolbar is too narrow for the Activity selector: the menu then gets an
   * Activity row that opens the Activity menu as a flyout (menu id 'activity').
   */
  readonly activity?: ActivityMenuData;
}

type SubmenuId = 'assignee' | 'milestone' | 'repo' | 'activity';

interface SubmenuRow {
  readonly id: SubmenuId;
  readonly label: string;
  readonly ariaLabel: string;
  readonly Icon: LucideIcon;
  readonly active: boolean;
}

const HOVER_SWITCH_DELAY_MS = 100;

export function OverflowFilterMenu({
  assignee,
  milestone,
  assigneeFacets,
  milestoneFacets,
  currentUser,
  menus,
  setFilter,
  repository,
  activity,
}: OverflowFilterMenuProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const hoverTimeoutRef = useRef<number | null>(null);
  const hasRepository = repository !== undefined;
  const hasActivity = activity !== undefined;

  const clearHoverTimeout = useCallback(() => {
    if (hoverTimeoutRef.current !== null) {
      window.clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => clearHoverTimeout, [clearHoverTimeout]);

  // Every menu id this component owns points at its container, so useMenuGroup's outside-click
  // check treats the parent panel and its flyouts as one menu. 'repo' and 'activity' are owned
  // only while collapsed into this menu.
  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      const owned: DashboardMenuId[] = ['more', 'assignee', 'milestone'];
      if (hasRepository) owned.push('repo');
      if (hasActivity) owned.push('activity');
      for (const id of owned) {
        menus.refFor(id).current = node;
      }
    },
    [menus, hasRepository, hasActivity]
  );

  const openSubmenuImmediate = useCallback(
    (target: SubmenuId) => {
      clearHoverTimeout();
      menus.openMenu(target);
    },
    [clearHoverTimeout, menus]
  );

  const handleRowMouseEnter = useCallback(
    (target: SubmenuId) => {
      clearHoverTimeout();
      if (menus.isOpen(target)) {
        return;
      }
      if (menus.isOpen('more')) {
        menus.openMenu(target);
        return;
      }
      hoverTimeoutRef.current = window.setTimeout(() => {
        hoverTimeoutRef.current = null;
        menus.openMenu(target);
      }, HOVER_SWITCH_DELAY_MS);
    },
    [clearHoverTimeout, menus]
  );

  const handleRowKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, target: SubmenuId) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        openSubmenuImmediate(target);
      }
    },
    [openSubmenuImmediate]
  );

  const buildAssigneeOptionsForMenu = useCallback(
    (showAll: boolean): OptionList<MultiSelectOption> =>
      buildAssigneeMenuOptions(assigneeFacets, assignee, currentUser, showAll),
    [assigneeFacets, assignee, currentUser]
  );

  const checkAssigneeOptionSelected = useCallback(
    (option: MultiSelectOption, selected: readonly string[]) =>
      isAssigneeOptionSelected(option, selected, currentUser),
    [currentUser]
  );

  const handleToggleAssigneeOption = useCallback(
    (option: MultiSelectOption, currentlySelected: boolean) => {
      setFilter(
        'assignee',
        toggleAssigneeOption(option, currentlySelected, assignee, currentUser)
      );
    },
    [assignee, currentUser, setFilter]
  );

  const buildMilestoneMenuOptions = useCallback(
    (showAll: boolean): OptionList<MultiSelectOption> =>
      buildOptions(milestoneFacets, milestone, showAll),
    [milestoneFacets, milestone]
  );

  const hasRepoSelection =
    repository !== undefined &&
    (repository.selectedOrgs.length > 0 || repository.selectedRepos.length > 0);

  const hasActivitySelection =
    activity !== undefined &&
    (activity.tracking !== 'all' ||
      (activity.triage !== 'activity' && activity.activity.length > 0));

  const rows: readonly SubmenuRow[] = [
    ...(hasRepository
      ? [
          {
            id: 'repo',
            label: 'Repository',
            ariaLabel: 'Filter by repository',
            Icon: FolderGit,
            active: hasRepoSelection,
          } as const,
        ]
      : []),
    ...(hasActivity
      ? [
          {
            id: 'activity',
            label: 'Activity',
            ariaLabel: 'Filter by activity',
            Icon: ActivityIcon,
            active: hasActivitySelection,
          } as const,
        ]
      : []),
    {
      id: 'assignee',
      label: 'Assignee',
      ariaLabel: 'Filter by assignee',
      Icon: Users,
      active: assignee.length > 0,
    },
    {
      id: 'milestone',
      label: 'Milestone',
      ariaLabel: 'Filter by milestone',
      Icon: MilestoneIcon,
      active: milestone.length > 0,
    },
  ];

  const isMoreOpen = menus.isOpen('more');
  const isAssigneeOpen = menus.isOpen('assignee');
  const isMilestoneOpen = menus.isOpen('milestone');
  const isRepoOpen = hasRepository && menus.isOpen('repo');
  const isActivityOpen = hasActivity && menus.isOpen('activity');
  const isAnyOpen =
    isMoreOpen || isAssigneeOpen || isMilestoneOpen || isRepoOpen || isActivityOpen;
  const hasSelection = rows.some((row) => row.active);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeMenus = useCallback(() => menus.close(), [menus]);
  // Only the bare parent menu takes focus on open; when a flyout opens (directly or from a row)
  // its MultiSelectMenu focuses its own filter input.
  const handlePanelKeyDown = useMenuPanelKeyboard({
    open: isMoreOpen,
    panelRef,
    triggerRef,
    onClose: closeMenus,
  });

  return (
    <div className="relative" ref={setContainerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          clearHoverTimeout();
          if (isAnyOpen) {
            menus.close();
          } else {
            menus.openMenu('more');
          }
        }}
        aria-label="More filters"
        aria-haspopup="dialog"
        aria-expanded={isAnyOpen}
        title={`More filters (${rows.map((row) => row.label).join(', ')})`}
        className={iconTriggerClass(hasSelection, isAnyOpen)}
      >
        <MoreVertical size={MENU_ICON_SIZE} className={triggerIconClass(hasSelection)} />
      </button>

      {isAnyOpen && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="More filters"
          tabIndex={-1}
          onKeyDown={handlePanelKeyDown}
          className={`${MENU_PANEL_CLASS} ${MENU_PANEL_BELOW_RIGHT} w-48 py-1`}
        >
          {rows.map(({ id, label, ariaLabel, Icon, active }) => (
            <button
              {...MENU_ITEM_PROPS}
              key={id}
              type="button"
              tabIndex={-1}
              aria-label={ariaLabel}
              aria-haspopup="listbox"
              aria-expanded={menus.isOpen(id)}
              onClick={() => openSubmenuImmediate(id)}
              onMouseEnter={() => handleRowMouseEnter(id)}
              onMouseLeave={clearHoverTimeout}
              onKeyDown={(e) => handleRowKeyDown(e, id)}
              className={menuRowClass(active, menus.isOpen(id))}
            >
              <span className="flex items-center gap-2">
                <Icon size={MENU_ICON_SIZE} className={triggerIconClass(active)} />
                <span>{label}</span>
              </span>
              <ChevronRight
                size={MENU_ICON_SIZE}
                className="shrink-0 text-slate-400 dark:text-slate-500"
              />
            </button>
          ))}

          {isRepoOpen && repository && (
            <RepoOrgMenu
              {...repository}
              open={true}
              onToggle={closeMenus}
              onClose={closeMenus}
              flyoutTriggerRef={triggerRef}
            />
          )}

          {isActivityOpen && activity && (
            <ActivityMenu
              {...activity}
              open={true}
              onToggle={closeMenus}
              onClose={closeMenus}
              hideTrigger={true}
              externalTriggerRef={triggerRef}
              panelPositionClassName={MENU_PANEL_FLYOUT_LEFT}
            />
          )}

          {isAssigneeOpen && (
            <MultiSelectMenu
              label="Assignee"
              ariaLabel="Filter by assignee"
              icon={Users}
              open={true}
              onToggle={closeMenus}
              onClose={closeMenus}
              hideTrigger={true}
              externalTriggerRef={triggerRef}
              panelPositionClassName={MENU_PANEL_FLYOUT_LEFT}
              selected={assignee}
              onChange={(next) => setFilter('assignee', next)}
              buildOptions={buildAssigneeOptionsForMenu}
              isOptionSelected={checkAssigneeOptionSelected}
              onToggleOption={handleToggleAssigneeOption}
              valuePrefix="@"
              filterPlaceholder="Filter assignees…"
              emptyMessage="No assignees found"
            />
          )}

          {isMilestoneOpen && (
            <MultiSelectMenu
              label="Milestone"
              ariaLabel="Filter by milestone"
              icon={MilestoneIcon}
              open={true}
              onToggle={closeMenus}
              onClose={closeMenus}
              hideTrigger={true}
              externalTriggerRef={triggerRef}
              panelPositionClassName={MENU_PANEL_FLYOUT_LEFT}
              selected={milestone}
              onChange={(next) => setFilter('milestone', next)}
              buildOptions={buildMilestoneMenuOptions}
              filterPlaceholder="Filter milestones…"
              emptyMessage="No milestones found"
            />
          )}
        </div>
      )}
    </div>
  );
}
