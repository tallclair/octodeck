import { useCallback, type Ref, type RefObject } from 'react';
import { FolderGit } from 'lucide-react';
import type { FacetValue } from '../../api/octodeck/v1/query_pb';
import type { FilterControls } from '../../types/filters';
import { buildRepoMenuOptions, type OptionList } from '../../logic/query/facets';
import { MultiSelectMenu, type MultiSelectOption } from './MultiSelectMenu';
import { MENU_PANEL_FLYOUT_LEFT } from './menuStyles';

/** Data and setters the Repository menu needs, independent of where it is rendered. */
export interface RepoOrgMenuData {
  readonly selectedOrgs: readonly string[];
  readonly selectedRepos: readonly string[];
  readonly repoFacets: readonly FacetValue[];
  readonly orgFacets: readonly FacetValue[];
  readonly pinnedRepos: readonly string[];
  readonly setOrgOrRepo: (
    kind: 'org' | 'repo',
    values: readonly string[],
    replaceHistory?: boolean
  ) => void;
  readonly setFilters: (
    partial: Partial<FilterControls>,
    replaceHistory?: boolean
  ) => void;
}

export interface RepoOrgMenuProps extends RepoOrgMenuData {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly menuRef?: Ref<HTMLDivElement>;
  /**
   * When set, the menu renders only its panel, as a flyout to the left of a parent menu (the
   * overflow "..." menu), and returns focus to this trigger on Escape/Tab.
   */
  readonly flyoutTriggerRef?: RefObject<HTMLButtonElement | null>;
}

const eqCi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hasCi = (list: readonly string[], target: string) => list.some((item) => eqCi(item, target));

export function RepoOrgMenu({
  selectedOrgs,
  selectedRepos,
  repoFacets,
  orgFacets,
  pinnedRepos,
  open,
  onToggle,
  onClose,
  menuRef,
  setOrgOrRepo,
  setFilters,
  flyoutTriggerRef,
}: RepoOrgMenuProps) {
  const buildOptions = useCallback(
    (showAll: boolean): OptionList<MultiSelectOption> =>
      buildRepoMenuOptions(
        repoFacets,
        orgFacets,
        { repos: selectedRepos, orgs: selectedOrgs },
        pinnedRepos,
        showAll
      ),
    [repoFacets, orgFacets, selectedRepos, selectedOrgs, pinnedRepos]
  );

  const isOptionSelected = useCallback(
    (option: MultiSelectOption) =>
      option.isGroupHeader
        ? hasCi(selectedOrgs, option.value)
        : hasCi(selectedRepos, option.value),
    [selectedOrgs, selectedRepos]
  );

  const handleToggleOption = useCallback(
    (option: MultiSelectOption, currentlySelected: boolean) => {
      if (option.isGroupHeader) {
        const next = currentlySelected
          ? selectedOrgs.filter((o) => !eqCi(o, option.value))
          : [...selectedOrgs, option.value];
        setOrgOrRepo('org', next);
        return;
      }
      const next = currentlySelected
        ? selectedRepos.filter((r) => !eqCi(r, option.value))
        : [...selectedRepos, option.value];
      setOrgOrRepo('repo', next);
    },
    [selectedOrgs, selectedRepos, setOrgOrRepo]
  );

  const modeHint =
    selectedOrgs.length > 0
      ? 'Selecting a repository clears organizations'
      : selectedRepos.length > 0
        ? 'Selecting an organization clears repositories'
        : null;

  return (
    <MultiSelectMenu
      label="Repository"
      ariaLabel="Filter by repository"
      icon={FolderGit}
      open={open}
      onToggle={onToggle}
      onClose={onClose}
      menuRef={menuRef}
      hideTrigger={flyoutTriggerRef !== undefined}
      externalTriggerRef={flyoutTriggerRef}
      panelPositionClassName={flyoutTriggerRef ? MENU_PANEL_FLYOUT_LEFT : undefined}
      selected={[...selectedOrgs, ...selectedRepos]}
      onChange={() => setFilters({ org: [], repo: [] })}
      buildOptions={buildOptions}
      sortOptions={false}
      isOptionSelected={isOptionSelected}
      onToggleOption={handleToggleOption}
      filterPlaceholder="Filter repositories…"
      emptyMessage="No repositories found"
      headerSlot={
        modeHint ? (
          <div className="px-3 py-1 text-[11px] text-slate-500 dark:text-slate-400 bg-slate-50/30 dark:bg-slate-900/30 border-b border-slate-100 dark:border-slate-800/60 shrink-0">
            {modeHint}
          </div>
        ) : undefined
      }
    />
  );
}
