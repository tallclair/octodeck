// Throwaway UX prototype, option 1: tokenized input (Gmail/Linear style).
//
// Model: the query is a list of finished tokens ("chips") plus one editable
// draft that sits at a position among them. Moving the caret across a chip
// boundary (arrows, Backspace/Delete, click) commits the current draft back to
// chips and "opens" the neighbouring chip as editable text.

import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { Search, X } from 'lucide-react';
import { applySuggestion, parseToken, scanTokens, segmentToken } from './parser';
import type { Suggestion } from './parser';
import { NEGATED_PILL_CLASS, PILL_CLASS, SEGMENT_CLASS } from './styles';
import { useSuggestions } from './useSuggestions';
import SuggestionList from './SuggestionList';

interface Props {
  initial: string;
  onChange: (text: string) => void;
}

interface EdState {
  chips: string[];
  // Position of the draft among chips: it renders before chips[index].
  index: number;
  draft: string;
}

const splitRaw = (s: string) => scanTokens(s).map((sp) => s.slice(sp.start, sp.end));

const toText = (st: EdState) =>
  [...st.chips.slice(0, st.index), st.draft.trim(), ...st.chips.slice(st.index)].filter(Boolean).join(' ');

// Turns the whole draft into chips at the draft position.
function commitDraft(st: EdState): EdState & { added: number } {
  const toks = splitRaw(st.draft);
  return {
    chips: [...st.chips.slice(0, st.index), ...toks, ...st.chips.slice(st.index)],
    index: st.index + toks.length,
    draft: '',
    added: toks.length,
  };
}

// After an edit, tokens entirely before or after the caret become chips; only
// the token under the caret stays editable. Typing a space therefore finishes
// a token (unless inside quotes), and pasting a full query chips everything
// except the last token.
function normalize(st: EdState, caret: number): { st: EdState; caret: number } {
  const spans = scanTokens(st.draft);
  const cur = spans.find((s) => s.start <= caret && caret <= s.end);
  const before = spans.filter((s) => s.end < caret).map((s) => st.draft.slice(s.start, s.end));
  const after = spans.filter((s) => s.start > caret).map((s) => st.draft.slice(s.start, s.end));
  return {
    st: {
      chips: [...st.chips.slice(0, st.index), ...before, ...after, ...st.chips.slice(st.index)],
      index: st.index + before.length,
      draft: cur ? st.draft.slice(cur.start, cur.end) : '',
    },
    caret: cur ? caret - cur.start : 0,
  };
}

// Opens chip i as editable text (committing the current draft first).
function openChip(st: EdState, i: number, caret: number | 'end'): { st: EdState; caret: number } {
  const c = commitDraft(st);
  const j = i >= st.index ? i + c.added : i;
  const raw = c.chips[j];
  return {
    st: { chips: [...c.chips.slice(0, j), ...c.chips.slice(j + 1)], index: j, draft: raw },
    caret: caret === 'end' ? raw.length : Math.min(caret, raw.length),
  };
}

// Maps a click position inside a chip to a character offset in its raw text,
// using the data-off attribute on each rendered segment.
function offsetFromPoint(x: number, y: number, fallback: number): number {
  let node: Node | null = null;
  let off = 0;
  if ('caretPositionFromPoint' in document) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) {
      node = p.offsetNode;
      off = p.offset;
    }
  } else if ('caretRangeFromPoint' in document) {
    const r = (document as Document).caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      off = r.startOffset;
    }
  }
  const base = node?.nodeType === Node.TEXT_NODE ? node.parentElement?.dataset.off : undefined;
  return base !== undefined ? Number(base) + off : fallback;
}

function Chip({ raw, onOpen, onRemove }: { raw: string; onOpen: (offset: number) => void; onRemove: () => void }) {
  const token = parseToken(raw, { start: 0, end: raw.length });
  const segs = segmentToken(raw, token).map((s) => (
    <span key={s.start} data-off={s.start} className={SEGMENT_CLASS[s.role]}>
      {raw.slice(s.start, s.end)}
    </span>
  ));
  const handleDown = (e: MouseEvent) => {
    // Prevent the input from blurring (which would commit and re-render).
    e.preventDefault();
    onOpen(offsetFromPoint(e.clientX, e.clientY, raw.length));
  };
  if (token.kind === 'text') {
    return (
      <span onMouseDown={handleDown} className="cursor-text px-0.5 rounded hover:bg-slate-200/60 dark:hover:bg-slate-800">
        {segs}
      </span>
    );
  }
  const pill = token.negated && token.status === 'ok' ? NEGATED_PILL_CLASS : PILL_CLASS[token.status];
  return (
    <span
      onMouseDown={handleDown}
      title={token.message}
      className={`group inline-flex items-center gap-0.5 rounded-full pl-2 pr-1 cursor-text ${pill}`}
    >
      <span>{segs}</span>
      <button
        type="button"
        aria-label={`Remove ${raw}`}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove();
        }}
        className="opacity-40 group-hover:opacity-100 hover:text-red-600 text-slate-500 cursor-pointer"
      >
        <X size={12} />
      </button>
    </span>
  );
}

