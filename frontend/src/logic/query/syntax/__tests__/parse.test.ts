import { describe, it, expect } from 'vitest';
import { Field } from '../../../../api/octodeck/v1/query_pb';
import { parseClause, parseQuery, scan, segmentClause } from '../index';

describe('scan and parseQuery grammar', () => {
  it('parses empty and whitespace-only strings to empty results', () => {
    for (const input of ['', '   ', '\t\n  ']) {
      const parsed = parseQuery(input);
      expect(parsed.clauses).toEqual([]);
      expect(parsed.predicates).toEqual([]);
      expect(parsed.clauseOfPredicate).toEqual([]);
      expect(parsed.issues).toEqual([]);
    }
  });

  it('parses qualifiers, comma-separated OR values, negations, and bare/quoted terms', () => {
    const query = 'state:open,closed -label:"good first issue",bug "exact phrase" -wip --flag 12:30 a,b';
    const parsed = parseQuery(query);
    expect(parsed.issues).toEqual([]);
    expect(parsed.predicates).toEqual([
      { field: Field.STATE, values: ['open', 'closed'], negated: false },
      { field: Field.LABEL, values: ['good first issue', 'bug'], negated: true },
      { field: Field.TEXT, values: ['exact phrase'], negated: false },
      { field: Field.TEXT, values: ['wip'], negated: true },
      { field: Field.TEXT, values: ['-flag'], negated: true },
      { field: Field.TEXT, values: ['12:30'], negated: false },
      { field: Field.TEXT, values: ['a,b'], negated: false },
    ]);
    expect(parsed.clauseOfPredicate).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('matches closed-set values case-insensitively and stores them lower-cased', () => {
    const parsed = parseQuery('STATE:OPEN,Merged Type:PR TRIAGE:ACKED');
    expect(parsed.issues).toEqual([]);
    expect(parsed.predicates).toEqual([
      { field: Field.STATE, values: ['open', 'merged'], negated: false },
      { field: Field.TYPE, values: ['pr'], negated: false },
      { field: Field.TRIAGE, values: ['acked'], negated: false },
    ]);
  });

  it('handles quote escapes including values ending in backslash and forgiving \\x escapes', () => {
    // label:"a b\\" closes its quote after the escaped backslash
    const trailingSlash = parseQuery('label:"a b\\\\" state:open');
    expect(trailingSlash.issues).toEqual([]);
    expect(trailingSlash.clauses).toHaveLength(2);
    expect(trailingSlash.clauses[0].raw).toBe('label:"a b\\\\"');
    expect(trailingSlash.predicates).toEqual([
      { field: Field.LABEL, values: ['a b\\'], negated: false },
      { field: Field.STATE, values: ['open'], negated: false },
    ]);

    // \" unescapes to " and \x is kept literally as \x
    const escapes = parseQuery('label:"say \\"hi\\" \\x" "term\\y\\\\"');
    expect(escapes.issues).toEqual([]);
    expect(escapes.predicates).toEqual([
      { field: Field.LABEL, values: ['say "hi" \\x'], negated: false },
      { field: Field.TEXT, values: ['term\\y\\'], negated: false },
    ]);

    // Backslashes outside quotes are ordinary characters
    const outsideQuotes = parseQuery('foo\\ bar\\baz');
    expect(outsideQuotes.issues).toEqual([]);
    expect(outsideQuotes.predicates).toEqual([
      { field: Field.TEXT, values: ['foo\\'], negated: false },
      { field: Field.TEXT, values: ['bar\\baz'], negated: false },
    ]);
  });

  it('strips one leading @ on author and assignee except @me (case-insensitive)', () => {
    const a1 = parseQuery('author:@alice');
    const a2 = parseQuery('author:alice');
    expect(a1.predicates).toEqual([{ field: Field.AUTHOR, values: ['alice'], negated: false }]);
    expect(a1.predicates).toEqual(a2.predicates);

    const me = parseQuery('author:@me,@ME,@@bob assignee:@Me,@carol,dave');
    expect(me.issues).toEqual([]);
    expect(me.predicates).toEqual([
      { field: Field.AUTHOR, values: ['@me', '@me', '@bob'], negated: false },
      { field: Field.ASSIGNEE, values: ['@me', 'carol', 'dave'], negated: false },
    ]);
  });

  it('attaches informational notes for triage:all and item-number terms (#123 and 123)', () => {
    const parsed = parseQuery('triage:all #123 456 "789" normal');
    expect(parsed.issues).toEqual([]);
    expect(parsed.clauses[0].note).toBe('= inbox,acked');
    expect(parsed.clauses[1].note).toBe('Also matches item number 123');
    expect(parsed.clauses[2].note).toBe('Also matches item number 456');
    expect(parsed.clauses[3].note).toBe('Also matches item number 789');
    expect(parsed.clauses[4].note).toBeUndefined();
  });

  it('splits "- \\"x\\"" with a space into a lone-dash clause and a term clause', () => {
    const parsed = parseQuery('- "x"');
    expect(parsed.clauses).toHaveLength(2);
    expect(parsed.clauses[0].status).toBe('incomplete');
    expect(parsed.clauses[0].issue).toMatchObject({
      code: 'lone-dash',
      start: 0,
      end: 1,
    });
    expect(parsed.clauses[1].status).toBe('ok');
    expect(parsed.clauses[1].predicate).toEqual({
      field: Field.TEXT,
      values: ['x'],
      negated: false,
    });
    expect(parsed.predicates).toEqual([
      { field: Field.TEXT, values: ['x'], negated: false },
    ]);
    expect(parsed.clauseOfPredicate).toEqual([1]);
  });
});

describe('all 10 IssueCodes and exact UTF-16 spans', () => {
  it('reports missing-value with a zero-width span after the colon', () => {
    const c = parseClause('label:');
    expect(c.status).toBe('incomplete');
    expect(c.predicate).toBeNull();
    expect(c.issue).toEqual({
      code: 'missing-value',
      start: 6,
      end: 6,
      message: 'Missing value for label:',
    });
  });

  it('reports empty-value for trailing comma, consecutive commas, and empty quotes', () => {
    const trailing = parseClause('label:a,');
    expect(trailing.status).toBe('incomplete');
    expect(trailing.issue).toMatchObject({
      code: 'empty-value',
      start: 8,
      end: 8,
    });

    const middle = parseClause('label:a,,b');
    expect(middle.status).toBe('incomplete');
    expect(middle.issue).toMatchObject({
      code: 'empty-value',
      start: 8,
      end: 8,
    });

    const quotedEmpty = parseClause('label:""');
    expect(quotedEmpty.status).toBe('incomplete');
    expect(quotedEmpty.issue).toMatchObject({
      code: 'empty-value',
      start: 6,
      end: 8,
    });

    const bareAt = parseClause('author:@');
    expect(bareAt.status).toBe('incomplete');
    expect(bareAt.predicate).toBeNull();
    expect(bareAt.issue).toEqual({
      code: 'empty-value',
      start: 7,
      end: 8,
      message: 'Empty value for author:',
    });

    const quotedAt = parseClause('assignee:"@"');
    expect(quotedAt.status).toBe('incomplete');
    expect(quotedAt.predicate).toBeNull();
    expect(quotedAt.issue).toEqual({
      code: 'empty-value',
      start: 9,
      end: 12,
      message: 'Empty value for assignee:',
    });

    const listAt = parseClause('author:alice,@');
    expect(listAt.status).toBe('incomplete');
    expect(listAt.predicate).toBeNull();
    expect(listAt.issue).toEqual({
      code: 'empty-value',
      start: 13,
      end: 14,
      message: 'Empty value for author:',
    });
  });

  it('reports unterminated-quote from the opening quote to the end of the clause', () => {
    const qual = parseClause('label:bug,"good first');
    expect(qual.status).toBe('incomplete');
    expect(qual.issue).toMatchObject({
      code: 'unterminated-quote',
      start: 10,
      end: 21,
    });

    const term = parseClause('-"hello world');
    expect(term.status).toBe('incomplete');
    expect(term.issue).toMatchObject({
      code: 'unterminated-quote',
      start: 1,
      end: 13,
    });
  });

  it('reports lone-dash on a bare "-" clause', () => {
    const parsed = parseQuery('state:open - label:bug');
    expect(parsed.clauses[1].status).toBe('incomplete');
    expect(parsed.clauses[1].issue).toMatchObject({
      code: 'lone-dash',
      start: 11,
      end: 12,
    });
    expect(parsed.clauseOfPredicate).toEqual([0, 2]);
  });

  it('reports unknown-key on the key span and suggests quoting (including URLs and TODO:)', () => {
    const typo = parseClause('-lable:bug');
    expect(typo.status).toBe('error');
    expect(typo.issue).toEqual({
      code: 'unknown-key',
      start: 1,
      end: 6,
      message: 'lable is not a known filter. Quote it to search for the text: -"lable:bug"',
    });

    const negUnknown = parseClause('-foo:x');
    expect(negUnknown.status).toBe('error');
    expect(negUnknown.issue).toEqual({
      code: 'unknown-key',
      start: 1,
      end: 4,
      message: 'foo is not a known filter. Quote it to search for the text: -"foo:x"',
    });

    const quotedValUnknown = parseClause('foo:"a b"');
    expect(quotedValUnknown.status).toBe('error');
    expect(quotedValUnknown.issue).toEqual({
      code: 'unknown-key',
      start: 0,
      end: 3,
      message: 'foo is not a known filter. Quote it to search for the text: "foo:\\"a b\\""',
    });

    const url = parseClause('https://github.com/org/repo');
    expect(url.status).toBe('error');
    expect(url.issue).toEqual({
      code: 'unknown-key',
      start: 0,
      end: 5,
      message:
        'https is not a known filter. Quote it to search for the text: "https://github.com/org/repo"',
    });
  });

  it('reports invalid-value on each offending ValueNode and names allowed values', () => {
    const badState = parseClause('state:open,opened,invalid');
    expect(badState.status).toBe('error');
    expect(badState.values.map((v) => v.invalid)).toEqual([false, true, true]);
    expect(badState.issue).toEqual({
      code: 'invalid-value',
      start: 11,
      end: 17,
      message: 'state must be open, closed or merged',
    });
  });

  it('reports mixed-is covering the values span when is: mixes fields', () => {
    const mixed = parseClause('is:open,pr');
    expect(mixed.status).toBe('error');
    expect(mixed.issue).toMatchObject({
      code: 'mixed-is',
      start: 3,
      end: 10,
    });
  });

  it('reports negated-in on the leading "-" when in: is negated', () => {
    const negIn = parseClause('-in:title');
    expect(negIn.status).toBe('error');
    expect(negIn.issue).toEqual({
      code: 'negated-in',
      start: 0,
      end: 1,
      message: 'in: cannot be negated',
    });
  });

  it('reports bad-quote across the whole clause for partial quotes in values or terms', () => {
    const badVal = parseClause('label:"a"b');
    expect(badVal.status).toBe('error');
    expect(badVal.issue).toEqual({
      code: 'bad-quote',
      start: 0,
      end: 10,
      message: 'Quotes must surround the whole value',
    });

    const badTerm = parseClause('fla"ky');
    expect(badTerm.status).toBe('error');
    expect(badTerm.issue).toEqual({
      code: 'bad-quote',
      start: 0,
      end: 6,
      message: 'Quotes must surround the whole term',
    });
  });

  it('reports empty-term on "" and -""', () => {
    for (const raw of ['""', '-""']) {
      const c = parseClause(raw);
      expect(c.status).toBe('error');
      expect(c.issue).toEqual({
        code: 'empty-term',
        start: 0,
        end: raw.length,
        message: 'Empty search term',
      });
    }
  });

  it('maintains exact UTF-16 code-unit spans in the presence of surrogate pairs (emoji)', () => {
    const text = 'label:"🔥 bug" lable:x';
    const parsed = parseQuery(text);
    expect(parsed.clauses).toHaveLength(2);
    expect(text.slice(parsed.clauses[0].start, parsed.clauses[0].end)).toBe('label:"🔥 bug"');
    expect(text.slice(parsed.clauses[1].start, parsed.clauses[1].end)).toBe('lable:x');
    expect(parsed.issues).toHaveLength(1);
    const issue = parsed.issues[0];
    expect(text.slice(issue.start, issue.end)).toBe('lable');
  });
});

describe('segmentClause', () => {
  it('segments ok, negated, badkey, and badvalue clauses contiguously', () => {
    const negQual = parseClause('-label:bug,flake');
    expect(segmentClause(negQual)).toEqual([
      { start: 0, end: 1, role: 'neg' },
      { start: 1, end: 6, role: 'key' },
      { start: 6, end: 7, role: 'colon' },
      { start: 7, end: 10, role: 'value' },
      { start: 10, end: 11, role: 'comma' },
      { start: 11, end: 16, role: 'value' },
    ]);

    const badKey = parseClause('lable:bug');
    expect(segmentClause(badKey)).toEqual([
      { start: 0, end: 5, role: 'badkey' },
      { start: 5, end: 6, role: 'colon' },
      { start: 6, end: 9, role: 'value' },
    ]);

    const badVal = parseClause('state:open,nope');
    expect(segmentClause(badVal)).toEqual([
      { start: 0, end: 5, role: 'key' },
      { start: 5, end: 6, role: 'colon' },
      { start: 6, end: 10, role: 'value' },
      { start: 10, end: 11, role: 'comma' },
      { start: 11, end: 15, role: 'badvalue' },
    ]);

    const negTerm = parseClause('-flaky');
    expect(segmentClause(negTerm)).toEqual([
      { start: 0, end: 1, role: 'neg' },
      { start: 1, end: 6, role: 'text' },
    ]);

    expect(scan('  a   "b c"  ').map((s) => s.raw)).toEqual(['a', '"b c"']);
  });
});
