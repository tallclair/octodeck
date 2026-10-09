import { useMemo } from 'react';
import {
  CircleDot,
  GitPullRequest,
  Disc,
  FolderGit,
  User as UserIcon,
  UserCheck,
  ChevronDown,
  Check,
  Milestone as MilestoneIcon,
  Tag as LabelIcon,
} from 'lucide-react';
import type { FilterControls } from '../../types/filters';
import type { LabelOption, OptionList, RepoDropdown } from '../../logic/query/facets';
import type { DashboardMenuId, MenuGroup } from '../../hooks/useMenuGroup';

export interface FilterToolbarProps {
  filters: FilterControls;
  setFilter: <K extends keyof FilterControls>(
    key: K,
    value: FilterControls[K],
    replaceHistory?: boolean
  ) => void;
  setFilters: (partial: Partial<FilterControls>, replaceHistory?: boolean) => void;
  currentUser: string | null;
  options: {
    repos: RepoDropdown;
    authors: OptionList<string>;
    milestones: OptionList<string>;
    labels: OptionList<LabelOption>;
  };
  showAll: { repos: boolean; authors: boolean; milestones: boolean; labels: boolean };
  setShowAll: {
    repos: (v: boolean) => void;
    authors: (v: boolean) => void;
    milestones: (v: boolean) => void;
    labels: (v: boolean) => void;
  };
  menus: MenuGroup<DashboardMenuId>;
}

const eqCi = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

