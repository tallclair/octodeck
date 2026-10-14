// Autocomplete suggestion calculation and keyboard state for QueryInput (§6.7).
import { useState, type KeyboardEvent } from 'react';
import { Field } from '../api/octodeck/v1/query_pb';
import { formatValue, parseClause, scan, type Span } from '../logic/query/syntax';
import {
  FIELD_SPECS,
  IS_SHORTHAND,
  ME_VALUE,
  specForField,
  specForKey,
} from '../logic/query/vocabulary';

export type FacetSuggestionItem =
  | string
  | { readonly value: string; readonly count?: number };

export interface QuerySuggestionFacets {
  readonly repos?: readonly FacetSuggestionItem[];
  readonly orgs?: readonly FacetSuggestionItem[];
  readonly authors?: readonly FacetSuggestionItem[];
  readonly assignees?: readonly FacetSuggestionItem[];
  readonly milestones?: readonly FacetSuggestionItem[];
  readonly labels?: readonly FacetSuggestionItem[];
  readonly activity?: readonly FacetSuggestionItem[];
}

export interface Suggestion {
  readonly label: string;
  readonly insert: string;
  readonly kind: 'key' | 'value' | 'shorthand';
  readonly detail?: string;
}

export interface SuggestionResult extends Span {
  readonly items: readonly Suggestion[];
}

const MAX_ITEMS = 8;

const IS_KEY_SPEC = {
  key: 'is',
  description: 'State, type or status shorthand',
  negatable: true,
} as const;

function unquotePrefix(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  let out = '';
  let i = 1;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\\') {
      if (i + 1 < raw.length) {
        const next = raw[i + 1];
        out += next === '"' || next === '\\' ? next : `\\${next}`;
        i += 2;
      } else {
        out += '\\';
        i += 1;
      }
      continue;
    }
    if (ch === '"') break;
    out += ch;
    i++;
  }
  return out;
}

function extractFacetStrings(
  items: readonly FacetSuggestionItem[] | undefined,
  includeMe = false
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const push = (val: string) => {
    const trimmed = val.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(trimmed);
  };
  if (includeMe) {
    push(ME_VALUE);
  }
  for (const item of items ?? []) {
    if (typeof item === 'string') {
      push(item);
    } else if (item && typeof item === 'object' && 'value' in item) {
      if ('count' in item && typeof item.count === 'number' && item.count <= 0) {
        continue;
      }
      push(item.value);
    }
  }
  return result;
}

function isOptionsForClause(
  otherValues: readonly { readonly text: string }[]
): readonly string[] {
  const allShorthands = Object.keys(IS_SHORTHAND);
  if (otherValues.length === 0) {
    return allShorthands;
  }
  let targetField: Field | undefined;
  const usedMappedValues = new Set<string>();
  for (const v of otherValues) {
    const entry = IS_SHORTHAND[v.text.toLowerCase()];
    if (!entry) {
      return [];
    }
    if (targetField === undefined) {
      targetField = entry.field;
    } else if (targetField !== entry.field) {
      return [];
    }
    usedMappedValues.add(entry.value);
  }
  return allShorthands.filter((k) => {
    const entry = IS_SHORTHAND[k];
    return entry.field === targetField && !usedMappedValues.has(entry.value);
  });
}

function valuesForField(
  keyText: string,
  facets?: QuerySuggestionFacets
): readonly string[] | null {
  if (keyText === 'is') {
    return Object.keys(IS_SHORTHAND);
  }
  const spec = specForKey(keyText);
  if (!spec) return null;
  if (spec.closed) {
    return spec.closed;
  }
  switch (spec.field) {
    case Field.REPO:
      return extractFacetStrings(facets?.repos);
    case Field.ORG:
      return extractFacetStrings(facets?.orgs);
    case Field.AUTHOR:
      return extractFacetStrings(facets?.authors, true);
    case Field.ASSIGNEE:
      return extractFacetStrings(facets?.assignees, true);
    case Field.MILESTONE:
      return extractFacetStrings(facets?.milestones);
    case Field.LABEL:
      return extractFacetStrings(facets?.labels);
    default:
      return null;
  }
}

function normalizeUsedValue(keyText: string, value: string): string {
  const lower = value.toLowerCase();
  const spec = specForKey(keyText);
  if (
    (spec?.field === Field.AUTHOR || spec?.field === Field.ASSIGNEE) &&
    lower !== ME_VALUE
  ) {
    return lower.replace(/^@/, '');
  }
  return lower;
}

