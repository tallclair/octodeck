// Throwaway UX prototype: dropdown list for autocomplete suggestions.

import type { Suggestion } from './parser';

interface Props {
  items: Suggestion[];
  active: number;
  onHover: (i: number) => void;
  onPick: (s: Suggestion) => void;
}

export default function SuggestionList({ items, active, onHover, onPick }: Props) {
  return (
    <ul
      role="listbox"
      // Keep focus in the input while clicking an item.
      onMouseDown={(e) => e.preventDefault()}
      className="absolute left-0 top-full mt-1 z-20 w-80 max-w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg py-1 text-sm"
    >
      {items.map((s, i) => (
        <li
          key={`${s.kind}:${s.label}`}
          role="option"
          aria-selected={i === active}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(s)}
          className={`px-3 py-1 flex items-center justify-between gap-3 cursor-pointer ${
            i === active ? 'bg-blue-600 text-white' : 'text-slate-700 dark:text-slate-300'
          }`}
        >
          <span className="font-mono truncate">{s.label}</span>
          {s.detail && (
            <span className={`text-xs truncate ${i === active ? 'text-blue-100' : 'text-slate-400 dark:text-slate-500'}`}>
              {s.detail}
            </span>
          )}
        </li>
      ))}
      <li className="px-3 pt-1 mt-1 border-t border-slate-100 dark:border-slate-800 text-[10px] text-slate-400 dark:text-slate-500">
        ↑↓ navigate · Enter accept · Tab complete · Esc close
      </li>
    </ul>
  );
}
