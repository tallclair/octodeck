import { X } from 'lucide-react';
import type { FilterControls } from '../../types/filters';
import { formatPredicateChip, type ExtraPredicate } from '../../logic/query/predicates';

export interface ActiveFilterChipsProps {
  filters: FilterControls;
  extraPredicates: readonly ExtraPredicate[];
  setFilter: <K extends keyof FilterControls>(
    key: K,
    value: FilterControls[K],
    replaceHistory?: boolean
  ) => void;
  removePredicateAt: (index: number) => void;
  clearSecondaryFilters: () => void;
}

function hasActiveFilterChips(
  filters: FilterControls,
  extraPredicates: readonly ExtraPredicate[]
): boolean {
  return (
    filters.state !== 'all' ||
    filters.tracking !== 'all' ||
    Boolean(filters.repo) ||
    Boolean(filters.org) ||
    Boolean(filters.author) ||
    Boolean(filters.milestone) ||
    Boolean(filters.label) ||
    filters.assigned === 'me' ||
    extraPredicates.length > 0
  );
}

export function ActiveFilterChips({
  filters,
  extraPredicates,
  setFilter,
  removePredicateAt,
  clearSecondaryFilters,
}: ActiveFilterChipsProps) {
  if (!hasActiveFilterChips(filters, extraPredicates)) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-4 pt-1">
      {/* Active Filter Chips */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {filters.state !== 'all' && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
            <span className="text-blue-600 dark:text-blue-400/80">State:</span>
            <span className="font-semibold capitalize">
              {filters.state === 'open' ? 'Open' : 'Closed'}
            </span>
            <button
              type="button"
              onClick={() => setFilter('state', 'all')}
              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
              title="Remove state filter"
              aria-label="Remove state filter"
            >
              <X size={12} />
            </button>
          </span>
        )}

        {filters.tracking !== 'all' && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
            <span className="text-blue-600 dark:text-blue-400/80">Tracking:</span>
            <span className="font-semibold capitalize">
              {filters.tracking === 'tracked' ? 'Tracked' : 'Untracked'}
            </span>
            <button
              type="button"
              onClick={() => setFilter('tracking', 'all')}
              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
              title="Remove tracking filter"
              aria-label="Remove tracking filter"
            >
              <X size={12} />
            </button>
          </span>
        )}

        {filters.repo && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
            <span className="text-blue-600 dark:text-blue-400/80">Repo:</span>
            <span className="font-semibold">{filters.repo}</span>
            <button
              type="button"
              onClick={() => setFilter('repo', null)}
              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
              title="Remove repository filter"
              aria-label="Remove repository filter"
            >
              <X size={12} />
            </button>
          </span>
        )}

        {filters.org && !filters.repo && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
            <span className="text-blue-600 dark:text-blue-400/80">Org:</span>
            <span className="font-semibold">{filters.org}</span>
            <button
              type="button"
              onClick={() => setFilter('org', null)}
              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
              title="Remove organization filter"
              aria-label="Remove organization filter"
            >
              <X size={12} />
            </button>
          </span>
        )}

        {filters.author && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
            <span className="text-blue-600 dark:text-blue-400/80">Author:</span>
            <span className="font-semibold">@{filters.author}</span>
            <button
              type="button"
              onClick={() => setFilter('author', null)}
              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
              title="Remove author filter"
              aria-label="Remove author filter"
            >
              <X size={12} />
            </button>
          </span>
        )}

        {filters.milestone && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
            <span className="text-blue-600 dark:text-blue-400/80">Milestone:</span>
            <span className="font-semibold">{filters.milestone}</span>
            <button
              type="button"
              onClick={() => setFilter('milestone', null)}
              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
              title="Remove milestone filter"
              aria-label="Remove milestone filter"
            >
              <X size={12} />
            </button>
          </span>
        )}

        {filters.label && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
            <span className="text-blue-600 dark:text-blue-400/80">Label:</span>
            <span className="font-semibold">{filters.label}</span>
            <button
              type="button"
              onClick={() => setFilter('label', null)}
              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
              title="Remove label filter"
              aria-label="Remove label filter"
            >
              <X size={12} />
            </button>
          </span>
        )}

        {filters.assigned === 'me' && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
            <span className="text-blue-600 dark:text-blue-400/80">Assigned:</span>
            <span className="font-semibold">Me</span>
            <button
              type="button"
              onClick={() => setFilter('assigned', 'all')}
              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
              title="Remove assigned filter"
              aria-label="Remove assigned filter"
            >
              <X size={12} />
            </button>
          </span>
        )}

        {/* Predicates from the URL that no control can show (multiple values, negation, other fields) */}
        {extraPredicates.map(({ predicate, index }) => {
          const chip = formatPredicateChip(predicate);
          return (
            <span
              key={`${index}-${chip.label}-${chip.value}`}
              data-testid="extra-filter-chip"
              className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium"
            >
              <span className="text-blue-600 dark:text-blue-400/80">
                {chip.negated ? 'Not ' : ''}{chip.label}:
              </span>
              <span className="font-semibold">{chip.value}</span>
              <button
                type="button"
                onClick={() => removePredicateAt(index)}
                className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
                title={`Remove ${chip.label.toLowerCase()} filter`}
                aria-label={`Remove ${chip.negated ? 'negated ' : ''}${chip.label.toLowerCase()} filter ${chip.value}`}
              >
                <X size={12} />
              </button>
            </span>
          );
        })}
      </div>

      {/* Right-aligned Clear filters button */}
      <button
        type="button"
        onClick={clearSecondaryFilters}
        aria-label="Reset filters"
        className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer transition-colors shrink-0"
      >
        <X size={13} />
        <span>Clear filters</span>
      </button>
    </div>
  );
}
