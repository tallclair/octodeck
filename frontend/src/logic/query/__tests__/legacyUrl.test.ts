import { describe, it, expect } from 'vitest';
import { Field } from '../../../api/octodeck/v1/query_pb';
import type { FilterPredicate } from '../../../types/filters';
import { parseLegacyParams } from '../legacyUrl';

const p = (field: Field, values: string[], negated = false): FilterPredicate => ({ field, values, negated });

const AC_URL = 'repo=a/b&author=x&triage=acked&state=closed&label=bug';

describe('parseLegacyParams', () => {
  it('returns empty predicates for empty or tail-only input', () => {
    expect(parseLegacyParams('')).toEqual([]);
    expect(parseLegacyParams('?')).toEqual([]);
    expect(parseLegacyParams(new URLSearchParams())).toEqual([]);
    expect(parseLegacyParams('?q=foo&sort=created&order=asc&item=PR_1')).toEqual([]);
  });

  it('parses the legacy example URL into predicates in URL order', () => {
    expect(parseLegacyParams(`?${AC_URL}`)).toEqual([
      p(Field.REPO, ['a/b']),
      p(Field.AUTHOR, ['x']),
      p(Field.TRIAGE, ['acked']),
      p(Field.STATE, ['closed']),
      p(Field.LABEL, ['bug']),
    ]);
  });

  it('accepts percent-encoded slashes in legacy links', () => {
    expect(parseLegacyParams('?repo=kubernetes%2Fkubernetes')).toEqual([p(Field.REPO, ['kubernetes/kubernetes'])]);
  });

  it('maps the triage tabs', () => {
    expect(parseLegacyParams('?triage=inbox')).toEqual([]);
    expect(parseLegacyParams('?triage=acked')).toEqual([p(Field.TRIAGE, ['acked'])]);
    expect(parseLegacyParams('?triage=all')).toEqual([p(Field.TRIAGE, ['all'])]);
    expect(parseLegacyParams('?triage=ACKED')).toEqual([p(Field.TRIAGE, ['acked'])]);
    expect(parseLegacyParams('?triage=bogus')).toEqual([]);
    expect(parseLegacyParams('?triage=')).toEqual([]);
  });

  it('maps triage=activity to new:any with no triage predicate', () => {
    expect(parseLegacyParams('?triage=activity')).toEqual([p(Field.NEW, ['any'])]);
  });

  it('parses state, ignoring the legacy all sentinel and invalid values', () => {
    expect(parseLegacyParams('?state=open')).toEqual([p(Field.STATE, ['open'])]);
    expect(parseLegacyParams('?state=closed')).toEqual([p(Field.STATE, ['closed'])]);
    expect(parseLegacyParams('?state=merged')).toEqual([p(Field.STATE, ['merged'])]);
    expect(parseLegacyParams('?state=all')).toEqual([]);
    expect(parseLegacyParams('?state=invalid')).toEqual([]);
  });

  it('parses type', () => {
    expect(parseLegacyParams('?type=pr')).toEqual([p(Field.TYPE, ['pr'])]);
    expect(parseLegacyParams('?type=issue')).toEqual([p(Field.TYPE, ['issue'])]);
    expect(parseLegacyParams('?type=all')).toEqual([]);
    expect(parseLegacyParams('?type=other')).toEqual([]);
  });

  it('maps assigned=me to assignee:@me and reads assignee= verbatim', () => {
    expect(parseLegacyParams('?assigned=me')).toEqual([p(Field.ASSIGNEE, ['@me'])]);
    expect(parseLegacyParams('?assigned=all')).toEqual([]);
    expect(parseLegacyParams('?assigned=other')).toEqual([]);
    expect(parseLegacyParams('?assignee=bob')).toEqual([p(Field.ASSIGNEE, ['bob'])]);
    expect(parseLegacyParams('?assignee=@')).toEqual([]);
    expect(parseLegacyParams('?assignee=bob&assigned=me')).toEqual([
      p(Field.ASSIGNEE, ['bob']),
      p(Field.ASSIGNEE, ['@me']),
    ]);
    expect(parseLegacyParams('?assigned=me&assignee=@me')).toEqual([p(Field.ASSIGNEE, ['@me'])]);
  });

  it('maps tracking to a boolean', () => {
    expect(parseLegacyParams('?tracking=tracked')).toEqual([p(Field.TRACKING, ['true'])]);
    expect(parseLegacyParams('?tracking=untracked')).toEqual([p(Field.TRACKING, ['false'])]);
    expect(parseLegacyParams('?tracking=TRACKED')).toEqual([p(Field.TRACKING, ['true'])]);
    expect(parseLegacyParams('?tracking=UnTracked')).toEqual([p(Field.TRACKING, ['false'])]);
    expect(parseLegacyParams('?tracking=true')).toEqual([p(Field.TRACKING, ['true'])]);
    expect(parseLegacyParams('?tracking=all')).toEqual([]);
    expect(parseLegacyParams('?tracking=invalid')).toEqual([]);
    expect(parseLegacyParams('?tracking=')).toEqual([]);
  });

  it('strips one leading @ from author (author=@me is the login "me")', () => {
    expect(parseLegacyParams('?author=@alice')).toEqual([p(Field.AUTHOR, ['alice'])]);
    expect(parseLegacyParams('?author=@me')).toEqual([p(Field.AUTHOR, ['me'])]);
    expect(parseLegacyParams('?author=@')).toEqual([]);
  });

  it('lets repo win over org, and keeps org alone', () => {
    expect(parseLegacyParams('?repo=a/b&org=a')).toEqual([p(Field.REPO, ['a/b'])]);
    expect(parseLegacyParams('?org=a')).toEqual([p(Field.ORG, ['a'])]);
  });

  it('trims open values and drops empty ones', () => {
    expect(parseLegacyParams('?milestone=%20v1.32%20&label=%20&repo=%20a/b&item=%20PR_1%20')).toEqual([
      p(Field.MILESTONE, ['v1.32']),
      p(Field.REPO, ['a/b']),
    ]);
  });

  it('turns repeated parameters into one OR predicate, without duplicates', () => {
    expect(parseLegacyParams('?label=a&label=b&label=a')).toEqual([p(Field.LABEL, ['a', 'b'])]);
  });

  it('turns a -key= prefix into negation', () => {
    expect(parseLegacyParams('?-label=bug')).toEqual([p(Field.LABEL, ['bug'], true)]);
    expect(parseLegacyParams('?label=a&-label=b')).toEqual([p(Field.LABEL, ['a']), p(Field.LABEL, ['b'], true)]);
    expect(parseLegacyParams('?-label=a&-label=b')).toEqual([p(Field.LABEL, ['a', 'b'], true)]);
    expect(parseLegacyParams('?-triage=acked')).toEqual([p(Field.TRIAGE, ['acked'], true)]);
  });

  it('drops invalid closed values inside a multi-value predicate', () => {
    expect(parseLegacyParams('?state=open&state=bogus')).toEqual([p(Field.STATE, ['open'])]);
    expect(parseLegacyParams('?state=bogus&state=nope')).toEqual([]);
  });

  it('ignores unknown keys and meaningless negations', () => {
    expect(parseLegacyParams('?utm=1&--label=x&-triage=activity&-in=title')).toEqual([]);
  });

  it('parses the query keys that have no control', () => {
    expect(parseLegacyParams('?draft=true&starred=FALSE&new=mention&no=label&in=title')).toEqual([
      p(Field.DRAFT, ['true']),
      p(Field.STARRED, ['false']),
      p(Field.NEW, ['mention']),
      p(Field.NO, ['label']),
      p(Field.IN, ['title']),
    ]);
  });

  it('keeps triage=activity and other new: values as separate predicates', () => {
    expect(parseLegacyParams('?triage=activity&new=mention')).toEqual([
      p(Field.NEW, ['any']),
      p(Field.NEW, ['mention']),
    ]);
    expect(parseLegacyParams('?triage=activity&new=any')).toEqual([p(Field.NEW, ['any'])]);
  });
});
