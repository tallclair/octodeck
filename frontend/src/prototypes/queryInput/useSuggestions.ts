// Throwaway UX prototype: autocomplete state + keyboard navigation shared by both inputs.

import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { suggest } from './parser';
import type { Suggestion, SuggestionResult } from './parser';

export interface SuggestionsState {
  result: SuggestionResult | null;
  open: boolean;
  active: number;
  setActive: (i: number) => void;
  // Handles navigation keys. Returns true if the event was consumed.
  onKeyDown: (e: KeyboardEvent, accept: (s: Suggestion, key: string) => void) => boolean;
}

// All navigation state is keyed by a signature of (text, caret) so it resets
// automatically whenever the user types or moves the caret.
export function useSuggestions(text: string, caret: number, focused: boolean): SuggestionsState {
  const sig = `${caret}|${text}`;
  const [activeState, setActiveState] = useState({ sig: '', index: 0 });
  const [dismissedSig, setDismissedSig] = useState<string | null>(null);
  const [forcedSig, setForcedSig] = useState<string | null>(null);

  const result = focused ? suggest(text, caret, forcedSig === sig) : null;
  const n = result?.items.length ?? 0;
  const open = n > 0 && dismissedSig !== sig;
  const active = activeState.sig === sig ? Math.min(activeState.index, n - 1) : 0;
  const setActive = (index: number) => setActiveState({ sig, index });

  const onKeyDown = (e: KeyboardEvent, accept: (s: Suggestion, key: string) => void): boolean => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        // Open the list (including key suggestions on an empty token).
        setDismissedSig(null);
        setForcedSig(sig);
        setActive(0);
        return true;
      }
      setActive((active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      return true;
    }
    if (!open || !result) return false;
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      accept(result.items[active], e.key);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissedSig(sig);
      return true;
    }
    return false;
  };

  return { result, open, active, setActive, onKeyDown };
}
