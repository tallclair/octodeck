// State and native-editing plumbing for the query input (components/query/QueryInput.tsx).
//
// A real <textarea> owns the caret, selection, undo, IME and paste. It shows the display form of
// the query text (logic/query/displayText.ts); every edit that would leave a non-canonical
// display value is planned in `beforeinput` and applied as ONE native edit (execCommand), so the
// browser's undo stack keeps working. The decoration layer (a "mirror" that wraps exactly like
// the textarea) draws the coloured glyphs; this hook measures where each clause's glyphs render
// to place the painted pill boxes (and the hover remove button inside the hovered one), and
// anchors the suggestion popup.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
  type RefObject,
} from 'react';
import type { QueryEditKind } from './useDashboardFilters';
import {
  useQuerySuggestions,
  type QuerySuggestionFacets,
  type QuerySuggestionsState,
  type Suggestion,
} from './useQuerySuggestions';
import {
  clauseIndexAt,
  normalizeQuerySpacing,
} from '../logic/query/clauseDisplay';
import {
  editRange,
  fromDisplay,
  normalizeInsert,
  planEdit,
  toDisplay,
  type EditPlan,
} from '../logic/query/displayText';
import {
  boxFragments,
  pillAtPoint,
  pillBoxes,
  popupLeft,
  type PillBox,
  type PillFragments,
  type PillMetrics,
} from '../logic/query/fieldGeometry';
import {
  resolveQueryErrors,
  type ResolvedQueryErrors,
  type ServerInvalidQuery,
} from '../logic/query/predicates';
import { parseQuery, type ParsedQuery } from '../logic/query/syntax';
import { removeClause as removeClauseFromText } from '../logic/query/textEdit';

/** Width (px) the suggestion popup is clamped to when anchoring it under a token. */
const POPUP_WIDTH_PX = 320;
/** Shift (px) so the popup's option text lines up with the token being completed. */
const POPUP_INSET_PX = 12;

export interface QueryFieldOptions {
  /** Query text of record (controlled: an external change always wins). */
  readonly value: string;
  readonly onChange: (text: string, kind: QueryEditKind) => void;
  readonly onClear?: () => void;
  readonly invalidQuery?: ServerInvalidQuery | null;
  readonly facets?: QuerySuggestionFacets;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
  /** Geometry of the painted pill boxes (see pillBoxes). */
  readonly pillMetrics: PillMetrics;
}

/** The pill showing the hover remove button (at rest only). */
export interface QueryFieldHover {
  readonly index: number;
  /** Local text the hover was measured against; stale hovers are ignored after edits. */
  readonly text: string;
}

export interface QueryFieldRefs {
  /** Callback ref (also forwards the element to the caller's inputRef). */
  readonly textareaRef: (el: HTMLTextAreaElement | null) => void;
  readonly frameRef: RefObject<HTMLDivElement | null>;
  readonly mirrorRef: RefObject<HTMLDivElement | null>;
  readonly popupRef: RefObject<HTMLDivElement | null>;
}

export interface QueryField {
  readonly ids: { readonly listbox: string; readonly option: string; readonly description: string };
  /** Local query text (may hold extra whitespace the user is typing). */
  readonly text: string;
  /** What the textarea and the decoration layer show. */
  readonly display: string;
  readonly parsed: ParsedQuery;
  readonly errors: ResolvedQueryErrors;
  readonly focused: boolean;
  /** Clause containing the caret while focused, else -1. */
  readonly caretClause: number;
  readonly hover: QueryFieldHover | null;
  /** Painted pill boxes in the decoration layer's coordinates. */
  readonly boxes: readonly PillBox[];
  readonly suggestions: QuerySuggestionsState;
  readonly announcement: { readonly text: string; readonly seq: number };
  readonly acceptSuggestion: (s: Suggestion, key: 'Enter' | 'Tab') => void;
  readonly removeClause: (index: number) => void;
  readonly clearAll: () => void;
  readonly textareaProps: {
    readonly value: string;
    readonly onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
    readonly onSelect: () => void;
    readonly onFocus: () => void;
    readonly onBlur: () => void;
    readonly onScroll: () => void;
    readonly onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
    readonly onCopy: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
    readonly onCut: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
    readonly onCompositionStart: () => void;
    readonly onCompositionEnd: () => void;
  };
  readonly frameProps: {
    readonly onMouseMove: (e: MouseEvent<HTMLDivElement>) => void;
    readonly onMouseLeave: () => void;
  };
}

function setForwardedRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
  } else {
    (ref as { current: T | null }).current = value;
  }
}

/**
 * Re-syncs the control to the canonical display form, keeping the selection. A fallback for
 * edits `beforeinput` could not plan (IME commits, drops, word deletions that change quoting):
 * assigning `value` resets the native undo stack, so planned edits avoid it.
 */
function resync(el: HTMLTextAreaElement): string {
  const text = fromDisplay(normalizeInsert(el.value));
  const display = toDisplay(text);
  if (display !== el.value) {
    const { selectionStart, selectionEnd } = el;
    el.value = display;
    el.setSelectionRange(selectionStart, selectionEnd);
  }
  return text;
}

/**
 * Applies `plan` to the control as one native edit (execCommand keeps it on the undo stack) and
 * places the caret. Without execCommand support (jsdom, or a browser that refuses), falls back to
 * setRangeText plus a synthetic input event, which React handles like a typed edit.
 */
function applyNativeEdit(el: HTMLTextAreaElement, plan: EditPlan, applying: { current: boolean }): void {
  applying.current = true;
  try {
    el.setSelectionRange(plan.start, plan.end);
    const ok =
      typeof document.execCommand === 'function' &&
      (plan.insert === ''
        ? document.execCommand('delete')
        : document.execCommand('insertText', false, plan.insert));
    if (!ok) {
      el.setRangeText(plan.insert, plan.start, plan.end);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.setSelectionRange(plan.caret, plan.caret);
  } finally {
    applying.current = false;
  }
}

/**
 * Viewport rect of the character at `offset` among the text nodes under `root` (or just after
 * the last character). Anchors popups to a wrapped line without a marker element.
 */
function rectAtOffset(root: Node, offset: number): DOMRect | null {
  if (typeof Range.prototype.getClientRects !== 'function') return null; // jsdom: no layout
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const len = node.data.length;
    if (offset < seen + len) {
      const range = document.createRange();
      range.setStart(node, offset - seen);
      range.setEnd(node, offset - seen + 1);
      return range.getClientRects()[0] ?? range.getBoundingClientRect();
    }
    seen += len;
    last = node;
  }
  if (!last || last.data.length === 0) return null;
  const range = document.createRange();
  range.setStart(last, last.data.length - 1);
  range.setEnd(last, last.data.length);
  const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
  return new DOMRect(r.right, r.top, 0, r.height);
}

/** Viewport origin of `frame`'s padding box, which absolutely positioned children use. */
function paddingOrigin(frame: HTMLElement): { left: number; top: number } {
  const r = frame.getBoundingClientRect();
  return { left: r.left + frame.clientLeft, top: r.top + frame.clientTop };
}

/**
 * The mirror's own coordinate system: its viewport origin and the CSS zoom applied to it, so
 * viewport rects convert to the px its absolutely positioned children are laid out in.
 */
function mirrorSpace(mirror: HTMLElement): { left: number; top: number; zoom: number } {
  const r = mirror.getBoundingClientRect();
  const zoom = (mirror as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom ?? 1;
  return { left: r.left, top: r.top, zoom: zoom > 0 ? zoom : 1 };
}

/** Where each clause's glyphs render, per line, in the mirror's coordinates. */
function glyphFragments(mirror: HTMLElement): PillFragments[] {
  const o = mirrorSpace(mirror);
  return Array.from(mirror.querySelectorAll<HTMLElement>('[data-clause]'), (span) => ({
    index: Number(span.dataset.clause),
    rects: Array.from(span.getClientRects(), (r) => ({
      left: (r.left - o.left) / o.zoom,
      top: (r.top - o.top) / o.zoom,
      right: (r.right - o.left) / o.zoom,
      bottom: (r.bottom - o.top) / o.zoom,
    })),
  }));
}

const sameBoxes = (a: readonly PillBox[], b: readonly PillBox[]) =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.index === b[i].index &&
      x.left === b[i].left &&
      x.top === b[i].top &&
      x.width === b[i].width &&
      x.first === b[i].first &&
      x.last === b[i].last
  );

