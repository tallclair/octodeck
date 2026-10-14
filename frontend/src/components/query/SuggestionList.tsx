// Autocomplete suggestion listbox for QueryInput (§6.6, §6.7).
import type { Suggestion } from '../../hooks/useQuerySuggestions';
import {
  MENU_LISTBOX_SCROLL_CLASS,
  MENU_PANEL_BELOW_LEFT,
  MENU_PANEL_CLASS,
  optionRowClass,
} from '../dashboard/menuStyles';

export interface SuggestionListProps {
  readonly id: string;
  readonly optionIdPrefix: string;
  readonly items: readonly Suggestion[];
  readonly active: number;
  readonly onHover: (index: number) => void;
  readonly onPick: (suggestion: Suggestion) => void;
}

export function SuggestionList({
  id,
  optionIdPrefix,
  items,
  active,
  onHover,
  onPick,
}: SuggestionListProps) {
  return (
    <div
      // Prevent focus from leaving the combobox input when clicking anywhere in the popup.
      onMouseDown={(e) => e.preventDefault()}
      className={`${MENU_PANEL_CLASS} ${MENU_PANEL_BELOW_LEFT} w-80 max-w-[90vw] overflow-hidden`}
    >
      <ul
        id={id}
        role="listbox"
        aria-label="Query suggestions"
        className={`${MENU_LISTBOX_SCROLL_CLASS} py-1`}
      >
        {items.map((item, i) => {
          const isSelected = i === active;
          return (
            <li
              key={`${item.kind}:${item.label}`}
              id={`${optionIdPrefix}-${i}`}
              role="option"
              aria-selected={isSelected}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(item)}
              className={optionRowClass({ selected: isSelected })}
            >
              <span className="font-mono text-xs truncate">{item.label}</span>
              {item.detail && (
                <span
                  className={`text-xs font-normal truncate ${
                    isSelected
                      ? 'text-blue-600/80 dark:text-blue-300/80'
                      : 'text-slate-400 dark:text-slate-500'
                  }`}
                >
                  {item.detail}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div
        aria-hidden="true"
        className="px-3 py-1 border-t border-slate-100 dark:border-slate-800 text-[10px] text-slate-400 dark:text-slate-500 select-none"
      >
        ↑↓ navigate · Enter accept · Tab complete · Esc close
      </div>
    </div>
  );
}

