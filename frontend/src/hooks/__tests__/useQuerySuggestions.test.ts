import type { KeyboardEvent } from 'react';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { parseClause } from '../../logic/query/syntax';
import {
  suggest,
  useQuerySuggestions,
  type QuerySuggestionFacets,
  type Suggestion,
  type SuggestionResult,
} from '../useQuerySuggestions';

/** What accepting `suggestion` does to `text`: replace the result's span with its insert text. */
function applySuggestion(text: string, result: SuggestionResult, suggestion: Suggestion) {
  return {
    text: text.slice(0, result.start) + suggestion.insert + text.slice(result.end),
    caret: result.start + suggestion.insert.length,
  };
}

const SAMPLE_FACETS: QuerySuggestionFacets = {
  repos: ['octo/deck', 'kubernetes/kubernetes', 'golang/go'],
  orgs: ['octo', 'kubernetes'],
  authors: ['alice', 'bob', 'charlie'],
  assignees: ['alice', 'dave'],
  milestones: ['v1.0', 'v2.0 Next'],
  labels: ['bug', 'good first issue', 'area/ui', 'needs-triage', 'a,b', 'quote"label'],
};

describe('useQuerySuggestions — suggest (§6.7)', () => {
  it('returns null on empty draft unless showEmpty (ArrowDown) is true', () => {
    expect(suggest('', 0, false)).toBeNull();
    const forced = suggest('', 0, true);
    expect(forced).not.toBeNull();
    expect(forced!.items.length).toBeLessThanOrEqual(8);
    expect(forced!.items.every((it) => it.kind === 'key')).toBe(true);
  });

  it('suggests matching qualifier keys and includes is: shorthands once >= 2 chars are typed', () => {
    // 1 char: only keys, no shorthands
    const oneChar = suggest('o', 1, false);
    expect(oneChar).not.toBeNull();
    expect(oneChar!.items.some((i) => i.label === 'org:')).toBe(true);
    expect(oneChar!.items.some((i) => i.kind === 'shorthand')).toBe(false);

    // 2+ chars: includes matching is: shorthands with expansion detail
    const twoChars = suggest('op', 2, false);
    expect(twoChars).not.toBeNull();
    expect(twoChars!.items).toEqual([
      {
        label: 'is:open',
        insert: 'is:open',
        kind: 'shorthand',
        detail: 'state:open',
      },
    ]);
  });

  it('suppresses kind: shorthand items in key context when clause.key already exists', () => {
    // Caret at 2 inside 'is:open' (before ':'): only key suggestions ('is:') are emitted, never 'is:acked'
    const isRes = suggest('is:open', 2, false);
    expect(isRes).not.toBeNull();
    expect(isRes!.items.every((i) => i.kind === 'key')).toBe(true);
    for (const item of isRes!.items) {
      const applied = applySuggestion('is:open', isRes!, item);
      expect(applied.text.endsWith(':open')).toBe(true);
    }

    // Caret at 1 or 2 inside 'in:title' (before ':'): only key suggestions are emitted, preserving ':title'
    const inAt1 = suggest('in:title', 1, false);
    expect(inAt1).not.toBeNull();
    expect(inAt1!.items.every((i) => i.kind === 'key')).toBe(true);
    for (const item of inAt1!.items) {
      const applied = applySuggestion('in:title', inAt1!, item);
      expect(applied.text.endsWith(':title')).toBe(true);
    }

    const inAt2 = suggest('in:title', 2, false);
    expect(inAt2).not.toBeNull();
    expect(inAt2!.items.every((i) => i.kind === 'key')).toBe(true);
    for (const item of inAt2!.items) {
      const applied = applySuggestion('in:title', inAt2!, item);
      expect(applied.text.endsWith(':title')).toBe(true);
    }
  });

  it('preserves leading - in negated key context and excludes non-negatable in:', () => {
    const negIn = suggest('-i', 2, false);
    // `is:` is negatable, `in:` is not
    expect(negIn).not.toBeNull();
    expect(negIn!.start).toBe(1);
    expect(negIn!.items.map((i) => i.label)).toContain('is:');
    expect(negIn!.items.map((i) => i.label)).not.toContain('in:');

    const applied = applySuggestion('-la', suggest('-la', 3, false)!, {
      label: 'label:',
      insert: 'label:',
      kind: 'key',
    });
    expect(applied).toEqual({ text: '-label:', caret: 7 });
  });

  it('offers closed field values and is: shorthand values with expansion details', () => {
    const stateRes = suggest('state:', 6, false);
    expect(stateRes).not.toBeNull();
    expect(stateRes!.items.map((i) => i.label)).toEqual(['closed', 'merged', 'open']);

    const isRes = suggest('is:tr', 5, false);
    expect(isRes).not.toBeNull();
    expect(isRes!.items).toEqual([
      { label: 'tracked', insert: 'tracked', kind: 'value', detail: 'tracking:true' },
      { label: 'untracked', insert: 'untracked', kind: 'value', detail: 'tracking:false' },
    ]);
  });

  it('restricts multi-value is: suggestions to the same Field and never produces mixed-is errors', () => {
    const isOpenComma = suggest('is:open,', 8, false);
    expect(isOpenComma).not.toBeNull();
    expect(isOpenComma!.items.map((i) => i.label)).toEqual(['closed', 'merged']);
    for (const item of isOpenComma!.items) {
      const applied = applySuggestion('is:open,', isOpenComma!, item);
      expect(parseClause(applied.text).status).toBe('ok');
    }

    const isPrComma = suggest('is:pr,', 6, false);
    expect(isPrComma).not.toBeNull();
    expect(isPrComma!.items.map((i) => i.label)).toEqual(['issue']);
    expect(parseClause(applySuggestion('is:pr,', isPrComma!, isPrComma!.items[0]).text).status).toBe(
      'ok'
    );

    const isInboxComma = suggest('is:inbox,', 9, false);
    expect(isInboxComma).not.toBeNull();
    expect(isInboxComma!.items.map((i) => i.label)).toEqual(['acked']);

    const isTrackedComma = suggest('is:tracked,', 11, false);
    expect(isTrackedComma).not.toBeNull();
    expect(isTrackedComma!.items.map((i) => i.label)).toEqual(['untracked']);

    // Single-value boolean shorthands have no other shorthand sharing their Field
    expect(suggest('is:draft,', 9, false)).toBeNull();
    expect(suggest('is:starred,', 11, false)).toBeNull();
    expect(suggest('is:new,', 7, false)).toBeNull();

    // Already-mixed or unknown preceding values return null
    expect(suggest('is:open,pr,', 11, false)).toBeNull();
    expect(suggest('is:unknown,', 11, false)).toBeNull();
  });

  it('offers open field values from facets and includes @me for author and assignee', () => {
    const labelRes = suggest('label:', 6, false, SAMPLE_FACETS);
    expect(labelRes).not.toBeNull();
    expect(labelRes!.items.map((i) => i.label)).toEqual([
      'a,b',
      'area/ui',
      'bug',
      'good first issue',
      'needs-triage',
      'quote"label',
    ]);

    const assigneeRes = suggest('assignee:', 9, false, SAMPLE_FACETS);
    expect(assigneeRes).not.toBeNull();
    expect(assigneeRes!.items.map((i) => i.label)).toEqual(['@me', 'alice', 'dave']);

    const authorMeRes = suggest('author:m', 8, false, SAMPLE_FACETS);
    expect(authorMeRes).not.toBeNull();
    expect(authorMeRes!.items[0].label).toBe('@me');
  });

  it('excludes count <= 0 facet entries so positive-count items are not crowded out', () => {
    const facetsWithZeroCounts: QuerySuggestionFacets = {
      repos: [
        { value: 'apache/airflow', count: 0 },
        { value: 'apache/beam', count: 0 },
        { value: 'apache/kafka', count: 0 },
        { value: 'apache/spark', count: 0 },
        { value: 'cncf/toc', count: 0 },
        { value: 'docker/cli', count: 0 },
        { value: 'golang/go', count: 0 },
        { value: 'helm/helm', count: 0 },
        { value: 'kubernetes/kubernetes', count: 5 },
        { value: 'kubernetes/website', count: 2 },
      ],
    };
    const res = suggest('repo:', 5, false, facetsWithZeroCounts);
    expect(res).not.toBeNull();
    expect(res!.items.map((i) => i.label)).toEqual([
      'kubernetes/kubernetes',
      'kubernetes/website',
    ]);
  });

  it('ranks prefix matches before substring matches, then alphabetical, and caps at 8 items', () => {
    const facets: QuerySuggestionFacets = {
      labels: [
        'z-bug',
        'a-bug',
        'bug-fix',
        'bug',
        'buggy',
        'c-bug',
        'b-bug',
        'd-bug',
        'e-bug',
        'f-bug',
      ],
    };
    const res = suggest('label:bug', 9, false, facets);
    expect(res).not.toBeNull();
    expect(res!.items).toHaveLength(8);
    // Prefix matches ('bug', 'bug-fix', 'buggy') come first in alphabetical order,
    // followed by substring matches ('a-bug', 'b-bug', 'c-bug', 'd-bug', 'e-bug')
    expect(res!.items.map((i) => i.label)).toEqual([
      'bug',
      'bug-fix',
      'buggy',
      'a-bug',
      'b-bug',
      'c-bug',
      'd-bug',
      'e-bug',
    ]);
  });

  it('excludes values already used in the same clause (case-insensitively and across @login)', () => {
    const stateRes = suggest('state:open,', 11, false);
    expect(stateRes).not.toBeNull();
    expect(stateRes!.items.map((i) => i.label)).toEqual(['closed', 'merged']);

    const authorRes = suggest('author:@alice,', 14, false, SAMPLE_FACETS);
    expect(authorRes).not.toBeNull();
    expect(authorRes!.items.map((i) => i.label)).toEqual(['@me', 'bob', 'charlie']);
  });

  it('quotes inserted values containing spaces, commas, or quotes via formatValue', () => {
    const res = suggest('label:good', 10, false, SAMPLE_FACETS)!;
    expect(res.items[0].insert).toBe('"good first issue"');
    const applied = applySuggestion('label:good', res, res.items[0]);
    expect(applied).toEqual({
      text: 'label:"good first issue"',
      caret: 'label:"good first issue"'.length,
    });

    const commaRes = suggest('label:a,', 7, false, SAMPLE_FACETS)!;
    // At caret 7 ('label:a'), 'a,b' is suggested with quoted insert '"a,b"'
    const abItem = commaRes.items.find((i) => i.label === 'a,b')!;
    expect(abItem.insert).toBe('"a,b"');

    const quoteRes = suggest('label:quote', 11, false, SAMPLE_FACETS)!;
    expect(quoteRes.items[0].insert).toBe('"quote\\"label"');
  });

  it('hides the suggestion list when the only matching item equals what is already typed', () => {
    expect(suggest('state:open', 10, false)).toBeNull();
    expect(suggest('label:', 6, false)).toBeNull(); // no facets provided
  });

  it('ignores Shift+Tab and modified Enter/Tab when suggestions are open so focus can move normally', () => {
    const { result } = renderHook(() =>
      useQuerySuggestions('label:', 6, true, SAMPLE_FACETS)
    );
    expect(result.current.open).toBe(true);

    const accept = vi.fn<(suggestion: Suggestion, key: 'Enter' | 'Tab') => void>();
    const preventDefault = vi.fn<() => void>();

    const shiftTabHandled = result.current.onKeyDown(
      {
        key: 'Tab',
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        preventDefault,
      } as unknown as KeyboardEvent,
      accept
    );
    expect(shiftTabHandled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();

    const ctrlEnterHandled = result.current.onKeyDown(
      {
        key: 'Enter',
        shiftKey: false,
        altKey: false,
        ctrlKey: true,
        metaKey: false,
        preventDefault,
      } as unknown as KeyboardEvent,
      accept
    );
    expect(ctrlEnterHandled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
});

