import { useState } from 'react';
import {
  Filter,
  Zap,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Keyboard,
  Settings as SettingsIcon,
} from 'lucide-react';
import type { FilterControls, TriageFilter } from '../../types/filters';
import type { SidebarRepos } from '../../logic/query/facets';
import type { ParsedQuery } from '../../logic/query/syntax';
import type { SavedSearchView } from '../../logic/savedSearches';
import { SidebarRow } from './SidebarRow';
import { SavedSearchList } from '../savedSearches/SavedSearchList';

export interface DashboardSidebarProps {
  filters: FilterControls;
  hasNoSecondaryFilters: boolean;
  sidebar: SidebarRepos;
  repoInboxCounts: Record<string, number>;
  repoHasUnread: Set<string>;
  totals: { inbox: number; new: number; acked: number };
  savedSearches?: readonly SavedSearchView[];
  currentQueryText?: string;
  currentParsed?: ParsedQuery;
  onSelectSavedSearch?: (search: SavedSearchView) => void;
  onEditSavedSearch?: (search: SavedSearchView) => void;
  onRenameSavedSearch?: (id: string, name: string) => Promise<void> | void;
  onDeleteSavedSearch?: (id: string) => Promise<void> | void;
  onReorderSavedSearches?: (ids: string[]) => Promise<void> | void;
  applyWorkflowShortcut: (tab: TriageFilter) => void;
  toggleRepo: (repo: string) => void;
  showSettings: boolean;
  setShowSettings: (show: boolean) => void;
  setShowShortcutsModal: (show: boolean) => void;
}

const eqCi = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

