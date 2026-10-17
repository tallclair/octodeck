import { Pin } from 'lucide-react';
import { parseQuery, type ParsedQuery } from '../../logic/query/syntax';
import { findActiveSearch, type SavedSearchView } from '../../logic/savedSearches';

export interface PinButtonProps {
  readonly queryText?: string;
  readonly parsed?: ParsedQuery;
  readonly hasServerError?: boolean;
  readonly activeSearch?: SavedSearchView | null;
  readonly originSearch?: SavedSearchView | null;
  readonly isOriginModified?: boolean;
  readonly searches?: readonly SavedSearchView[];
  readonly insetPosition?: 'left-of-clear' | 'right-edge';
  readonly onClick: () => void;
}

export function PinButton({
  queryText,
  parsed,
  hasServerError = false,
  activeSearch,
  originSearch = null,
  isOriginModified = false,
  searches,
  insetPosition,
  onClick,
}: PinButtonProps) {
  const resolvedParsed = parsed ?? parseQuery(queryText ?? '');
  const rawText = queryText ?? resolvedParsed.text;
  const isEmpty = rawText.trim() === '' || resolvedParsed.clauses.length === 0;
  const hasIssues = resolvedParsed.issues.length > 0 || Boolean(hasServerError);

  const matchedSearch =
    activeSearch !== undefined
      ? activeSearch
      : searches
        ? (findActiveSearch(resolvedParsed, searches) ?? null)
        : null;

  const disabled = isEmpty || hasIssues;
  const isModified = !disabled && Boolean(originSearch) && isOriginModified;
  const isActive = !disabled && !isModified && matchedSearch !== null;

  const ariaLabel =
    isModified && originSearch
      ? `Update pinned search ${originSearch.name}`
      : isActive && matchedSearch
        ? `Edit pinned search ${matchedSearch.name}`
        : 'Pin search';
  const tooltip = isEmpty
    ? 'The Inbox is always in the sidebar'
    : hasIssues
      ? 'Fix the highlighted parts of the query first'
      : ariaLabel;

  const dataActive = isModified ? 'modified' : isActive ? 'true' : 'false';

  const positionClass =
    insetPosition === 'left-of-clear'
      ? 'absolute right-6.5 top-[6px] z-30 '
      : insetPosition === 'right-edge'
        ? 'absolute right-1.5 top-[6px] z-30 '
        : '';

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-disabled={disabled}
      title={tooltip}
      disabled={disabled}
      data-testid="pin-search-button"
      data-active={dataActive}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!disabled) {
          onClick();
        }
      }}
      className={`${positionClass}inline-flex items-center justify-center size-4.5 rounded-full transition-colors ${
        disabled
          ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed opacity-60'
          : isActive || isModified
            ? 'text-blue-600 dark:text-blue-400 hover:bg-blue-100/80 dark:hover:bg-blue-900/50 cursor-pointer'
            : 'text-slate-400 hover:text-slate-700 hover:bg-slate-200/80 dark:text-slate-500 dark:hover:text-slate-200 dark:hover:bg-slate-800 cursor-pointer'
      }`}
    >
      <Pin size={12} className={isActive ? 'fill-current' : undefined} />
    </button>
  );
}
