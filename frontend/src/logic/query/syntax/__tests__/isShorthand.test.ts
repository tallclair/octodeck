import { describe, it, expect } from 'vitest';
import { Field } from '../../../../api/octodeck/v1/query_pb';
import { canonicalQuery, parseClause, parseQuery } from '../index';

const SHORTHAND_GOLDEN_TABLE: ReadonlyArray<{
  readonly input: string;
  readonly field: Field;
  readonly values: readonly string[];
  readonly negated: boolean;
  readonly canonical: string;
}> = [
  { input: 'is:open', field: Field.STATE, values: ['open'], negated: false, canonical: 'state:open' },
  { input: 'is:closed', field: Field.STATE, values: ['closed'], negated: false, canonical: 'state:closed' },
  { input: 'is:merged', field: Field.STATE, values: ['merged'], negated: false, canonical: 'state:merged' },
  { input: 'is:pr', field: Field.TYPE, values: ['pr'], negated: false, canonical: 'type:pr' },
  { input: 'is:issue', field: Field.TYPE, values: ['issue'], negated: false, canonical: 'type:issue' },
  { input: 'is:draft', field: Field.DRAFT, values: ['true'], negated: false, canonical: 'draft:true' },
  { input: 'is:tracked', field: Field.TRACKING, values: ['true'], negated: false, canonical: 'tracking:true' },
  { input: 'is:untracked', field: Field.TRACKING, values: ['false'], negated: false, canonical: 'tracking:false' },
  { input: 'is:starred', field: Field.STARRED, values: ['true'], negated: false, canonical: 'starred:true' },
  { input: 'is:new', field: Field.NEW, values: ['any'], negated: false, canonical: 'new:any' },
  { input: 'is:inbox', field: Field.TRIAGE, values: ['inbox'], negated: false, canonical: 'triage:inbox' },
  { input: 'is:acked', field: Field.TRIAGE, values: ['acked'], negated: false, canonical: 'triage:acked' },
  // Negated shorthands
  { input: '-is:draft', field: Field.DRAFT, values: ['true'], negated: true, canonical: '-draft:true' },
  { input: '-is:new', field: Field.NEW, values: ['any'], negated: true, canonical: '-new:any' },
  { input: '-is:open', field: Field.STATE, values: ['open'], negated: true, canonical: '-state:open' },
  // Same-field multi-value shorthands
  {
    input: 'is:open,merged',
    field: Field.STATE,
    values: ['open', 'merged'],
    negated: false,
    canonical: 'state:open,merged',
  },
  {
    input: 'is:tracked,untracked',
    field: Field.TRACKING,
    values: ['true', 'false'],
    negated: false,
    canonical: 'tracking:true,false',
  },
  {
    input: 'is:pr,issue',
    field: Field.TYPE,
    values: ['pr', 'issue'],
    negated: false,
    canonical: 'type:pr,issue',
  },
  {
    input: 'is:inbox,acked',
    field: Field.TRIAGE,
    values: ['inbox', 'acked'],
    negated: false,
    canonical: 'triage:inbox,acked',
  },
];

describe('is: shorthand expansion (§3.3)', () => {
  it.each(SHORTHAND_GOLDEN_TABLE)(
    'expands $input to $canonical',
    ({ input, field, values, negated, canonical }) => {
      const parsed = parseQuery(input);
      expect(parsed.issues).toEqual([]);
      expect(parsed.predicates).toEqual([{ field, values: [...values], negated }]);
      expect(canonicalQuery(input)).toBe(canonical);
    }
  );

  it('matches is: keys and values case-insensitively', () => {
    const parsed = parseQuery('IS:OPEN,MERGED -Is:Draft');
    expect(parsed.issues).toEqual([]);
    expect(parsed.predicates).toEqual([
      { field: Field.STATE, values: ['open', 'merged'], negated: false },
      { field: Field.DRAFT, values: ['true'], negated: true },
    ]);
  });

  it('rejects mixed-dimension is: clauses with mixed-is on the values span', () => {
    for (const raw of ['is:open,pr', '-is:draft,starred', 'is:new,inbox']) {
      const clause = parseClause(raw);
      expect(clause.status).toBe('error');
      expect(clause.predicate).toBeNull();
      const colonIdx = raw.indexOf(':');
      expect(clause.issue).toMatchObject({
        code: 'mixed-is',
        start: colonIdx + 1,
        end: raw.length,
      });
    }
  });

  it('rejects unknown is: values with invalid-value listing known shorthands', () => {
    for (const raw of ['is:locked', 'is:unmerged', 'is:open,locked']) {
      const clause = parseClause(raw);
      expect(clause.status).toBe('error');
      expect(clause.predicate).toBeNull();
      expect(clause.issue?.code).toBe('invalid-value');
      expect(clause.issue?.message).toContain('open');
      expect(clause.issue?.message).toContain('acked');
    }
  });
});
