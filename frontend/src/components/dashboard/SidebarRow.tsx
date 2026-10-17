import { AlertTriangle } from 'lucide-react';
import { resolveSavedSearchBadge, type BadgeScope } from '../../logic/savedSearches';

export interface SidebarRowProps {
  label?: string;
  repo?: string;
  isSelected: boolean;
  scope?: BadgeScope;
  count?: number | null;
  inboxCount?: number;
  newCount?: number;
  hasUnread?: boolean;
  error?: string | null;
  testId?: string;
  badgeTestId?: string;
  onClick: () => void;
}

export type SidebarRepoRowProps = SidebarRowProps;

export function SidebarRow({
  label,
  repo,
  isSelected,
  scope,
  count,
  inboxCount,
  newCount,
  hasUnread = false,
  error = null,
  testId,
  badgeTestId,
  onClick,
}: SidebarRowProps) {
  const displayLabel = label ?? repo ?? '';
  const resolvedScope: BadgeScope = scope ?? 'inbox';
  const resolvedCount = count !== undefined ? count : (inboxCount ?? null);
  const resolvedNewCount = newCount !== undefined ? newCount : hasUnread ? 1 : 0;
  const resolvedInboxCount = inboxCount !== undefined ? inboxCount : (resolvedCount ?? 0);
  const resolvedBadgeTestId =
    badgeTestId ?? (repo !== undefined && scope === undefined ? `repo-count-${repo}` : undefined);

  const badge = resolveSavedSearchBadge({
    scope: resolvedScope,
    count: resolvedCount,
    newCount: resolvedNewCount,
    inboxCount: resolvedInboxCount,
    error,
  });

  const dataScope = badge.style === 'error' ? 'error' : resolvedScope;

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-scope={dataScope}
      aria-current={isSelected ? 'true' : undefined}
      aria-description={badge.error ? `Error: ${badge.error}` : undefined}
      className={`w-full group px-3 py-1.5 text-sm flex items-center justify-between gap-2 rounded cursor-pointer transition-colors ${
        isSelected
          ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-200 font-medium'
          : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-200'
      }`}
    >
      <span className="truncate">{displayLabel}</span>

      {badge.style === 'error' && (
        <span
          title={badge.error ?? undefined}
          aria-hidden="true"
          data-testid={resolvedBadgeTestId ?? 'saved-search-error-badge'}
          className="text-red-600 shrink-0 inline-flex items-center"
        >
          <AlertTriangle size={12} className="text-red-600" />
        </span>
      )}

      {badge.style === 'orange-bubble' && (
        <span
          role="img"
          data-testid={resolvedBadgeTestId}
          aria-label={badge.ariaLabel ?? undefined}
          className="text-[10px] px-1.5 rounded-full font-mono shrink-0 bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300"
        >
          {badge.count}
        </span>
      )}

      {badge.style === 'slate-bubble' && (
        <span
          role="img"
          data-testid={resolvedBadgeTestId}
          aria-label={badge.ariaLabel ?? undefined}
          className="text-[10px] px-1.5 rounded-full font-mono shrink-0 bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
        >
          {badge.count}
        </span>
      )}

      {badge.style === 'faded' && (
        <span
          role="img"
          data-testid={resolvedBadgeTestId}
          aria-label={badge.ariaLabel ?? undefined}
          className="text-[10px] font-mono text-slate-400 dark:text-slate-500 shrink-0"
        >
          {badge.count}
        </span>
      )}
    </button>
  );
}