/**
 * Computes autocomplete suggestions for the clause in `text` containing `caret` (§6.7).
 */
export function suggest(
  text: string,
  caret: number,
  showEmpty: boolean,
  facets?: QuerySuggestionFacets
): SuggestionResult | null {
  const spans = scan(text);
  const span = spans.find((s) => s.start <= caret && caret <= s.end) ?? {
    start: caret,
    end: caret,
    raw: '',
  };
  const clause = span.end > span.start ? parseClause(span.raw) : null;
  const negated = Boolean(clause?.negated || span.raw === '-');
  const bodyStart = span.start + (negated ? 1 : 0);

  if (!clause?.key || caret <= span.start + clause.key.end) {
    // Key context.
    if (caret < bodyStart) return null;
    const prefix = text.slice(bodyStart, caret).toLowerCase();
    if (prefix === '' && !showEmpty) return null;
    if (prefix.startsWith('"')) return null;

    const replaceEnd = clause?.key ? span.start + clause.key.end + 1 : span.end;
    const candidateKeys = [
      ...FIELD_SPECS.filter((s) => !negated || s.negatable).map((s) => ({
        key: s.key,
        description: s.description,
      })),
      IS_KEY_SPEC,
    ];

    const matchingKeys: Suggestion[] = candidateKeys
      .filter((k) => k.key.toLowerCase().includes(prefix))
      .sort((a, b) => {
        const aStarts = a.key.toLowerCase().startsWith(prefix);
        const bStarts = b.key.toLowerCase().startsWith(prefix);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return a.key.localeCompare(b.key);
      })
      .map((k) => ({
        label: `${k.key}:`,
        insert: `${k.key}:`,
        kind: 'key',
        detail: k.description,
      }));

    const shorthands: Suggestion[] =
      !clause?.key && prefix.length >= 2
        ? Object.entries(IS_SHORTHAND)
            .filter(([v]) => {
              const full = `is:${v}`;
              return v.includes(prefix) || full.includes(prefix);
            })
            .sort(([a], [b]) => {
              const aStarts = a.startsWith(prefix) || `is:${a}`.startsWith(prefix);
              const bStarts = b.startsWith(prefix) || `is:${b}`.startsWith(prefix);
              if (aStarts !== bStarts) return aStarts ? -1 : 1;
              return a.localeCompare(b);
            })
            .map(([v, exp]) => {
              const targetKey = specForField(exp.field)?.key ?? String(exp.field);
              return {
                label: `is:${v}`,
                insert: `is:${v}`,
                kind: 'shorthand',
                detail: `${targetKey}:${exp.value}`,
              };
            })
        : [];

    const items = [...matchingKeys, ...shorthands].slice(0, MAX_ITEMS);
    if (items.length === 0) return null;
    if (items.length === 1 && items[0].label.toLowerCase() === prefix) {
      return null;
    }
    return { start: bodyStart, end: replaceEnd, items };
  }

  // Value context.
  const keyText = clause.key.text;
  const localCaret = caret - span.start;
  const segIndex = clause.values.findIndex(
    (v) => v.start <= localCaret && localCaret <= v.end
  );
  const seg =
    segIndex >= 0
      ? clause.values[segIndex]
      : clause.values.length === 0
      ? {
          start: clause.key.end + 1,
          end: span.end - span.start,
          text: '',
          quoted: false,
          invalid: false,
        }
      : null;
  if (!seg) return null;

  const otherValues = clause.values.filter(
    (v, idx) => v !== seg && (idx < segIndex || v.text !== '')
  );
  const options =
    keyText === 'is'
      ? isOptionsForClause(otherValues)
      : valuesForField(keyText, facets);
  if (!options || options.length === 0) return null;

  const absSegStart = span.start + seg.start;
  const absSegEnd = span.start + seg.end;
  const rawTypedSlice = text.slice(absSegStart, caret);
  const rawFullSeg = text.slice(absSegStart, absSegEnd);
  const rawPrefix = unquotePrefix(rawTypedSlice).toLowerCase();
  const spec = specForKey(keyText);
  const isUserField = spec?.field === Field.AUTHOR || spec?.field === Field.ASSIGNEE;
  const strippedPrefix =
    isUserField && rawPrefix.startsWith('@') && rawPrefix !== '@me'
      ? rawPrefix.slice(1)
      : rawPrefix;

  const used = new Set(
    clause.values
      .filter((v) => v !== seg && v.text !== '')
      .map((v) => normalizeUsedValue(keyText, v.text))
  );

  const matchesOption = (opt: string): boolean => {
    const lower = opt.toLowerCase();
    if (lower.includes(rawPrefix)) return true;
    if (isUserField && lower !== ME_VALUE && strippedPrefix !== rawPrefix) {
      return lower.includes(strippedPrefix);
    }
    return false;
  };

  const startsWithOption = (opt: string): boolean => {
    const lower = opt.toLowerCase();
    if (lower.startsWith(rawPrefix)) return true;
    if (isUserField && lower === ME_VALUE && rawPrefix !== '' && 'me'.startsWith(rawPrefix)) {
      return true;
    }
    if (isUserField && lower !== ME_VALUE && strippedPrefix !== rawPrefix) {
      return lower.startsWith(strippedPrefix);
    }
    return false;
  };

  const items: Suggestion[] = options
    .filter((opt) => !used.has(normalizeUsedValue(keyText, opt)) && matchesOption(opt))
    .sort((a, b) => {
      const aStarts = startsWithOption(a);
      const bStarts = startsWithOption(b);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      return a.localeCompare(b);
    })
    .slice(0, MAX_ITEMS)
    .map((opt) => {
      const exp = keyText === 'is' ? IS_SHORTHAND[opt.toLowerCase()] : undefined;
      const targetKey = exp ? (specForField(exp.field)?.key ?? String(exp.field)) : undefined;
      return {
        label: opt,
        insert: formatValue(opt),
        kind: 'value',
        ...(exp && targetKey ? { detail: `${targetKey}:${exp.value}` } : {}),
      };
    });

  if (items.length === 0) return null;
  if (
    items.length === 1 &&
    (items[0].label.toLowerCase() === rawPrefix ||
      items[0].insert.toLowerCase() === rawFullSeg.toLowerCase() ||
      (isUserField &&
        items[0].label.toLowerCase() !== ME_VALUE &&
        items[0].label.toLowerCase() === strippedPrefix &&
        rawPrefix !== ''))
  ) {
    return null;
  }

  return { start: absSegStart, end: absSegEnd, items };
}