export default function TokenizedInput({ initial, onChange }: Props) {
  const [st, setSt] = useState<EdState>(() => {
    const chips = splitRaw(initial);
    return { chips, index: chips.length, draft: '' };
  });
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const sugg = useSuggestions(st.draft, caret, focused);

  // Restore focus/caret after state changes that re-render the input.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (pendingCaret.current !== null && el) {
      el.focus();
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  const apply = (next: EdState, nextCaret: number | null) => {
    setSt(next);
    if (nextCaret !== null) {
      setCaret(nextCaret);
      pendingCaret.current = nextCaret;
    }
    onChange(toText(next));
  };
  const applyMove = (r: { st: EdState; caret: number }) => apply(r.st, r.caret);

  const accept = (s: Suggestion, key: string) => {
    if (!sugg.result) return;
    const r = applySuggestion(st.draft, sugg.result, s);
    if (s.kind !== 'key' && key === 'Enter') {
      // Enter on a value finishes the token; Tab keeps editing (e.g. to add ",").
      apply(commitDraft({ ...st, draft: r.text }), 0);
    } else {
      apply({ ...st, draft: r.text }, r.caret);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (sugg.onKeyDown(e, accept)) return;
    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const collapsed = start === el.selectionEnd;
    const atStart = collapsed && start === 0;
    const atEnd = collapsed && start === st.draft.length;
    const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
    const hasPrev = st.index > 0;
    const hasNext = st.index < st.chips.length;
    switch (e.key) {
      case 'Backspace':
      case 'ArrowLeft':
        if (atStart && hasPrev && plain) {
          e.preventDefault();
          applyMove(openChip(st, st.index - 1, 'end'));
        }
        break;
      case 'Delete':
      case 'ArrowRight':
        if (atEnd && hasNext && plain) {
          e.preventDefault();
          applyMove(openChip(st, st.index, 0));
        }
        break;
      case 'Home':
        if (hasPrev) {
          e.preventDefault();
          applyMove(openChip(st, 0, 0));
        }
        break;
      case 'End':
        if (hasNext) {
          e.preventDefault();
          const c = commitDraft(st);
          apply({ ...c, index: c.chips.length }, 0);
        }
        break;
      case 'Enter':
        e.preventDefault();
        apply(commitDraft(st), 0);
        break;
    }
  };

  // Clicking empty space in the box moves the draft to the end.
  const onBoxDown = (e: MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const c = commitDraft(st);
    apply({ ...c, index: c.chips.length }, 0);
  };

  const trailing = st.index === st.chips.length;
  const empty = st.chips.length === 0 && st.draft === '';
  const placeholder = 'Search or filter (try is:open label:bug)';
  const input = (
    <span
      key="__input"
      className={`relative inline-grid ${trailing ? 'flex-1 min-w-24' : 'min-w-[1ch]'} ${
        !trailing && focused ? 'bg-white dark:bg-slate-800 rounded ring-1 ring-blue-400 px-1' : ''
      }`}
    >
      {/* Invisible sizer: makes the input exactly as wide as its text. */}
      <span aria-hidden className="invisible whitespace-pre col-start-1 row-start-1">
        {st.draft || (empty ? placeholder : ' ')}
      </span>
      <input
        ref={inputRef}
        value={st.draft}
        spellCheck={false}
        placeholder={empty ? placeholder : ''}
        onChange={(e) => {
          const v = e.target.value.replace(/[\r\n]+/g, ' ');
          applyMove(normalize({ ...st, draft: v }, e.target.selectionStart ?? v.length));
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (st.draft) apply(commitDraft(st), null);
        }}
        className="col-start-1 row-start-1 w-full min-w-0 bg-transparent outline-none text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500"
      />
      {sugg.open && sugg.result && (
        <SuggestionList items={sugg.result.items} active={sugg.active} onHover={sugg.setActive} onPick={(s) => accept(s, 'Enter')} />
      )}
    </span>
  );

  const items = st.chips.map((raw, i) => (
    <Chip
      // Index keys are fine here: chips are re-derived from text on every edit.
      key={`${i}:${raw}`}
      raw={raw}
      onOpen={(off) => applyMove(openChip(st, i, off))}
      onRemove={() => {
        const chips = st.chips.filter((_, j) => j !== i);
        apply({ ...st, chips, index: i < st.index ? st.index - 1 : st.index }, null);
      }}
    />
  ));
  items.splice(st.index, 0, input);

  return (
    <div className="relative">
      <Search size={14} className="absolute left-3 top-[11px] text-slate-400 dark:text-slate-500 pointer-events-none" />
      <div
        onMouseDown={onBoxDown}
        className="flex flex-wrap items-center gap-x-1 gap-y-1 min-h-[38px] w-full bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl py-1.5 pl-9 pr-4 text-sm leading-6 cursor-text focus-within:ring-2 focus-within:ring-blue-500"
      >
        {items}
      </div>
    </div>
  );
}
