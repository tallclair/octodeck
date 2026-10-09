// Throwaway UX prototype, option 2: highlighted overlay (GitHub search bar style).
// A transparent-text textarea sits on top of a backdrop that renders the same
// text with qualifier pills. The backdrop is in normal flow and determines the
// height, so long queries wrap and grow the box without any JS measurement.

import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { applySuggestion, parseQuery, segmentToken } from './parser';
import type { Suggestion } from './parser';
import { NEGATED_PILL_CLASS, PILL_CLASS, SEGMENT_CLASS } from './styles';
import { useSuggestions } from './useSuggestions';
import SuggestionList from './SuggestionList';

interface Props {
  initial: string;
  onChange: (text: string) => void;
}

// Shared box metrics: textarea and backdrop must match exactly.
const BOX = 'py-1.5 pl-9 pr-4 text-sm leading-6 font-sans whitespace-pre-wrap break-words border';

function Backdrop({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const t of parseQuery(text)) {
    if (t.start > pos) parts.push(text.slice(pos, t.start));
    const segs = segmentToken(text, t).map((s) => (
      <span key={s.start} className={SEGMENT_CLASS[s.role]}>
        {text.slice(s.start, s.end)}
      </span>
    ));
    const pill = t.kind === 'qualifier' ? (t.negated && t.status === 'ok' ? NEGATED_PILL_CLASS : PILL_CLASS[t.status]) : '';
    // px + negative mx keeps glyph positions identical to the textarea.
    parts.push(
      <span key={`t${t.start}`} className={pill ? `${pill} rounded px-[3px] -mx-[3px] box-decoration-clone` : ''}>
        {segs}
      </span>,
    );
    pos = t.end;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  // Trailing zero-width space keeps a trailing newline/space measured.
  return <>{parts}{'\u200b'}</>;
}

export default function OverlayInput({ initial, onChange }: Props) {
  const [text, setText] = useState(initial);
  const [caret, setCaret] = useState(initial.length);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const sugg = useSuggestions(text, caret, focused);

  useLayoutEffect(() => {
    if (pendingCaret.current !== null && ref.current) {
      ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  const update = (next: string, nextCaret: number) => {
    setText(next);
    setCaret(nextCaret);
    onChange(next);
  };

  const accept = (s: Suggestion, key: string) => {
    if (!sugg.result) return;
    let { text: next, caret: c } = applySuggestion(text, sugg.result, s);
    // Enter on a value finishes the clause; Tab leaves the caret after it so a
    // comma can add another OR value.
    if (s.kind !== 'key' && key === 'Enter' && next[c] !== ' ') {
      next = `${next.slice(0, c)} ${next.slice(c)}`;
      c += 1;
    }
    pendingCaret.current = c;
    update(next, c);
  };

  return (
    <div className="relative">
      <Search size={14} className="absolute left-3 top-[11px] z-10 text-slate-400 dark:text-slate-500 pointer-events-none" />
      <div className="relative rounded-2xl bg-slate-100 dark:bg-slate-900 focus-within:ring-2 focus-within:ring-blue-500">
        <div aria-hidden className={`${BOX} border-slate-200 dark:border-slate-800 rounded-2xl text-slate-800 dark:text-slate-300 min-h-[38px]`}>
          <Backdrop text={text} />
        </div>
        <textarea
          ref={ref}
          value={text}
          rows={1}
          spellCheck={false}
          placeholder="Search or filter (try is:open label:bug)"
          onChange={(e) => {
            // Pasted newlines become spaces; the query is a single line.
            const v = e.target.value.replace(/[\r\n]+/g, ' ');
            update(v, e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (sugg.onKeyDown(e, accept)) return;
            if (e.key === 'Enter') e.preventDefault();
          }}
          className={`${BOX} border-transparent absolute inset-0 w-full h-full resize-none overflow-hidden bg-transparent rounded-2xl text-transparent caret-slate-900 dark:caret-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none selection:bg-blue-500/30 selection:text-transparent`}
        />
      </div>
      {sugg.open && sugg.result && (
        <SuggestionList items={sugg.result.items} active={sugg.active} onHover={sugg.setActive} onPick={(s) => accept(s, 'Enter')} />
      )}
    </div>
  );
}
