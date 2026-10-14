// Display form of the query text shown by the query input's native <textarea> (and the
// decoration layer that draws the pills under it).
//
// A few characters are swapped 1:1 for look-alikes with different layout behaviour:
//
//  - U+0020 inside a quoted value -> U+2005 FOUR-PER-EM SPACE. CSS word-spacing only widens
//    word-separator characters (U+0020, U+00A0, ...), so the wide gutters between clauses come
//    from word-spacing while spaces inside quoted values keep a narrow, natural width.
//  - U+002D HYPHEN-MINUS -> U+2011 NON-BREAKING HYPHEN, so soft wrapping happens at spaces only
//    (a hyphen is a line-break opportunity; "k8s-ci-robot" would otherwise split mid-token).
//
// Every swap replaces one UTF-16 unit with one UTF-16 unit, so caret offsets, parser spans and
// selections are identical in both forms. The query text never contains the substitutes: every
// value read back from the control goes through fromDisplay().

export const THIN_SPACE = '\u2005';
export const NB_HYPHEN = '\u2011';

const mapChar = (ch: string, quoted: boolean): string => {
  if (ch === '-') return NB_HYPHEN;
  if (ch === ' ' && quoted) return THIN_SPACE;
  return ch;
};

/**
 * Display form of `text`. Quote tracking follows the scanner (syntax/scan.ts): inside quotes a
 * backslash consumes the next character, and an unterminated quote runs to the end.
 */
export function toDisplay(text: string): string {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote && ch === '\\') {
      out += ch;
      if (i + 1 < text.length) {
        i++;
        out += mapChar(text[i], true);
      }
      continue;
    }
    if (ch === '"') inQuote = !inQuote;
    out += mapChar(ch, inQuote);
  }
  return out;
}

/** Query text from a displayed value (inverse of toDisplay). */
export function fromDisplay(value: string): string {
  return value.replace(/[\u2005\u2011]/g, (ch) => (ch === THIN_SPACE ? ' ' : '-'));
}

/**
 * Display form of the control's placeholder: every space becomes THIN_SPACE so the textarea's
 * clause-gutter word spacing doesn't widen it into a gappy line. THIN_SPACE is Unicode white
 * space (Zs), so assistive technology still reads word breaks.
 */
export function toPlaceholderDisplay(text: string): string {
  return text.replace(/ /g, THIN_SPACE);
}

/** Inserted text: vertical whitespace collapses to single spaces (the query has no newlines). */
export function normalizeInsert(data: string): string {
  return data.replace(/[\r\n\u2028\u2029]+/g, ' ');
}

/** One native text replacement: replace [start, end) of the control's value, then put the caret. */
export interface EditPlan {
  readonly start: number;
  readonly end: number;
  readonly insert: string;
  readonly caret: number;
}

const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;

/**
 * The value range a `beforeinput` of `inputType` will replace, for the input types that can be
 * predicted from the selection alone (a textarea's beforeinput has no target ranges). Null for
 * everything else (drops, word and line deletions, history, IME): those run natively and the
 * change handler re-syncs the control afterwards.
 */
export function editRange(
  inputType: string,
  value: string,
  selStart: number,
  selEnd: number
): { start: number; end: number } | null {
  switch (inputType) {
    case 'insertText':
    case 'insertFromPaste':
    case 'insertReplacementText':
      return { start: selStart, end: selEnd };
    case 'deleteByCut':
      return selStart === selEnd ? null : { start: selStart, end: selEnd };
    case 'deleteContentBackward': {
      if (selStart !== selEnd) return { start: selStart, end: selEnd };
      if (selStart === 0) return null;
      const pair =
        selStart >= 2 &&
        isLowSurrogate(value.charCodeAt(selStart - 1)) &&
        isHighSurrogate(value.charCodeAt(selStart - 2));
      return { start: selStart - (pair ? 2 : 1), end: selStart };
    }
    case 'deleteContentForward': {
      if (selStart !== selEnd) return { start: selStart, end: selEnd };
      if (selStart >= value.length) return null;
      const pair =
        isHighSurrogate(value.charCodeAt(selStart)) && isLowSurrogate(value.charCodeAt(selStart + 1));
      return { start: selStart, end: selStart + (pair ? 2 : 1) };
    }
    default:
      return null;
  }
}

/**
 * Plans "replace [start, end) of the displayed `value` with `data`" so that the control ends up
 * holding the canonical display form after ONE replacement (one native undo step). Returns null
 * when the plain native edit already produces the canonical form.
 *
 * Usually the replacement is just [start, end) with `data` mapped (a space typed inside quotes
 * becomes THIN_SPACE, a typed '-' becomes NB_HYPHEN). Typing or deleting a quote or backslash can
 * change the quoting of later spaces; then the replacement widens to cover every changed unit.
 */
export function planEdit(value: string, start: number, end: number, data: string): EditPlan | null {
  const insertText = normalizeInsert(fromDisplay(data));
  const next = toDisplay(
    fromDisplay(value.slice(0, start)) + insertText + fromDisplay(value.slice(end))
  );
  if (value.slice(0, start) + data + value.slice(end) === next) return null;
  // Smallest window of `value` to replace: at least [start, end), widened to every changed unit.
  let prefix = 0;
  while (prefix < start && value[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(value.length - end, next.length - (start + insertText.length));
  while (
    suffix < maxSuffix &&
    value[value.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    start: prefix,
    end: value.length - suffix,
    insert: next.slice(prefix, next.length - suffix),
    caret: start + insertText.length,
  };
}
