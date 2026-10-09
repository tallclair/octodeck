export interface SidebarRepoRowProps {
  repo: string;
  isSelected: boolean;
  inboxCount: number;
  hasUnread: boolean;
  isPinned?: boolean;
  onClick: () => void;
}

export function SidebarRow({
  repo,
  isSelected,
  inboxCount,
  hasUnread,
  isPinned = false,
  onClick,
}: SidebarRepoRowProps) {
  const unselectedTone = isPinned
    ? 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-100'
    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-200';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full group px-3 py-1.5 text-sm flex items-center justify-between rounded cursor-pointer transition-colors ${
        isSelected
          ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-200 font-medium'
          : unselectedTone
      }`}
    >
      {isPinned ? (
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate">{repo}</span>
        </div>
      ) : (
        <span className="truncate">{repo}</span>
      )}
      {inboxCount > 0 && (
        <span
          data-testid={`repo-count-${repo}`}
          className={`text-[10px] px-1.5 rounded-full font-mono shrink-0 ${
            hasUnread
              ? 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300'
              : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
          }`}
        >
          {inboxCount}
        </span>
      )}
    </button>
  );
}
