import { describe, it, expect } from 'vitest';
import { Field } from '../../../../api/octodeck/v1/query_pb';
import type { ExprInit } from '../../expr';
import {
  QueryFormatError,
  canonicalQuery,
  formatPredicate,
  formatPredicates,
  formatQuery,
  formatTerm,
  formatValue,
} from '../index';

describe('formatValue and formatTerm', () => {
  it('leaves simple values bare and quotes values containing whitespace, commas, or quotes', () => {
    expect(formatValue('bug')).toBe('bug');
    expect(formatValue('kind/bug')).toBe('kind/bug');
    expect(formatValue('a\\b')).toBe('a\\b');
    expect(formatValue('good first issue')).toBe('"good first issue"');
    expect(formatValue('a,b')).toBe('"a,b"');
    expect(formatValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(formatValue('a b\\')).toBe('"a b\\\\"');
  });

  it('quotes terms with whitespace, quotes, leading "-", or qualifier-like prefix', () => {
    expect(formatTerm('flaky')).toBe('flaky');
    expect(formatTerm('12:30')).toBe('12:30');
    expect(formatTerm('a/b:c')).toBe('a/b:c');
    expect(formatTerm('a,b')).toBe('a,b');
    expect(formatTerm('flaky test')).toBe('"flaky test"');
    expect(formatTerm('-wip')).toBe('"-wip"');
    expect(formatTerm('-')).toBe('"-"');
    expect(formatTerm('label:bug')).toBe('"label:bug"');
    expect(formatTerm('https://github.com/a/b')).toBe('"https://github.com/a/b"');
    expect(formatTerm('TODO:')).toBe('"TODO:"');
  });
});

describe('formatPredicate, formatPredicates, and canonicalQuery', () => {
  it('formats qualifier and text predicates in canonical form', () => {
    expect(
      formatPredicates([
        { field: Field.STATE, values: ['OPEN'], negated: false },
        { field: Field.LABEL, values: ['good first issue', 'bug'], negated: true },
        { field: Field.AUTHOR, values: ['alice', '@ME'], negated: false },
        { field: Field.TEXT, values: ['crash'], negated: false },
        { field: Field.TEXT, values: ['-flag'], negated: true },
      ])
    ).toBe('state:open -label:"good first issue",bug author:alice,@me crash -"-flag"');
  });

  it('preserves leading @ on parsed author/assignee values so formatPredicate is identity on parser output', () => {
    expect(
      formatPredicate({ field: Field.AUTHOR, values: ['@alice'], negated: false })
    ).toBe('author:@alice');
    expect(canonicalQuery('author:@@alice')).toBe('author:@alice');
    expect(canonicalQuery('assignee:@@bob,@ME')).toBe('assignee:@bob,@me');
  });

  it('canonicalizes is: shorthands, extra spaces, and drops incomplete/error clauses', () => {
    expect(canonicalQuery('  is:open   is:pr   author:@alice   lable:x  label: ')).toBe(
      'state:open type:pr author:alice'
    );
  });

  it('throws QueryFormatError if given a negated in predicate', () => {
    expect(() =>
      formatPredicate({ field: Field.IN, values: ['title'], negated: true })
    ).toThrow(QueryFormatError);
  });
});

describe('formatQuery', () => {
  it('formats empty, single-predicate, and flat-AND expressions', () => {
    expect(formatQuery(undefined)).toBe('');
    expect(formatQuery({})).toBe('');
    expect(formatQuery({ kind: { case: 'and', value: { exprs: [] } } })).toBe('');

    const single: ExprInit = {
      kind: {
        case: 'predicate',
        value: { field: Field.REPO, values: ['kubernetes/kubernetes'], negated: false },
      },
    };
    expect(formatQuery(single)).toBe('repo:kubernetes/kubernetes');

    const flatAnd: ExprInit = {
      kind: {
        case: 'and',
        value: {
          exprs: [
            single,
            {
              kind: {
                case: 'predicate',
                value: { field: Field.TEXT, values: ['flaky test'], negated: false },
              },
            },
          ],
        },
      },
    };
    expect(formatQuery(flatAnd)).toBe('repo:kubernetes/kubernetes "flaky test"');
  });

  it('throws QueryFormatError with exact path for unsupported or invalid Expr trees', () => {
    const expectErrorPath = (expr: ExprInit, expectedPath: string) => {
      try {
        formatQuery(expr);
        expect.fail(`Expected QueryFormatError at path ${expectedPath}`);
      } catch (err) {
        expect(err).toBeInstanceOf(QueryFormatError);
        expect((err as QueryFormatError).path).toBe(expectedPath);
      }
    };

    expectErrorPath({ kind: { case: 'or', value: { exprs: [] } } }, 'or');
    expectErrorPath({ kind: { case: 'not', value: {} } }, 'not');
    expectErrorPath(
      {
        kind: {
          case: 'and',
          value: {
            exprs: [{ kind: { case: 'and', value: { exprs: [] } } }],
          },
        },
      },
      'and.exprs[0].and'
    );
    expectErrorPath(
      {
        kind: {
          case: 'and',
          value: {
            exprs: [
              {
                kind: {
                  case: 'predicate',
                  value: { field: Field.STATE, values: ['open'], negated: false },
                },
              },
              { kind: { case: 'or', value: { exprs: [] } } },
            ],
          },
        },
      },
      'and.exprs[1].or'
    );
    expectErrorPath(
      {
        kind: {
          case: 'predicate',
          value: { field: Field.IN, values: ['title'], negated: true },
        },
      },
      'predicate.negated'
    );
    expectErrorPath(
      {
        kind: {
          case: 'and',
          value: {
            exprs: [
              {
                kind: {
                  case: 'predicate',
                  value: { field: Field.TEXT, values: ['a', 'b'], negated: false },
                },
              },
            ],
          },
        },
      },
      'and.exprs[0].predicate.values'
    );
    expectErrorPath(
      {
        kind: {
          case: 'predicate',
          value: { field: Field.STATE, values: ['invalid'], negated: false },
        },
      },
      'predicate.values[0]'
    );
    expectErrorPath(
      {
        kind: {
          case: 'predicate',
          value: { field: Field.LABEL, values: [], negated: false },
        },
      },
      'predicate.values'
    );
    expectErrorPath(
      {
        kind: {
          case: 'predicate',
          value: { field: Field.LABEL, values: ['ok', ''], negated: false },
        },
      },
      'predicate.values[1]'
    );
  });
});
