import { describe, expect, it } from 'vitest';
import { parseQuery } from '../syntax';
import {
  NB_HYPHEN,
  THIN_SPACE,
  editRange,
  fromDisplay,
  normalizeInsert,
  planEdit,
  toDisplay,
  toPlaceholderDisplay,
} from '../displayText';

const T = THIN_SPACE;
const H = NB_HYPHEN;

/** Applies a plan (or the plain native edit when null) to `value`, like the browser would. */
function apply(value: string, start: number, end: number, data: string) {
  const plan = planEdit(value, start, end, data);
  if (!plan) {
    return { value: value.slice(0, start) + data + value.slice(end), caret: start + data.length, plan };
  }
  return { value: value.slice(0, plan.start) + plan.insert + value.slice(plan.end), caret: plan.caret, plan };
}

describe('toDisplay / fromDisplay', () => {
  it('swaps quoted spaces and every hyphen one unit for one unit and round-trips', () => {
    const text =
      'label:"needs triage","a b" milestone:"v1.33 (next)" "flaky test" -author:k8s-ci-robot';
    const shown = toDisplay(text);
    expect(shown.length).toBe(text.length);
    expect(shown).toBe(
      `label:"needs${T}triage","a${T}b" milestone:"v1.33${T}(next)" "flaky${T}test" ${H}author:k8s${H}ci${H}robot`
    );
    expect(fromDisplay(shown)).toBe(text);
  });

  it('keeps parser spans valid on the display string', () => {
    const text = 'label:"good first issue" -repo:a/b-c "x y"';
    const shown = toDisplay(text);
    for (const c of parseQuery(text).clauses) {
      expect(fromDisplay(shown.slice(c.start, c.end))).toBe(c.raw);
    }
  });

  it('follows the scanner: escapes inside quotes, unterminated quotes run to the end', () => {
    expect(toDisplay(String.raw`label:"a\" b" c`)).toBe(String.raw`label:"a\"` + T + 'b" c');
    expect(toDisplay(String.raw`label:"a\\" b`)).toBe(String.raw`label:"a\\" b`);
    expect(toDisplay('label:"open quote x y')).toBe(`label:"open${T}quote${T}x${T}y`);
  });

  it('leaves spaces outside quotes and other characters alone', () => {
    expect(toDisplay('is:open  label:bug')).toBe('is:open  label:bug');
    expect(toDisplay('')).toBe('');
  });

  it('round-trips arbitrary query text', () => {
    const samples = ['a "b c\\" d" e-f', '"', '\\"x y"', '-"a b"', 'x:"\u{1F600} y"'];
    for (const s of samples) {
      const shown = toDisplay(s);
      expect(shown.length).toBe(s.length);
      expect(fromDisplay(shown)).toBe(s);
    }
  });
});

describe('toPlaceholderDisplay', () => {
  it('turns every space into THIN_SPACE and keeps other characters', () => {
    expect(toPlaceholderDisplay('Filter or search, e.g. is:open  label:bug')).toBe(
      `Filter${T}or${T}search,${T}e.g.${T}is:open${T}${T}label:bug`
    );
    expect(fromDisplay(toPlaceholderDisplay('a b-c'))).toBe('a b-c');
  });
});

describe('normalizeInsert', () => {
  it('turns every run of line breaks into one space', () => {
    expect(normalizeInsert('a\nb\r\n\r\nc\u2028d')).toBe('a b c d');
  });
});

describe('planEdit', () => {
  it('returns null when the native edit is already canonical', () => {
    expect(planEdit(toDisplay('is:pr'), 5, 5, ' x')).toBeNull();
  });

  it('maps a typed space inside quotes and a typed hyphen in place', () => {
    const value = toDisplay('label:"needs" bug');
    expect(planEdit(value, 12, 12, ' ')).toEqual({ start: 12, end: 12, insert: T, caret: 13 });
    expect(planEdit(value, 13, 13, ' ')).toBeNull();
    expect(planEdit(value, 14, 14, '-')).toEqual({ start: 14, end: 14, insert: H, caret: 15 });
  });

  it('widens to one replacement when a typed quote re-maps later spaces', () => {
    const value = toDisplay('label:a bug x');
    const r = apply(value, 6, 6, '"');
    expect(r.value).toBe(toDisplay('label:"a bug x'));
    expect(r.plan).toMatchObject({ start: 6, end: 12 });
    expect(r.caret).toBe(7);
  });

  it('widens a deletion that closes quoting back to plain spaces', () => {
    const r = apply(toDisplay('label:"a b c'), 6, 7, '');
    expect(r.value).toBe('label:a b c');
    expect(r.caret).toBe(6);
  });

  it('converts pasted newlines and pasted hyphens', () => {
    expect(apply('', 0, 0, 'a\nb-c').value).toBe(`a b${H}c`);
    expect(apply('', 0, 0, 'a\r\n\r\nb').value).toBe('a b');
  });

  it('accepts already-display data without double mapping', () => {
    expect(planEdit(toDisplay('label:"x"'), 8, 8, T)).toBeNull();
  });

  it('always lands on the display form of the edited text', () => {
    const cases: Array<[string, number, number, string]> = [
      ['a b', 1, 1, '"'],
      ['"a b" c d', 0, 1, ''],
      ['label:"x y"', 10, 11, ' z"'],
      ['x', 1, 1, ' -y "p q'],
    ];
    for (const [text, start, end, data] of cases) {
      const value = toDisplay(text);
      const expected = toDisplay(text.slice(0, start) + data + text.slice(end));
      expect(apply(value, start, end, data).value).toBe(expected);
    }
  });
});

describe('editRange', () => {
  it('predicts single-unit deletions, including surrogate pairs', () => {
    expect(editRange('deleteContentBackward', 'ab', 2, 2)).toEqual({ start: 1, end: 2 });
    expect(editRange('deleteContentBackward', 'a\u{1F600}', 3, 3)).toEqual({ start: 1, end: 3 });
    expect(editRange('deleteContentForward', '\u{1F600}b', 0, 0)).toEqual({ start: 0, end: 2 });
    expect(editRange('deleteContentBackward', 'ab', 0, 0)).toBeNull();
    expect(editRange('deleteContentForward', 'ab', 2, 2)).toBeNull();
  });

  it('uses the selection for inserts, cuts and ranged deletes; defers everything else', () => {
    expect(editRange('insertText', 'abc', 1, 2)).toEqual({ start: 1, end: 2 });
    expect(editRange('insertFromPaste', 'abc', 3, 3)).toEqual({ start: 3, end: 3 });
    expect(editRange('deleteContentBackward', 'abc', 0, 2)).toEqual({ start: 0, end: 2 });
    expect(editRange('deleteByCut', 'abc', 0, 2)).toEqual({ start: 0, end: 2 });
    expect(editRange('deleteByCut', 'abc', 1, 1)).toBeNull();
    expect(editRange('deleteWordBackward', 'abc', 3, 3)).toBeNull();
    expect(editRange('insertFromDrop', 'abc', 3, 3)).toBeNull();
    expect(editRange('historyUndo', 'abc', 3, 3)).toBeNull();
  });
});
