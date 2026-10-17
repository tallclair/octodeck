import { describe, it, expect } from 'vitest';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { ExprSchema, Field, SortKey, SortOrder } from '../../../api/octodeck/v1/query_pb';
import { parseDashboardUrl } from '../urlCodec';
import { parseQuery } from '../syntax/parse';
import { ALL_ITEMS_QUERY, toExpr, toSort } from '../expr';

const pred = (field: Field, values: string[], negated = false) => ({
  kind: { case: 'predicate', value: { field, values, negated } },
});
const and = (...exprs: unknown[]) => ({ kind: { case: 'and', value: { exprs } } });

describe('toExpr', () => {
  it('sends the empty AND for the default state (the daemon adds triage:inbox)', () => {
    expect(toExpr(parseQuery(''))).toEqual(and());
  });

  it('turns the legacy example URL into the equivalent structured expression', () => {
    const { state } = parseDashboardUrl('?repo=a/b&author=x&triage=acked&state=closed&label=bug');
    expect(toExpr(parseQuery(state.text))).toEqual(
      and(
        pred(Field.REPO, ['a/b']),
        pred(Field.AUTHOR, ['x']),
        pred(Field.TRIAGE, ['acked']),
        pred(Field.STATE, ['closed']),
        pred(Field.LABEL, ['bug'])
      )
    );
  });

  it('expresses the New tab as new:any without a triage predicate', () => {
    const { state } = parseDashboardUrl('?triage=activity');
    expect(toExpr(parseQuery(state.text))).toEqual(and(pred(Field.NEW, ['any'])));
  });

  it('carries negation, multiple values, and negated terms unchanged', () => {
    expect(toExpr(parseQuery('label:a,b -author:bot -"do not merge"'))).toEqual(
      and(
        pred(Field.LABEL, ['a', 'b']),
        pred(Field.AUTHOR, ['bot'], true),
        pred(Field.TEXT, ['do not merge'], true)
      )
    );
  });

  it('includes one TEXT predicate per search term alongside qualifier predicates and skips invalid clauses', () => {
    expect(toExpr(parseQuery('type:pr flaky "big test" #12 state:bogus repo:'))).toEqual(
      and(
        pred(Field.TYPE, ['pr']),
        pred(Field.TEXT, ['flaky']),
        pred(Field.TEXT, ['big test']),
        pred(Field.TEXT, ['#12'])
      )
    );
  });

  it('is deterministic and does not alias the parsed predicate arrays', () => {
    const parsed = parseQuery('label:a x');
    const first = toExpr(parsed);
    expect(toExpr(parsed)).toEqual(first);
    const firstPredicate = (
      first.kind as { value: { exprs: { kind: { value: { values: string[] } } }[] } }
    ).value.exprs[0];
    firstPredicate.kind.value.values.push('mutated');
    expect(parsed.predicates[0].values).toEqual(['a']);
  });

  it('produces a valid Expr message that survives binary encoding', () => {
    const { state } = parseDashboardUrl('?triage=all&-label=bug&label=a&label=b&q=foo');
    const msg = create(ExprSchema, toExpr(parseQuery(state.text)));
    const decoded = fromBinary(ExprSchema, toBinary(ExprSchema, msg));
    expect(decoded).toEqual(msg);
    expect(decoded.kind.case).toBe('and');
  });
});

describe('toSort', () => {
  it.each([
    ['updated', 'desc', SortKey.UPDATED, SortOrder.DESC],
    ['updated', 'asc', SortKey.UPDATED, SortOrder.ASC],
    ['acked', 'desc', SortKey.ACKED, SortOrder.DESC],
    ['acked', 'asc', SortKey.ACKED, SortOrder.ASC],
    ['created', 'desc', SortKey.CREATED, SortOrder.DESC],
    ['created', 'asc', SortKey.CREATED, SortOrder.ASC],
  ] as const)('maps %s/%s to an explicit Sort', (sort, order, key, protoOrder) => {
    expect(toSort(sort, order)).toEqual({ key, order: protoOrder });
  });
});

describe('shared expressions', () => {
  it('ALL_ITEMS_QUERY is triage:all', () => {
    expect(ALL_ITEMS_QUERY).toEqual(pred(Field.TRIAGE, ['all']));
  });
});
