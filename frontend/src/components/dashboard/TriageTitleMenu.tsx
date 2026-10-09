import type { RefObject } from 'react';
import { Filter, Zap, CheckCircle, Layers, ChevronDown, Check } from 'lucide-react';
import type { TriageFilter } from '../../types/filters';

export interface TriageTitleMenuProps {
  triage: TriageFilter;
  onSelect: (tab: TriageFilter) => void;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  menuRef: RefObject<HTMLDivElement | null>;
}

export function TriageTitleMenu({
  triage,
  onSelect,
  isOpen,
  onToggle,
  onClose,
  menuRef,
}: TriageTitleMenuProps) {
  const titleText =
    triage === 'inbox'
      ? 'Inbox'
      : triage === 'activity'
      ? 'New'
      : triage === 'acked'
      ? 'Acked'
      : 'All Items';

  const titleIcon =
    triage === 'inbox' ? (
      <Filter size={18} className="text-blue-400" />
    ) : triage === 'activity' ? (
      <Zap size={18} className="text-orange-400" />
    ) : triage === 'acked' ? (
      <CheckCircle size={18} className="text-emerald-400" />
    ) : (
      <Layers size={18} className="text-slate-400" />
    );

  const pick = (tab: TriageFilter) => {
    onSelect(tab);
    onClose();
  };

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3 relative" ref={menuRef}>
        <button
          type="button"
          onClick={onToggle}
          aria-haspopup="true"
          aria-expanded={isOpen}
          aria-label="Select triage status"
          className="flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-white tracking-tight hover:text-blue-600 dark:hover:text-blue-300 transition-colors group cursor-pointer select-none"
        >
          {titleIcon}
          <span>{titleText}</span>
          <ChevronDown
            size={18}
            className={`text-slate-400 group-hover:text-blue-600 dark:group-hover:text-blue-300 transition-transform duration-200 ${
              isOpen ? 'rotate-180 text-blue-600 dark:text-blue-400' : ''
            }`}
          />
        </button>

        {isOpen && (
          <div className="absolute top-full left-0 mt-1.5 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
            <button
              type="button"
              onClick={() => pick('inbox')}
              className={`w-full px-3 py-2 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                triage === 'inbox'
                  ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <div className="flex items-center gap-2">
                <Filter size={14} className="text-blue-600 dark:text-blue-400" />
                <span>Inbox</span>
              </div>
              {triage === 'inbox' && <Check size={14} className="text-blue-600 dark:text-blue-400" />}
            </button>

            <button
              type="button"
              onClick={() => pick('activity')}
              className={`w-full px-3 py-2 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                triage === 'activity'
                  ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <div className="flex items-center gap-2">
                <Zap size={14} className="text-orange-500 dark:text-orange-400" />
                <span>New</span>
              </div>
              {triage === 'activity' && <Check size={14} className="text-blue-600 dark:text-blue-400" />}
            </button>

            <button
              type="button"
              onClick={() => pick('acked')}
              className={`w-full px-3 py-2 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                triage === 'acked'
                  ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <div className="flex items-center gap-2">
                <CheckCircle size={14} className="text-emerald-600 dark:text-emerald-400" />
                <span>Acked</span>
              </div>
              {triage === 'acked' && <Check size={14} className="text-blue-600 dark:text-blue-400" />}
            </button>

            <div className="border-t border-slate-200 dark:border-slate-800 my-1" />

            <button
              type="button"
              onClick={() => pick('all')}
              className={`w-full px-3 py-2 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                triage === 'all'
                  ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <div className="flex items-center gap-2">
                <Layers size={14} className="text-slate-500 dark:text-slate-400" />
                <span>All Items</span>
              </div>
              {triage === 'all' && <Check size={14} className="text-blue-600 dark:text-blue-400" />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
