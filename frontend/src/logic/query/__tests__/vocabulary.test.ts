import { describe, it, expect } from 'vitest';
import { Field } from '../../../api/octodeck/v1/query_pb';
import {
  FIELD_SPECS,
  IS_SHORTHAND,
  specForField,
  specForKey,
} from '../vocabulary';

// Authoritative closed sets documented on each Field enum value in api/octodeck/v1/query.proto.
const PROTO_CLOSED_SETS: Readonly<Partial<Record<Field, readonly string[]>>> = {
  [Field.TRIAGE]: ['inbox', 'acked', 'all'],
  [Field.STATE]: ['open', 'closed', 'merged'],
  [Field.TYPE]: ['pr', 'issue'],
  [Field.DRAFT]: ['true', 'false'],
  [Field.TRACKING]: ['true', 'false'],
  [Field.STARRED]: ['true', 'false'],
  [Field.NEW]: ['item', 'mention', 'comment', 'code', 'noise', 'any'],
  [Field.NO]: ['assignee', 'label', 'milestone'],
  [Field.IN]: ['title', 'body'],
};

const PROTO_OPEN_FIELDS: readonly Field[] = [
  Field.REPO,
  Field.ORG,
  Field.AUTHOR,
  Field.ASSIGNEE,
  Field.MILESTONE,
  Field.LABEL,
];

describe('vocabulary', () => {
  it('defines all 15 qualifier fields with unique keys and sequential canonical ranks', () => {
    expect(FIELD_SPECS).toHaveLength(15);
    expect(FIELD_SPECS.map((s) => s.rank)).toEqual(
      Array.from({ length: 15 }, (_, i) => i)
    );
    const keys = new Set(FIELD_SPECS.map((s) => s.key));
    expect(keys.size).toBe(15);

    for (const spec of FIELD_SPECS) {
      expect(specForKey(spec.key)).toBe(spec);
      expect(specForField(spec.field)).toBe(spec);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it('matches the closed sets and open fields documented in api/octodeck/v1/query.proto', () => {
    for (const [fieldStr, expected] of Object.entries(PROTO_CLOSED_SETS)) {
      const field = Number(fieldStr) as Field;
      const spec = specForField(field);
      expect(spec, `missing spec for Field.${Field[field]}`).toBeDefined();
      expect(spec?.closed).toEqual(expected);
    }

    for (const field of PROTO_OPEN_FIELDS) {
      const spec = specForField(field);
      expect(spec, `missing spec for Field.${Field[field]}`).toBeDefined();
      expect(spec?.closed).toBeUndefined();
    }
  });

  it('marks only the in: qualifier as non-negatable', () => {
    for (const spec of FIELD_SPECS) {
      expect(spec.negatable).toBe(spec.field !== Field.IN);
    }
  });

  it('maps every is: shorthand to a known closed field and legal closed value', () => {
    expect(Object.keys(IS_SHORTHAND)).toEqual([
      'open',
      'closed',
      'merged',
      'pr',
      'issue',
      'draft',
      'tracked',
      'untracked',
      'starred',
      'new',
      'inbox',
      'acked',
    ]);

    for (const [shorthand, target] of Object.entries(IS_SHORTHAND)) {
      const spec = specForField(target.field);
      expect(spec, `shorthand is:${shorthand} targets unknown field`).toBeDefined();
      expect(spec?.closed, `shorthand is:${shorthand} targets open field`).toContain(
        target.value
      );
    }
  });
});
