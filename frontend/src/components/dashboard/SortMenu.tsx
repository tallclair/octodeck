import type { RefObject } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import type { SortOption, SortOrder } from '../../types/filters';

export interface SortMenuProps {
  sort: SortOption;
  order: SortOrder;
  onSelectSort: (sort: SortOption) => void;
  onSelectOrder: (order: SortOrder) => void;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  menuRef: RefObject<HTMLDivElement | null>;
}

export function SortMenu({
  sort,
  order,
  onSelectSort,
  onSelectOrder,
  isOpen,
  onToggle,
  onClose,
  menuRef,
}: SortMenuProps) {
  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={onToggle}
        aria-label="Sort options"
        aria-haspopup="true"
        aria-expanded={isOpen}
        className="flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 px-1 py-0.5 rounded transition-colors cursor-pointer text-xs"
      >
        <span>
          {sort === 'updated'
            ? 'Latest Activity'
            : sort === 'acked'
            ? 'Last Acked'
            : 'Creation Date'}
        </span>
        <ChevronDown
          size={12}
          className={`text-slate-400 dark:text-slate-500 transition-transform duration-150 ${
            isOpen ? 'rotate-180 text-blue-600 dark:text-blue-400' : ''
          }`}
        />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-36 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
          <button
            type="button"
            onClick={() => {
              onSelectSort('updated');
              onClose();
            }}
            className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
              sort === 'updated'
                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <span>Latest Activity</span>
            {sort === 'updated' && <Check size={12} className="text-blue-600 dark:text-blue-400" />}
          </button>

          <button
            type="button"
            onClick={() => {
              onSelectSort('acked');
              onClose();
            }}
            className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
              sort === 'acked'
                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <span>Last Acked</span>
            {sort === 'acked' && <Check size={12} className="text-blue-600 dark:text-blue-400" />}
          </button>

          <button
            type="button"
            onClick={() => {
              onSelectSort('created');
              onClose();
            }}
            className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
              sort === 'created'
                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <span>Creation Date</span>
            {sort === 'created' && <Check size={12} className="text-blue-600 dark:text-blue-400" />}
          </button>

          <div className="border-t border-slate-200 dark:border-slate-800 my-1" />

          <button
            type="button"
            onClick={() => {
              onSelectOrder('asc');
              onClose();
            }}
            className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
              order === 'asc'
                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <span>Ascending</span>
            {order === 'asc' && <Check size={12} className="text-blue-600 dark:text-blue-400" />}
          </button>

          <button
            type="button"
            onClick={() => {
              onSelectOrder('desc');
              onClose();
            }}
            className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
              order === 'desc'
                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <span>Descending</span>
            {order === 'desc' && <Check size={12} className="text-blue-600 dark:text-blue-400" />}
          </button>
        </div>
      )}
    </div>
  );
}