export function DashboardSidebar({
  filters,
  hasNoSecondaryFilters,
  sidebar,
  repoInboxCounts,
  repoHasUnread,
  totals: sidebarTotals,
  savedSearches = [],
  currentQueryText = '',
  currentParsed,
  onSelectSavedSearch = () => {},
  onEditSavedSearch,
  onRenameSavedSearch,
  onDeleteSavedSearch,
  onReorderSavedSearches,
  applyWorkflowShortcut,
  toggleRepo,
  showSettings,
  setShowSettings,
  setShowShortcutsModal,
}: DashboardSidebarProps) {
  const [showHiddenRepos, setShowHiddenRepos] = useState(false);
  const { repoList, activeList, hiddenList } = sidebar;

  const isInboxActive = filters.triage === 'inbox' && hasNoSecondaryFilters;
  const isActivityActive = filters.triage === 'activity' && hasNoSecondaryFilters;
  const isAckedActive = filters.triage === 'acked' && hasNoSecondaryFilters;

  const repoBadge = (repo: string) => ({
    inboxCount: repoInboxCounts[repo.toLowerCase()] || 0,
    hasUnread: repoHasUnread.has(repo.toLowerCase()),
  });

  const isRepoSelected = (repo: string) =>
    filters.repo.some((r) => eqCi(r, repo));

  return (
    <aside className="w-64 border-r border-slate-200 dark:border-slate-800 p-4 flex flex-col gap-1 overflow-y-auto hidden md:flex shrink-0 bg-slate-50/50 dark:bg-slate-950">
      <div className="text-xs font-bold text-slate-500 dark:text-slate-500 uppercase tracking-wider mb-2 px-2">
        Workflows
      </div>

      <button
        type="button"
        onClick={() => applyWorkflowShortcut('inbox')}
        className={`flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
          isInboxActive
            ? 'bg-blue-600 text-white font-medium shadow-xs'
            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-200'
        }`}
      >
        <div className="flex items-center gap-3">
          <Filter size={16} />
          <span>Inbox</span>
        </div>
        <span
          className={`px-1.5 rounded text-xs font-mono ${
            isInboxActive
              ? 'bg-blue-700 text-white'
              : 'bg-slate-200 dark:bg-slate-800/50 text-slate-700 dark:text-slate-300'
          }`}
        >
          {sidebarTotals.inbox}
        </span>
      </button>

      <button
        type="button"
        onClick={() => applyWorkflowShortcut('activity')}
        className={`flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
          isActivityActive
            ? 'bg-blue-600 text-white font-medium shadow-xs'
            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-200'
        }`}
      >
        <div className="flex items-center gap-3">
          <Zap size={16} />
          <span>New</span>
        </div>
        <span
          className={`px-1.5 rounded text-xs font-mono ${
            isActivityActive
              ? 'bg-blue-700 text-white'
              : 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300'
          }`}
        >
          {sidebarTotals.new}
        </span>
      </button>

      <button
        type="button"
        onClick={() => applyWorkflowShortcut('acked')}
        className={`flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
          isAckedActive
            ? 'bg-blue-600 text-white font-medium shadow-xs'
            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-200'
        }`}
      >
        <div className="flex items-center gap-3">
          <CheckCircle size={16} />
          <span>Acked</span>
        </div>
        <span
          className={`px-1.5 rounded text-xs font-mono ${
            isAckedActive
              ? 'bg-blue-700 text-white'
              : 'bg-slate-200 dark:bg-slate-800/50 text-slate-700 dark:text-slate-300'
          }`}
        >
          {sidebarTotals.acked}
        </span>
      </button>

      {/* Saved Searches */}
      <SavedSearchList
        searches={savedSearches}
        currentQueryText={currentQueryText}
        currentParsed={currentParsed}
        onSelectSearch={onSelectSavedSearch}
        onEditSearch={onEditSavedSearch}
        onRename={onRenameSavedSearch}
        onDelete={onDeleteSavedSearch}
        onReorder={onReorderSavedSearches}
      />

      {/* Repositories */}
      <div className="mt-4 mb-2">
        <div className="text-xs font-bold text-slate-500 dark:text-slate-500 uppercase tracking-wider px-2 mb-2">
          Repositories
        </div>
        <div className="space-y-0.5">
          {activeList.map((repo) => {
            const { inboxCount, hasUnread } = repoBadge(repo);
            return (
              <SidebarRow
                key={repo}
                repo={repo}
                isSelected={isRepoSelected(repo)}
                inboxCount={inboxCount}
                hasUnread={hasUnread}
                onClick={() => toggleRepo(repo)}
              />
            );
          })}

          {hiddenList.length > 0 && (
            <div className="pt-1">
              <button
                type="button"
                data-testid="toggle-hidden-repos"
                onClick={() => setShowHiddenRepos(!showHiddenRepos)}
                className="w-full px-3 py-1.5 text-xs flex items-center gap-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer transition-colors"
              >
                {showHiddenRepos ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                <span>{showHiddenRepos ? 'Less' : 'More'}</span>
              </button>
              {showHiddenRepos && (
                <div className="space-y-0.5 mt-0.5" data-testid="hidden-repos-list">
                  {hiddenList.map((repo) => {
                    const { inboxCount, hasUnread } = repoBadge(repo);
                    return (
                      <SidebarRow
                        key={repo}
                        repo={repo}
                        isSelected={isRepoSelected(repo)}
                        inboxCount={inboxCount}
                        hasUnread={hasUnread}
                        onClick={() => toggleRepo(repo)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {repoList.length === 0 && (
            <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-600 italic">No repositories</div>
          )}
        </div>
      </div>

      {/* Lower Left Shortcuts & Settings Buttons */}
      <div className="mt-auto pt-3 border-t border-slate-200 dark:border-slate-800 space-y-1">
        <button
          type="button"
          onClick={() => setShowShortcutsModal(true)}
          className="w-full flex items-center justify-between px-3 py-2 rounded-md text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
          aria-label="Keyboard Shortcuts"
        >
          <div className="flex items-center gap-2.5">
            <Keyboard size={16} />
            <span>Shortcuts</span>
          </div>
          <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
            ?
          </kbd>
        </button>
        <button
          type="button"
          onClick={() => setShowSettings(!showSettings)}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
            showSettings
              ? 'bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-400 font-medium'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-white'
          }`}
          aria-label="Settings"
        >
          <SettingsIcon size={16} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
