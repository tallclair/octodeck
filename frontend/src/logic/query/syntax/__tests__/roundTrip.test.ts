import { describe, it, expect } from 'vitest';
import { Field } from '../../../../api/octodeck/v1/query_pb';
import type { FilterPredicate } from '../../../../types/filters';
import { FIELD_SPECS, IS_SHORTHAND } from '../../vocabulary';
import {
  canonicalQuery,
  formatPredicate,
  formatPredicates,
  parseQuery,
  segmentClause,
} from '../index';

/** Deterministic mulberry32 PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADVERSARIAL_OPEN_VALUES: readonly string[] = [
  'simple',
  'kubernetes/kubernetes',
  'good first issue',
  'a b\\',
  'trailing\\\\',
  '\\leading',
  'a\\xb',
  'quote"inside',
  '"surrounded"',
  'comma,inside',
  'a, b, "c"\\',
  '-leading-dash',
  '-',
  'label:looking',
  'https://github.com/org/repo',
  'TODO:',
  '12:30',
  '#123',
  '456',
  '🔥',
  '🔥 bug 🚀',
  '日本語テスト',
  'café\\☕"',
];

const ADVERSARIAL_USER_VALUES: readonly string[] = [
  'alice',
  'bob-smith',
  '@me',
  'dependabot[bot]',
  'user with space',
  'user\\slash',
];

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function randomPredicate(rng: () => number): FilterPredicate {
  // Include all 15 qualifier fields plus Field.TEXT
  const useText = rng() < 0.2;
  if (useText) {
    return {
      field: Field.TEXT,
      values: [pick(rng, ADVERSARIAL_OPEN_VALUES)],
      negated: rng() < 0.3,
    };
  }

  const spec = pick(rng, FIELD_SPECS);
  const negated = spec.negatable ? rng() < 0.3 : false;
  const count = 1 + Math.floor(rng() * 3);
  const values: string[] = [];

  for (let i = 0; i < count; i++) {
    if (spec.closed) {
      values.push(pick(rng, spec.closed));
    } else if (spec.field === Field.AUTHOR || spec.field === Field.ASSIGNEE) {
      values.push(pick(rng, ADVERSARIAL_USER_VALUES));
    } else {
      values.push(pick(rng, ADVERSARIAL_OPEN_VALUES));
    }
  }

  return { field: spec.field, values, negated };
}

function randomValidQueryText(rng: () => number): string {
  const clauseCount = Math.floor(rng() * 6);
  const parts: string[] = [];
  for (let i = 0; i < clauseCount; i++) {
    if (rng() < 0.2) {
      const shorthands = Object.keys(IS_SHORTHAND);
      const key = pick(rng, shorthands);
      const neg = rng() < 0.25 ? '-' : '';
      parts.push(`${neg}is:${key}`);
    } else if (rng() < 0.15) {
      const login = pick(rng, ['alice', 'bob', 'me']);
      parts.push(`author:@${login}`);
    } else {
      parts.push(formatPredicate(randomPredicate(rng)));
    }
  }
  const ws = () => ' '.repeat(1 + Math.floor(rng() * 3));
  return (rng() < 0.3 ? '  ' : '') + parts.join(ws()) + (rng() < 0.3 ? '  ' : '');
}

function assertSpansInvariant(text: string): void {
  const parsed = parseQuery(text);
  const covered = new Array<number>(text.length).fill(-1);

  for (let i = 0; i < parsed.clauses.length; i++) {
    const c = parsed.clauses[i];
    expect(c.start).toBeGreaterThanOrEqual(0);
    expect(c.end).toBeGreaterThan(c.start);
    expect(c.end).toBeLessThanOrEqual(text.length);
    if (i > 0) {
      expect(c.start).toBeGreaterThan(parsed.clauses[i - 1].end);
    }
    expect(text.slice(c.start, c.end)).toBe(c.raw);

    for (let pos = c.start; pos < c.end; pos++) {
      covered[pos] = i;
    }

    if (c.issue) {
      expect(c.issue.start).toBeGreaterThanOrEqual(c.start);
      expect(c.issue.end).toBeGreaterThanOrEqual(c.issue.start);
      expect(c.issue.end).toBeLessThanOrEqual(c.end);
    }

    // Verify segmentClause covers [c.start, c.end) contiguously
    const segments = segmentClause(c);
    let cursor = c.start;
    for (const seg of segments) {
      expect(seg.start).toBe(cursor);
      expect(seg.end).toBeGreaterThan(seg.start);
      cursor = seg.end;
    }
    expect(cursor).toBe(c.end);
  }

  for (let pos = 0; pos < text.length; pos++) {
    if (covered[pos] === -1) {
      expect(/\s/.test(text[pos])).toBe(true);
    }
  }
}

describe('Round-trip and span properties (§3.7)', () => {
  it('P-struct: parseQuery(formatPredicates(L)).predicates deep-equals L across 500 seeded cases', () => {
    const rng = mulberry32(0x20261013);
    for (let i = 0; i < 500; i++) {
      const length = Math.floor(rng() * 6);
      const list: FilterPredicate[] = Array.from({ length }, () => randomPredicate(rng));
      const formatted = formatPredicates(list);
      const parsed = parseQuery(formatted);
      expect(parsed.issues, `case ${i}: ${formatted}`).toEqual([]);
      expect(parsed.predicates, `case ${i}: ${formatted}`).toEqual(list);
    }
  });

  it('P-canon: canonicalQuery preserves semantics and is idempotent across 500 seeded cases', () => {
    const rng = mulberry32(0xdecafbad);
    for (let i = 0; i < 500; i++) {
      const t = randomValidQueryText(rng);
      const parsedT = parseQuery(t);
      expect(parsedT.issues, `case ${i}: ${t}`).toEqual([]);

      const c = canonicalQuery(t);
      const parsedC = parseQuery(c);
      expect(parsedC.issues).toEqual([]);
      expect(parsedC.predicates).toEqual(parsedT.predicates);
      expect(canonicalQuery(c)).toBe(c);
    }

    // author:@@alice parses to value '@alice' and formats as 'author:@alice'
    const doubleAt = parseQuery('author:@@alice');
    expect(doubleAt.issues).toEqual([]);
    expect(doubleAt.predicates).toEqual([
      { field: Field.AUTHOR, values: ['@alice'], negated: false },
    ]);
    expect(formatPredicates(doubleAt.predicates)).toBe('author:@alice');
    expect(canonicalQuery('author:@@alice')).toBe('author:@alice');
  });

  it('P-spans: clause and issue spans satisfy ordering, slice identity, and coverage across 500 seeded cases (including broken inputs)', () => {
    const rng = mulberry32(0x12345678);
    const brokenFragments = [
      '-',
      'label:',
      'label:a,',
      'label:a,,b',
      'label:""',
      'author:@',
      'assignee:"@"',
      'lable:bug',
      'state:opened',
      'is:open,pr',
      'is:locked',
      '-in:title',
      'label:"a"b',
      'fla"ky',
      '""',
      '-""',
      'label:"unterminated 🔥',
    ];

    for (let i = 0; i < 500; i++) {
      const valid = randomValidQueryText(rng);
      const extra = rng() < 0.5 ? ` ${pick(rng, brokenFragments)} ` : '';
      const text = rng() < 0.5 ? `${valid}${extra}` : `${extra}${valid}`;
      assertSpansInvariant(text);
    }
  });
});