export function useQueryField({
  value,
  onChange,
  onClear,
  invalidQuery,
  facets,
  inputRef,
  pillMetrics,
}: QueryFieldOptions): { field: QueryField; refs: QueryFieldRefs } {
  const baseId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  /** True while a planned native edit runs (its nested beforeinput must pass through). */
  const applyingRef = useRef(false);
  /** True while clearing natively: the resulting change updates local text without emitting. */
  const silentRef = useRef(false);

  // During IME composition the control shows exactly what the IME produced (re-rendering a
  // remapped value mid-composition would break it); it is re-synced on compositionend.
  const [composedValue, setComposedValue] = useState<string | null>(null);
  // Local text: the controlled value plus any extra whitespace the user is typing. Emitted
  // text is always normalised (single spaces, trimmed), the form the dashboard state keeps.
  const [text, setText] = useState(value);
  const textRef = useRef(text);
  const [syncedValue, setSyncedValue] = useState(value);
  // The external value always wins: adopt it whenever it is not just the normalised local text
  // (a dropdown edit, a sidebar click, Back/Forward), even while focused.
  if (value !== syncedValue) {
    setSyncedValue(value);
    if (value !== normalizeQuerySpacing(text)) {
      setText(value);
      setComposedValue(null);
    }
  }
  useLayoutEffect(() => {
    textRef.current = text;
  }, [text]);

  const [selection, setSelection] = useState({ start: text.length, end: text.length });
  const [focused, setFocused] = useState(false);
  const [hover, setHover] = useState<QueryFieldHover | null>(null);
  // Painted pill boxes, measured from where the glyphs render after each layout.
  const [boxes, setBoxes] = useState<readonly PillBox[]>([]);
  const [announcement, setAnnouncement] = useState({ text: '', seq: 0 });
  const announce = useCallback((message: string) => {
    setAnnouncement((prev) => ({ text: message, seq: prev.seq + 1 }));
  }, []);

  const canonicalDisplay = useMemo(() => toDisplay(text), [text]);
  const display = composedValue ?? canonicalDisplay;
  const parsed = useMemo(() => parseQuery(text), [text]);
  const caret = Math.min(selection.end, text.length);
  const caretClause = focused ? clauseIndexAt(parsed, caret) : -1;
  const suggestions = useQuerySuggestions(
    text,
    caret,
    focused && selection.start === selection.end,
    facets
  );
  const anchor = suggestions.result?.start ?? null;

  // While focused, the clause under the caret is left out of the summary and announcements, so
  // typing `label:` does not flash an error (it is excluded from the request anyway).
  const errors = useMemo(
    () =>
      resolveQueryErrors(parsed, invalidQuery, {
        excludedClauseIndex: caretClause >= 0 ? caretClause : null,
      }),
    [parsed, invalidQuery, caretClause]
  );

  // Announce issues as they appear (a newly committed bad clause, a server ExprError).
  const messagesKey = errors.messages.join('\n');
  const [prevMessagesKey, setPrevMessagesKey] = useState(messagesKey);
  if (messagesKey !== prevMessagesKey) {
    setPrevMessagesKey(messagesKey);
    const before = new Set(prevMessagesKey.split('\n'));
    const fresh = errors.messages.filter((m) => !before.has(m));
    if (fresh.length > 0) announce(fresh.join('; '));
  }

  /** Records new local text and emits its normalised form when that changed. */
  const commitText = useCallback(
    (next: string, kind: QueryEditKind, emit = true) => {
      const prev = textRef.current;
      textRef.current = next;
      setText(next);
      const normalized = normalizeQuerySpacing(next);
      if (emit && normalized !== normalizeQuerySpacing(prev)) {
        setSyncedValue(normalized);
        onChange(normalized, kind);
      }
    },
    [onChange]
  );

  // The decoration layer scrolls its own (overflow-hidden) wrapper to the textarea's offset.
  // Scrolling rather than a transform keeps the pills on the same pixel-snapping path as the
  // remove button (a transformed layer can paint a sub-pixel off).
  const syncScroll = useCallback(() => {
    const el = textareaRef.current;
    const viewport = mirrorRef.current?.parentElement;
    if (el && viewport && viewport.scrollTop !== el.scrollTop) viewport.scrollTop = el.scrollTop;
  }, []);

  /** Anchors the suggestion popup under the first character of the token being completed. */
  const positionPopup = useCallback(() => {
    const popup = popupRef.current;
    const mirror = mirrorRef.current;
    const frame = frameRef.current;
    if (!popup || !mirror || !frame || anchor === null) return;
    const r = rectAtOffset(mirror, anchor);
    if (!r) return;
    const f = paddingOrigin(frame);
    popup.style.left = `${popupLeft(r.left - f.left, frame.clientWidth, POPUP_WIDTH_PX, POPUP_INSET_PX)}px`;
    popup.style.top = `${r.bottom - f.top + 2}px`;
  }, [anchor]);

  const measureBoxes = useCallback(() => {
    const mirror = mirrorRef.current;
    if (!mirror) return;
    const next = pillBoxes(glyphFragments(mirror), pillMetrics);
    setBoxes((prev) => (sameBoxes(prev, next) ? prev : next));
  }, [pillMetrics]);

  useLayoutEffect(() => {
    syncScroll();
    positionPopup();
    measureBoxes();
  });

  // Re-measure when the field's width changes (wrapping) and once web fonts have loaded.
  useEffect(() => {
    const mirror = mirrorRef.current;
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) measureBoxes();
    });
    if (!mirror || typeof ResizeObserver === 'undefined') {
      return () => {
        cancelled = true;
      };
    }
    const observer = new ResizeObserver(() => measureBoxes());
    observer.observe(mirror);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [measureBoxes]);

  useEffect(() => {
    document.addEventListener('selectionchange', syncScroll);
    return () => document.removeEventListener('selectionchange', syncScroll);
  }, [syncScroll]);

  // Native beforeinput (React's onBeforeInput has no inputType). Typed, pasted and deleted text
  // is planned against the display form so the control holds canonical display text after one
  // undoable edit: a space typed inside quotes lands as U+2005, a '-' as U+2011, typing or
  // deleting a quote re-maps later spaces in the same edit, and pasted newlines become spaces.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const onBeforeInput = (e: InputEvent) => {
      if (applyingRef.current || e.isComposing || composingRef.current) return;
      if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
        e.preventDefault();
        return;
      }
      const range = editRange(e.inputType, el.value, el.selectionStart, el.selectionEnd);
      if (!range) return; // Runs natively; the change handler re-syncs if needed.
      let data = '';
      if (e.inputType.startsWith('insert')) {
        const d = e.data ?? e.dataTransfer?.getData('text/plain') ?? null;
        if (d === null) return;
        data = d;
      }
      const plan = planEdit(el.value, range.start, range.end, data);
      if (!plan) return;
      e.preventDefault();
      applyNativeEdit(el, plan, applyingRef);
    };
    el.addEventListener('beforeinput', onBeforeInput);
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  }, []);

  const readSelection = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    setSelection({ start: el.selectionStart, end: el.selectionEnd });
    syncScroll();
  }, [syncScroll]);

  /** Replaces [start, end) of the query text (offsets are equal in both forms) as one edit. */
  const replaceRange = (start: number, end: number, insert: string, caretAfter: number) => {
    const el = textareaRef.current;
    if (!el) return;
    const plan = planEdit(el.value, start, end, insert) ?? { start, end, insert, caret: caretAfter };
    applyNativeEdit(el, { ...plan, caret: caretAfter }, applyingRef);
    setSelection({ start: caretAfter, end: caretAfter });
  };

  const acceptSuggestion = (s: Suggestion, key: 'Enter' | 'Tab') => {
    const result = suggestions.result;
    if (!result) return;
    // Enter on a value finishes the clause: the caret moves past a separating space.
    const finish = s.kind !== 'key' && key === 'Enter';
    const spaceFollows = text[result.end] === ' ';
    const insert = finish && !spaceFollows ? `${s.insert} ` : s.insert;
    const caretAfter = result.start + insert.length + (finish && spaceFollows ? 1 : 0);
    replaceRange(result.start, result.end, insert, caretAfter);
  };

  // The hover x only exists at rest (the field is not focused), so removal edits the text
  // directly; focus and caret stay wherever they were.
  const removeClause = (index: number) => {
    const clause = parsed.clauses[index];
    if (!clause) return;
    setHover(null);
    commitText(removeClauseFromText(text, clause), 'edit');
    announce(`Removed ${clause.raw}`);
  };

  const clearAll = () => {
    setHover(null);
    const el = textareaRef.current;
    if (text !== '') {
      if (el && document.activeElement === el) {
        // Focused: one native edit, so Ctrl/Cmd+Z restores the query.
        silentRef.current = true;
        try {
          applyNativeEdit(el, { start: 0, end: el.value.length, insert: '', caret: 0 }, applyingRef);
        } finally {
          silentRef.current = false;
        }
      }
      commitText('', 'edit', false);
    }
    announce('Query cleared');
    if (onClear) {
      onClear();
    } else {
      onChange('', 'edit');
    }
  };

  const copySelection = (e: ClipboardEvent<HTMLTextAreaElement>): boolean => {
    const el = e.currentTarget;
    if (el.selectionStart === el.selectionEnd) return false;
    e.preventDefault();
    e.clipboardData.setData('text/plain', fromDisplay(el.value.slice(el.selectionStart, el.selectionEnd)));
    return true;
  };

  const textareaProps: QueryField['textareaProps'] = {
    value: display,
    onChange: (e) => {
      const el = e.target;
      const composing = composingRef.current;
      setComposedValue(composing ? el.value : null);
      const next = composing ? fromDisplay(el.value) : resync(el);
      const inputType = (e.nativeEvent as InputEvent).inputType ?? '';
      const kind: QueryEditKind = inputType.startsWith('history') ? 'edit' : 'typing';
      commitText(next, kind, !silentRef.current);
      setSelection({ start: el.selectionStart, end: el.selectionEnd });
    },
    onSelect: readSelection,
    onFocus: () => {
      setFocused(true);
      setHover(null);
      readSelection();
    },
    onBlur: () => {
      composingRef.current = false;
      setComposedValue(null);
      setFocused(false);
    },
    onScroll: () => {
      syncScroll();
      positionPopup();
      setHover(null);
    },
    onKeyDown: (e) => {
      if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (suggestions.onKeyDown(e, acceptSuggestion)) return;
      const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
      if (e.key === 'Enter') {
        // Never a newline. Plain Enter finishes the clause: the caret goes to the end.
        e.preventDefault();
        if (plain) {
          const el = e.currentTarget;
          el.setSelectionRange(el.value.length, el.value.length);
          readSelection();
        }
      } else if (e.key === 'Escape' && plain) {
        // Open suggestions were closed above; otherwise Escape leaves the field.
        e.preventDefault();
        e.currentTarget.blur();
      }
    },
    onCopy: (e) => {
      copySelection(e);
    },
    onCut: (e) => {
      const el = e.currentTarget;
      const { selectionStart: start, selectionEnd: end } = el;
      if (copySelection(e)) applyNativeEdit(el, { start, end, insert: '', caret: start }, applyingRef);
    },
    onCompositionStart: () => {
      composingRef.current = true;
    },
    onCompositionEnd: () => {
      composingRef.current = false;
      setComposedValue(null);
      const el = textareaRef.current;
      if (el) commitText(resync(el), 'typing');
    },
  };

  const frameProps: QueryField['frameProps'] = {
    onMouseMove: (e) => {
      if (focused) return;
      // On the remove button itself: keep the current hover (no flicker).
      if ((e.target as HTMLElement).closest('[data-remove-clause]')) return;
      const mirror = mirrorRef.current;
      if (!mirror) return;
      // Hit-test the painted pill boxes in the mirror's coordinates.
      const o = mirrorSpace(mirror);
      const index = pillAtPoint(
        boxFragments(boxes),
        (e.clientX - o.left) / o.zoom,
        (e.clientY - o.top) / o.zoom
      );
      if (index === null) {
        if (hover) setHover(null);
        return;
      }
      if (hover && hover.index === index && hover.text === text) return;
      setHover({ index, text });
    },
    onMouseLeave: () => setHover(null),
  };

  const textareaCallbackRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      textareaRef.current = el;
      setForwardedRef(inputRef, el);
    },
    [inputRef]
  );

  return {
    field: {
      ids: {
        listbox: `${baseId}-listbox`,
        option: `${baseId}-option`,
        description: `${baseId}-desc`,
      },
      text,
      display,
      parsed,
      errors,
      focused,
      caretClause,
      hover: hover && !focused && hover.text === text ? hover : null,
      boxes,
      suggestions,
      announcement,
      acceptSuggestion,
      removeClause,
      clearAll,
      textareaProps,
      frameProps,
    },
    refs: { textareaRef: textareaCallbackRef, frameRef, mirrorRef, popupRef },
  };
}