export interface QuerySuggestionsState {
  readonly result: SuggestionResult | null;
  readonly open: boolean;
  readonly active: number;
  readonly setActive: (index: number) => void;
  readonly dismiss: () => void;
  readonly onKeyDown: (
    e: KeyboardEvent,
    accept: (suggestion: Suggestion, key: 'Enter' | 'Tab') => void
  ) => boolean;
}

/**
 * Manages suggestion popup state for the clause at `caret` in the full query `text`, keyed by
 * the `(text, caret)` signature so it resets automatically whenever the user types or moves the
 * caret (§6.7).
 */
export function useQuerySuggestions(
  text: string,
  caret: number,
  focused: boolean,
  facets?: QuerySuggestionFacets
): QuerySuggestionsState {
  const sig = `${caret}|${text}`;
  const [activeState, setActiveState] = useState({ sig: '', index: 0 });
  const [dismissedSig, setDismissedSig] = useState<string | null>(null);
  const [forcedSig, setForcedSig] = useState<string | null>(null);

  const result = focused ? suggest(text, caret, forcedSig === sig, facets) : null;
  const count = result?.items.length ?? 0;
  const open = count > 0 && dismissedSig !== sig;
  const active =
    activeState.sig === sig && count > 0 ? Math.min(activeState.index, count - 1) : 0;

  const setActive = (index: number) => setActiveState({ sig, index });
  const dismiss = () => setDismissedSig(sig);

  const onKeyDown = (
    e: KeyboardEvent,
    accept: (suggestion: Suggestion, key: 'Enter' | 'Tab') => void
  ): boolean => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
      e.preventDefault();
      if (!open) {
        setDismissedSig(null);
        setForcedSig(sig);
        setActiveState({ sig, index: 0 });
        return true;
      }
      setActiveState({
        sig,
        index: (active + (e.key === 'ArrowDown' ? 1 : count - 1)) % count,
      });
      return true;
    }
    if (!open || !result) return false;
    if (
      (e.key === 'Enter' || e.key === 'Tab') &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      e.preventDefault();
      accept(result.items[active], e.key);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissedSig(sig);
      return true;
    }
    return false;
  };

  return { result, open, active, setActive, dismiss, onKeyDown };
}
