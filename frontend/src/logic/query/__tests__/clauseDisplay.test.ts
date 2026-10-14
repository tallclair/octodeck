import { describe, expect, it } from 'vitest';
import {
  clauseIndexAt,
  clauseRemovalRange,
  clauseTone,
  hasBadSegment,
  normalizeQuerySpacing,
} from '../clauseDisplay';
import { parseQuery, segmentClause } from '../syntax';
import { removeClause } from '../textEdit';

const clausesOf = (text: string) => parseQuery(text).clauses;

describe('clauseTone', () => {
  it('distinguishes ok, negated, error, incomplete and free-text terms', () => {
    const [ok, neg, err, inc, term, negTerm] = clausesOf('is:open -label:bug lable:x label: flaky -wip');
    expect(clauseTone(ok, false)).toBe('ok');
    expect(clauseTone(neg, false)).toBe('negated');
    expect(clauseTone(err, false)).toBe('error');
    expect(clauseTone(inc, false)).toBe('incomplete');
    expect(clauseTone(term, false)).toBe('term');
    expect(clauseTone(negTerm, false)).toBe('negatedTerm');
  });

  it('shows an incomplete clause neutrally while the caret is inside it', () => {
    const [inc] = clausesOf('label:');
    expect(clauseTone(inc, true)).toBe('draft');
    // Errors stay errors even under the caret.
    const [err] = clausesOf('lable:x');
    expect(clauseTone(err, true)).toBe('error');
  });

  it('marks a valid clause with a server error as an error', () => {
    const [ok] = clausesOf('state:merged');
    expect(clauseTone(ok, false, true)).toBe('error');
  });
});

describe('clauseIndexAt', () => {
  const parsed = parseQuery('is:open  label:bug');
  it('treats both clause edges as inside', () => {
    expect(clauseIndexAt(parsed, 0)).toBe(0);
    expect(clauseIndexAt(parsed, 7)).toBe(0);
    expect(clauseIndexAt(parsed, 9)).toBe(1);
    expect(clauseIndexAt(parsed, 18)).toBe(1);
  });
  it('returns -1 in whitespace between clauses and in empty text', () => {
    expect(clauseIndexAt(parsed, 8)).toBe(-1);
    expect(clauseIndexAt(parseQuery(''), 0)).toBe(-1);
  });
});

describe('clauseRemovalRange', () => {
  it('splices to exactly what removeClause produces', () => {
    const texts = ['a b c', 'a  b   c', 'only', ' lead x', 'x trail ', 'label:"a b" -c d'];
    for (const text of texts) {
      for (const clause of clausesOf(text)) {
        const r = clauseRemovalRange(text, clause);
        expect(text.slice(0, r.start) + text.slice(r.end)).toBe(removeClause(text, clause));
      }
    }
  });
});

describe('hasBadSegment', () => {
  it('detects a bad key or value segment', () => {
    const [badKey, badValue, missing] = clausesOf('lable:x state:nope label:');
    expect(hasBadSegment(segmentClause(badKey))).toBe(true);
    expect(hasBadSegment(segmentClause(badValue))).toBe(true);
    expect(hasBadSegment(segmentClause(missing))).toBe(false);
  });
});

describe('normalizeQuerySpacing', () => {
  it('collapses clause whitespace and trims the ends, keeping quoted spaces', () => {
    expect(normalizeQuerySpacing('  is:open   label:"a  b"  ')).toBe('is:open label:"a  b"');
    expect(normalizeQuerySpacing('   ')).toBe('');
  });
});
