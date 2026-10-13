import { X } from 'lucide-react';
import type { FilterControls } from '../../types/filters';
import {
  formatPredicateChip,
  hasActiveFilterChips,
  type ExtraPredicate,
} from '../../logic/query/predicates';
import { ACTIVITY_LABELS } from '../../logic/query/facets';
import type { DashboardMenuId } from '../../hooks/useMenuGroup';

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
  onOpenMenu?: (id: DashboardMenuId) => void;
}

function formatValuesSummary(values: readonly string[]): {
  display: string;
  fullTitle: string;
} {
  const fullTitle = values.join(', ');
  if (values.length <= 2) {
    return { display: fullTitle, fullTitle };
  }
  return {
    display: `${values[0]} +${values.length - 1}`,
    fullTitle,
  };
}

const withAtPrefix = (v: string) => (v.startsWith('@') ? v : `@${v}`);

interface ControlChipProps {
  label: string;
  filterName: string;
  values: readonly string[];
  menuId: DashboardMenuId;
  onOpenMenu?: (id: DashboardMenuId) => void;
  onRemove: () => void;
}

function ControlChip({
  label,
  filterName,
  values,
  menuId,
  onOpenMenu,
  onRemove,
}: ControlChipProps) {
  const { display, fullTitle } = formatValuesSummary(values);
  return (
    <span
      title={fullTitle}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium"
    >
      <button
        type="button"
        onClick={() => onOpenMenu?.(menuId)}
        className="inline-flex items-center gap-1.5 cursor-pointer text-left focus:outline-none focus-visible:underline"
      >
        <span className="text-blue-600 dark:text-blue-400/80">{label}:</span>
        <span className="font-semibold" title={fullTitle}>
          {display}
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
        title={`Remove ${filterName} filter ${fullTitle}`}
        aria-label={`Remove ${filterName} filter ${fullTitle}`}
      >
        <X size={12} />
      </button>
    </span>
  );
}

export function ActiveFilterChips({
  filters,
  extraPredicates,
  setFilter,
  removePredicateAt,
  clearSecondaryFilters,
  onOpenMenu,
}: ActiveFilterChipsProps) {
  if (!hasActiveFilterChips(filters, extraPredicates)) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-4 pt-1">
      {/* Active Filter Chips */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {filters.state !== 'all' && (
          <ControlChip
            label="State"
            filterName="state"
            values={[
              filters.state === 'open'
                ? 'Open'
                : filters.state === 'closed'
                ? 'Closed'
                : 'Merged',
            ]}
            menuId="state"
            onOpenMenu={onOpenMenu}
            onRemove={() => setFilter('state', 'all')}
          />
        )}

        {filters.tracking !== 'all' && (
          <ControlChip
            label="Tracking"
            filterName="tracking"
            values={[filters.tracking === 'tracked' ? 'Tracked' : 'Untracked']}
            menuId="state"
            onOpenMenu={onOpenMenu}
            onRemove={() => setFilter('tracking', 'all')}
          />
        )}

        {filters.repo.length > 0 && (
          <ControlChip
            label="Repo"
            filterName="repository"
            values={filters.repo}
            menuId="repo"
            onOpenMenu={onOpenMenu}
            onRemove={() => setFilter('repo', [])}
          />
        )}

        {filters.org.length > 0 && (
          <ControlChip
            label="Org"
            filterName="organization"
            values={filters.org}
            menuId="repo"
            onOpenMenu={onOpenMenu}
            onRemove={() => setFilter('org', [])}
          />
        )}

        {filters.author.length > 0 && (
          <ControlChip
            label="Author"
            filterName="author"
            values={filters.author.map(withAtPrefix)}
            menuId="author"
            onOpenMenu={onOpenMenu}
            onRemove={() => setFilter('author', [])}
          />
        )}

        {filters.assignee.length > 0 && (
          <ControlChip
            label="Assignee"
            filterName="assignee"
            values={filters.assignee.map(withAtPrefix)}
            menuId="assignee"
            onOpenMenu={onOpenMenu}
            onRemove={() => setFilter('assignee', [])}
          />
        )}

        {filters.milestone.length > 0 && (
          <ControlChip
            label="Milestone"
            filterName="milestone"
            values={filters.milestone}
            menuId="milestone"
            onOpenMenu={onOpenMenu}
            onRemove={() => setFilter('milestone', [])}
          />
        )}

        {filters.label.length > 0 && (
          <ControlChip
            label="Label"
            filterName="label"
            values={filters.label}
            menuId="label"
            onOpenMenu={onOpenMenu}
            onRemove={() => setFilter('label', [])}
          />
        )}

        {filters.activity.length > 0 && filters.triage !== 'activity' && (
          <ControlChip
            label="Activity"
            filterName="activity"
            values={filters.activity.map((v) => ACTIVITY_LABELS[v] ?? v)}
            menuId="state"
            onOpenMenu={onOpenMenu}
            onRemove={() => setFilter('activity', [])}
          />
        )}

        {/* Predicates from the URL that no control can show (negation, duplicate field, other fields) */}
        {extraPredicates.map(({ predicate, index }) => {
          const chip = formatPredicateChip(predicate);
          const { display, fullTitle } = formatValuesSummary(chip.values);
          return (
            <span
              key={`${index}-${chip.label}-${fullTitle}`}
              data-testid="extra-filter-chip"
              data-negated={chip.negated ? 'true' : undefined}
              title={fullTitle}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium"
            >
              {chip.negated && (
                <>
                  <span className="sr-only">Excluding </span>
                  <span
                    aria-hidden="true"
                    className="rounded bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300 text-[10px] font-semibold uppercase px-1"
                  >
                    NOT
                  </span>
                </>
              )}
              <span className="text-blue-600 dark:text-blue-400/80">{chip.label}:</span>
              <span className="font-semibold" title={fullTitle}>
                {display}
              </span>
              <button
                type="button"
                onClick={() => removePredicateAt(index)}
                className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
                title={`Remove ${chip.negated ? 'negated ' : ''}${chip.label.toLowerCase()} filter ${fullTitle}`}
                aria-label={`Remove ${chip.negated ? 'negated ' : ''}${chip.label.toLowerCase()} filter ${fullTitle}`}
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