export function FilterToolbar({
  filters,
  setFilter,
  setFilters,
  currentUser,
  options,
  showAll,
  setShowAll,
  menus,
}: FilterToolbarProps) {
  const { list: currentAuthorsList, hasMore: hasMoreAuthors } = options.authors;

  const authorDropdownList = useMemo(() => {
    const isCurrentUser = (a: string) =>
      Boolean(currentUser) && a.toLowerCase() === currentUser?.toLowerCase();
    const listedCurrentUser = currentAuthorsList.find(isCurrentUser) ?? null;
    const otherAuthors = currentAuthorsList.filter((a) => !isCurrentUser(a));
    return {
      currentUser: listedCurrentUser,
      otherAuthors,
    };
  }, [currentAuthorsList, currentUser]);

  const { list: currentMilestonesList, hasMore: hasMoreMilestones } = options.milestones;
  const { list: currentLabelsList, hasMore: hasMoreLabels } = options.labels;
  const { orgs: dropdownOrgs, reposByOrg: dropdownReposByOrg, hasMore: hasMoreRepos } = options.repos;

  const handleOrgRepoChange = (value: string) => {
    if (!value) {
      setFilters({ org: null, repo: null });
    } else if (value.startsWith('org:')) {
      setFilters({ org: value.slice(4), repo: null });
    } else if (value.startsWith('repo:')) {
      setFilters({ repo: value.slice(5), org: null });
    }
  };

  const stateMenuOpen = menus.isOpen('state');
  const repoMenuOpen = menus.isOpen('repo');
  const authorMenuOpen = menus.isOpen('author');
  const milestoneMenuOpen = menus.isOpen('milestone');
  const labelMenuOpen = menus.isOpen('label');

  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      {/* Left-aligned: PRs / Issues Type Slider (Segmented Control) */}
      <div
        className="flex bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-0.5 shadow-xs"
        role="group"
        aria-label="Filter item type"
      >
        <button
          type="button"
          onClick={() => setFilter('type', 'all')}
          className={`px-2.5 py-0.5 text-xs font-medium rounded transition-colors cursor-pointer flex items-center ${
            filters.type === 'all'
              ? 'bg-white dark:bg-blue-600 text-slate-900 dark:text-white shadow-xs font-semibold'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => setFilter('type', 'pr')}
          className={`px-2.5 py-0.5 text-xs font-medium rounded transition-colors cursor-pointer flex items-center gap-1.5 ${
            filters.type === 'pr'
              ? 'bg-white dark:bg-blue-600 text-slate-900 dark:text-white shadow-xs font-semibold'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <GitPullRequest size={12} />
          <span>PRs</span>
        </button>
        <button
          type="button"
          onClick={() => setFilter('type', 'issue')}
          className={`px-2.5 py-0.5 text-xs font-medium rounded transition-colors cursor-pointer flex items-center gap-1.5 ${
            filters.type === 'issue'
              ? 'bg-white dark:bg-blue-600 text-slate-900 dark:text-white shadow-xs font-semibold'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Disc size={12} />
          <span>Issues</span>
        </button>
      </div>

      {/* Right-aligned: Custom Dropdown Menus for State, Repo, Author, Milestone, Label, and Assigned-to-me */}
      <div className="flex items-center gap-2">
        {/* Custom State Dropdown */}
        <div className="relative" ref={menus.refFor('state')}>
          <button
            type="button"
            onClick={() => menus.toggle('state')}
            aria-label="Filter by state"
            aria-haspopup="true"
            aria-expanded={stateMenuOpen}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-white py-1 px-2.5 transition-colors text-xs cursor-pointer select-none shadow-xs"
          >
            <CircleDot size={13} className="text-slate-400 dark:text-slate-500" />
            <span>State</span>
            <ChevronDown
              size={12}
              className={`text-slate-400 dark:text-slate-500 transition-transform duration-150 ${
                stateMenuOpen ? 'rotate-180 text-blue-600 dark:text-blue-400' : ''
              }`}
            />
          </button>

          {stateMenuOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-44 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
              <button
                type="button"
                onClick={() => {
                  setFilter('state', 'open');
                  menus.close();
                }}
                className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                  filters.state === 'open'
                    ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <span>Open</span>
                {filters.state === 'open' && <Check size={13} className="text-blue-600 dark:text-blue-400" />}
              </button>

              <button
                type="button"
                onClick={() => {
                  setFilter('state', 'closed');
                  menus.close();
                }}
                className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                  filters.state === 'closed'
                    ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <span>Closed</span>
                {filters.state === 'closed' && <Check size={13} className="text-blue-600 dark:text-blue-400" />}
              </button>

              <div className="border-t border-slate-200 dark:border-slate-800 my-1" />

              <button
                type="button"
                onClick={() => {
                  setFilter('tracking', 'tracked');
                  menus.close();
                }}
                className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                  filters.tracking === 'tracked'
                    ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <span>Tracked</span>
                {filters.tracking === 'tracked' && <Check size={13} className="text-blue-600 dark:text-blue-400" />}
              </button>

              <button
                type="button"
                onClick={() => {
                  setFilter('tracking', 'untracked');
                  menus.close();
                }}
                className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                  filters.tracking === 'untracked'
                    ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <span>Untracked</span>
                {filters.tracking === 'untracked' && <Check size={13} className="text-blue-600 dark:text-blue-400" />}
              </button>
            </div>
          )}
        </div>

        {/* Custom Repository Dropdown */}
        <div className="relative" ref={menus.refFor('repo')}>
          <button
            type="button"
            onClick={() => menus.toggle('repo')}
            aria-label="Filter by repository"
            aria-haspopup="true"
            aria-expanded={repoMenuOpen}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-white py-1 px-2.5 transition-colors text-xs cursor-pointer select-none shadow-xs"
          >
            <FolderGit size={13} className="text-slate-400 dark:text-slate-500" />
            <span>Repository</span>
            <ChevronDown
              size={12}
              className={`text-slate-400 dark:text-slate-500 transition-transform duration-150 ${
                repoMenuOpen ? 'rotate-180 text-blue-600 dark:text-blue-400' : ''
              }`}
            />
          </button>

          {repoMenuOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-56 max-h-60 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
              {dropdownOrgs.map((org) => (
                <div key={org} className="py-1">
                  <button
                    type="button"
                    onClick={() => {
                      handleOrgRepoChange(`org:${org}`);
                      menus.close();
                    }}
                    className={`w-full px-3 py-1.5 text-xs text-left font-bold uppercase tracking-wider flex items-center justify-between transition-colors cursor-pointer ${
                      eqCi(filters.org, org) && !filters.repo
                        ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                        : 'text-slate-500 dark:text-slate-400 bg-slate-100/50 dark:bg-slate-950/40 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    <span className="truncate">{org}</span>
                    {eqCi(filters.org, org) && !filters.repo && (
                      <Check size={13} className="text-blue-600 dark:text-blue-400" />
                    )}
                  </button>
                  {(dropdownReposByOrg[org] || []).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => {
                        handleOrgRepoChange(`repo:${r}`);
                        menus.close();
                      }}
                      className={`w-full pl-6 pr-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                        eqCi(filters.repo, r)
                          ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      <span className="truncate">{r}</span>
                      {eqCi(filters.repo, r) && <Check size={13} className="text-blue-600 dark:text-blue-400" />}
                    </button>
                  ))}
                </div>
              ))}
              {dropdownOrgs.length === 0 && (
                <div className="px-3 py-2 text-xs text-slate-500 italic">No repositories found</div>
              )}
              {!showAll.repos && hasMoreRepos && (
                <>
                  <div className="border-t border-slate-200 dark:border-slate-800 my-1" />
                  <button
                    type="button"
                    onClick={() => setShowAll.repos(true)}
                    className="w-full px-3 py-1.5 text-xs flex items-center justify-center text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors cursor-pointer font-medium"
                  >
                    Show all
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Custom Author Dropdown */}
        <div className="relative" ref={menus.refFor('author')}>
          <button
            type="button"
            onClick={() => menus.toggle('author')}
            aria-label="Filter by author"
            aria-haspopup="true"
            aria-expanded={authorMenuOpen}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-white py-1 px-2.5 transition-colors text-xs cursor-pointer select-none shadow-xs"
          >
            <UserIcon size={13} className="text-slate-400 dark:text-slate-500" />
            <span>Author</span>
            <ChevronDown
              size={12}
              className={`text-slate-400 dark:text-slate-500 transition-transform duration-150 ${
                authorMenuOpen ? 'rotate-180 text-blue-600 dark:text-blue-400' : ''
              }`}
            />
          </button>

          {authorMenuOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-48 max-h-60 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
              {authorDropdownList.currentUser && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setFilter('author', authorDropdownList.currentUser);
                      menus.close();
                    }}
                    className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                      eqCi(filters.author, authorDropdownList.currentUser)
                        ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    <span className="truncate font-medium">@{authorDropdownList.currentUser} (you)</span>
                    {eqCi(filters.author, authorDropdownList.currentUser) && (
                      <Check size={13} className="text-blue-600 dark:text-blue-400" />
                    )}
                  </button>
                  {authorDropdownList.otherAuthors.length > 0 && (
                    <div className="border-t border-slate-200 dark:border-slate-800 my-1" />
                  )}
                </>
              )}
              {authorDropdownList.otherAuthors.map((author) => (
                <button
                  key={author}
                  type="button"
                  onClick={() => {
                    setFilter('author', author);
                    menus.close();
                  }}
                  className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                    eqCi(filters.author, author)
                      ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <span className="truncate">@{author}</span>
                  {eqCi(filters.author, author) && <Check size={13} className="text-blue-600 dark:text-blue-400" />}
                </button>
              ))}
              {!authorDropdownList.currentUser && authorDropdownList.otherAuthors.length === 0 && (
                <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500 italic">No authors found</div>
              )}
              {!showAll.authors && hasMoreAuthors && (
                <>
                  <div className="border-t border-slate-200 dark:border-slate-800 my-1" />
                  <button
                    type="button"
                    onClick={() => setShowAll.authors(true)}
                    className="w-full px-3 py-1.5 text-xs flex items-center justify-center text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors cursor-pointer font-medium"
                  >
                    Show all
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Custom Milestone Dropdown */}
        <div className="relative" ref={menus.refFor('milestone')}>
          <button
            type="button"
            onClick={() => menus.toggle('milestone')}
            aria-label="Filter by milestone"
            aria-haspopup="true"
            aria-expanded={milestoneMenuOpen}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-white py-1 px-2.5 transition-colors text-xs cursor-pointer select-none shadow-xs"
          >
            <MilestoneIcon size={13} className="text-slate-400 dark:text-slate-500" />
            <span>Milestone</span>
            <ChevronDown
              size={12}
              className={`text-slate-400 dark:text-slate-500 transition-transform duration-150 ${
                milestoneMenuOpen ? 'rotate-180 text-blue-600 dark:text-blue-400' : ''
              }`}
            />
          </button>

          {milestoneMenuOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-48 max-h-60 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
              {currentMilestonesList.map((milestone) => (
                <button
                  key={milestone}
                  type="button"
                  onClick={() => {
                    setFilter('milestone', milestone);
                    menus.close();
                  }}
                  className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                    eqCi(filters.milestone, milestone)
                      ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <span className="truncate">{milestone}</span>
                  {eqCi(filters.milestone, milestone) && (
                    <Check size={13} className="text-blue-600 dark:text-blue-400" />
                  )}
                </button>
              ))}
              {currentMilestonesList.length === 0 && (
                <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500 italic">No milestones found</div>
              )}
              {!showAll.milestones && hasMoreMilestones && (
                <>
                  <div className="border-t border-slate-200 dark:border-slate-800 my-1" />
                  <button
                    type="button"
                    onClick={() => setShowAll.milestones(true)}
                    className="w-full px-3 py-1.5 text-xs flex items-center justify-center text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors cursor-pointer font-medium"
                  >
                    Show all
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Custom Label Dropdown */}
        <div className="relative" ref={menus.refFor('label')}>
          <button
            type="button"
            onClick={() => menus.toggle('label')}
            aria-label="Filter by label"
            aria-haspopup="true"
            aria-expanded={labelMenuOpen}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-white py-1 px-2.5 transition-colors text-xs cursor-pointer select-none shadow-xs"
          >
            <LabelIcon size={13} className="text-slate-400 dark:text-slate-500" />
            <span>Label</span>
            <ChevronDown
              size={12}
              className={`text-slate-400 dark:text-slate-500 transition-transform duration-150 ${
                labelMenuOpen ? 'rotate-180 text-blue-600 dark:text-blue-400' : ''
              }`}
            />
          </button>

          {labelMenuOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-52 max-h-60 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
              {currentLabelsList.map((lbl) => (
                <button
                  key={lbl.name}
                  type="button"
                  onClick={() => {
                    setFilter('label', lbl.name || null);
                    menus.close();
                  }}
                  className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                    filters.label?.toLowerCase() === lbl.name?.toLowerCase()
                      ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <span
                      className="w-2 h-2 rounded-full shrink-0 border border-slate-300 dark:border-slate-700"
                      style={{ backgroundColor: lbl.color ? `#${lbl.color.replace(/^#/, '')}` : '#888' }}
                    />
                    <span className="truncate">{lbl.name}</span>
                  </span>
                  {filters.label?.toLowerCase() === lbl.name?.toLowerCase() && (
                    <Check size={13} className="text-blue-600 dark:text-blue-400 shrink-0 ml-1" />
                  )}
                </button>
              ))}
              {currentLabelsList.length === 0 && (
                <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500 italic">No labels found</div>
              )}
              {!showAll.labels && hasMoreLabels && (
                <>
                  <div className="border-t border-slate-200 dark:border-slate-800 my-1" />
                  <button
                    type="button"
                    onClick={() => setShowAll.labels(true)}
                    className="w-full px-3 py-1.5 text-xs flex items-center justify-center text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors cursor-pointer font-medium"
                  >
                    Show all
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Assigned to me toggle */}
        <button
          type="button"
          onClick={() => setFilter('assigned', filters.assigned === 'me' ? 'all' : 'me')}
          className={`inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md border text-xs font-medium transition-colors cursor-pointer shadow-xs ${
            filters.assigned === 'me'
              ? 'bg-blue-50 dark:bg-blue-950/80 border-blue-300 dark:border-blue-500/80 text-blue-700 dark:text-blue-200'
              : 'bg-white dark:bg-slate-900/80 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
          title={currentUser ? `Assigned to @${currentUser}` : 'Assigned to me'}
        >
          <UserCheck
            size={13}
            className={
              filters.assigned === 'me' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400 dark:text-slate-500'
            }
          />
          <span>Assigned to me</span>
        </button>
      </div>
    </div>
  );
}
