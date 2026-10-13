import { useCallback } from 'react';
import {
  GitPullRequest,
  Disc,
  User as UserIcon,
  UserCheck,
  Tag as LabelIcon,
  type LucideIcon,
} from 'lucide-react';
import type { FilterControls } from '../../types/filters';
import { useToolbarCollapse } from '../../hooks/useToolbarCollapse';
import {
  buildAuthorMenuOptions,
  buildLabelOptions,
  type OptionList,
} from '../../logic/query/facets';
import type { SelectorFacets } from '../../hooks/useDashboardData';
import type { DashboardMenuId, MenuGroup } from '../../hooks/useMenuGroup';
import { MultiSelectMenu, type MultiSelectOption } from './MultiSelectMenu';
import { OverflowFilterMenu } from './OverflowFilterMenu';
import { RepoOrgMenu, type RepoOrgMenuData } from './RepoOrgMenu';
import { StateMenu } from './StateMenu';
import {
  MENU_ICON_SIZE,
  SEGMENTED_GROUP_CLASS,
  filterTriggerClass,
  segmentedButtonClass,
  triggerIconClass,
} from './menuStyles';

export interface FilterToolbarProps {
  filters: FilterControls;
  setFilter: <K extends keyof FilterControls>(
    key: K,
    value: FilterControls[K],
    replaceHistory?: boolean
  ) => void;
  setFilters: (partial: Partial<FilterControls>, replaceHistory?: boolean) => void;
  setOrgOrRepo: (kind: 'org' | 'repo', values: readonly string[], replaceHistory?: boolean) => void;
  toggleAssignedToMe: (replaceHistory?: boolean) => void;
  currentUser: string | null;
  facets: SelectorFacets;
  pinnedRepos: readonly string[];
  menus: MenuGroup<DashboardMenuId>;
}

const TYPE_SEGMENTS: readonly {
  readonly value: FilterControls['type'];
  readonly label: string;
  readonly Icon?: LucideIcon;
}[] = [
  { value: 'all', label: 'All' },
  { value: 'pr', label: 'PRs', Icon: GitPullRequest },
  { value: 'issue', label: 'Issues', Icon: Disc },
];

/**
 * What the toolbar gives up, in order, when its row is too narrow (collapse level n applies the
 * first n steps): first the Repository selector moves into the overflow "..." menu, then the
 * "Assigned to me" shortcut is dropped (Assignee in the overflow menu covers it).
 */
const TOOLBAR_COLLAPSE_LEVELS = ['repository', 'assignedToMe'] as const;

const hasCi = (list: readonly string[], value: string | null | undefined) =>
  Boolean(value && list.some((item) => item.toLowerCase() === value.toLowerCase()));

export function FilterToolbar({
  filters,
  setFilter,
  setFilters,
  setOrgOrRepo,
  toggleAssignedToMe,
  currentUser,
  facets,
  pinnedRepos,
  menus,
}: FilterToolbarProps) {
  const buildAuthorOptionsForMenu = useCallback(
    (showAll: boolean): OptionList<MultiSelectOption> =>
      buildAuthorMenuOptions(facets.authors, filters.author, currentUser, showAll),
    [facets.authors, filters.author, currentUser]
  );

  const buildLabelMenuOptions = useCallback(
    (showAll: boolean): OptionList<MultiSelectOption> =>
      buildLabelOptions(facets.labels, filters.label, showAll),
    [facets.labels, filters.label]
  );

  const isAssignedToMe = hasCi(filters.assignee, '@me');

  const { ref: rowRef, level: collapseLevel } = useToolbarCollapse<HTMLDivElement>(
    TOOLBAR_COLLAPSE_LEVELS.length
  );
  const collapseRepository = collapseLevel > TOOLBAR_COLLAPSE_LEVELS.indexOf('repository');
  const hideAssignedToMe = collapseLevel > TOOLBAR_COLLAPSE_LEVELS.indexOf('assignedToMe');

  const repository: RepoOrgMenuData = {
    selectedOrgs: filters.org,
    selectedRepos: filters.repo,
    repoFacets: facets.repos,
    orgFacets: facets.orgs,
    pinnedRepos,
    setOrgOrRepo,
    setFilters,
  };

  return (
    // Never wraps: when the row is too narrow, controls collapse instead (see TOOLBAR_COLLAPSE_LEVELS).
    <div ref={rowRef} className="flex items-center justify-between gap-4 text-xs">
      {/* Left-aligned: PRs / Issues Type Slider (Segmented Control) */}
      <div className={SEGMENTED_GROUP_CLASS} role="group" aria-label="Filter item type">
        {TYPE_SEGMENTS.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter('type', value)}
            aria-pressed={filters.type === value}
            className={segmentedButtonClass(filters.type === value)}
          >
            {Icon && <Icon size={12} className="shrink-0" />}
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Right-aligned: Dropdown Menus for State (+ Activity), Repo, Author, Label, Assigned-to-me, and More (...) */}
      <div className="flex items-center gap-2">
        <StateMenu
          state={filters.state}
          tracking={filters.tracking}
          triage={filters.triage}
          activity={filters.activity}
          activityFacets={facets.activity}
          open={menus.isOpen('state')}
          onToggle={() => menus.toggle('state')}
          onClose={() => menus.close()}
          menuRef={menus.refFor('state')}
          setFilter={setFilter}
        />

        {!collapseRepository && (
          <RepoOrgMenu
            {...repository}
            open={menus.isOpen('repo')}
            onToggle={() => menus.toggle('repo')}
            onClose={() => menus.close()}
            menuRef={menus.refFor('repo')}
          />
        )}

        <MultiSelectMenu
          label="Author"
          ariaLabel="Filter by author"
          icon={UserIcon}
          open={menus.isOpen('author')}
          onToggle={() => menus.toggle('author')}
          onClose={() => menus.close()}
          menuRef={menus.refFor('author')}
          selected={filters.author}
          onChange={(next) => setFilter('author', next)}
          buildOptions={buildAuthorOptionsForMenu}
          valuePrefix="@"
          filterPlaceholder="Filter authors…"
          emptyMessage="No authors found"
        />

        <MultiSelectMenu
          label="Label"
          ariaLabel="Filter by label"
          icon={LabelIcon}
          open={menus.isOpen('label')}
          onToggle={() => menus.toggle('label')}
          onClose={() => menus.close()}
          menuRef={menus.refFor('label')}
          selected={filters.label}
          onChange={(next) => setFilter('label', next)}
          buildOptions={buildLabelMenuOptions}
          filterPlaceholder="Filter labels…"
          emptyMessage="No labels found"
        />

        {/* Assigned to me toggle (dropped on very narrow rows; Assignee in the overflow menu covers it) */}
        {!hideAssignedToMe && (
          <button
            type="button"
            onClick={() => toggleAssignedToMe()}
            aria-pressed={isAssignedToMe}
            className={filterTriggerClass(isAssignedToMe)}
            title={currentUser ? `Assigned to @${currentUser}` : 'Assigned to me'}
          >
            <UserCheck size={MENU_ICON_SIZE} className={triggerIconClass(isAssignedToMe)} />
            <span>Assigned to me</span>
          </button>
        )}

        <OverflowFilterMenu
          assignee={filters.assignee}
          milestone={filters.milestone}
          assigneeFacets={facets.assignees}
          milestoneFacets={facets.milestones}
          currentUser={currentUser}
          menus={menus}
          setFilter={setFilter}
          repository={collapseRepository ? repository : undefined}
        />
      </div>
    </div>
  );
}
