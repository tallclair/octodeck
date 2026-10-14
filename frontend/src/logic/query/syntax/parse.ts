import { Field } from '../../../api/octodeck/v1/query_pb';
import type { FilterPredicate } from '../../../types/filters';
import { IS_SHORTHAND, ME_VALUE, specForKey } from '../vocabulary';
import { formatTerm } from './quote';
import { scan } from './scan';
import type {
  Clause,
  ParsedQuery,
  QueryIssue,
  Segment,
  Span,
  ValueNode,
} from './types';

const QUALIFIER_KEY_RE = /^([A-Za-z_]+):/;
const ITEM_NUMBER_RE = /^#?(\d+)$/;

function formatOrList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

interface UnquotedSlice {
  readonly text: string;
  readonly quoted: boolean;
  readonly badQuote: boolean;
  readonly unterminated: boolean;
}

/**
 * Unquotes and unescapes a slice `text.slice(start, end)`.
 * Inside quotes, `\"` -> `"`, `\\` -> `\`, and `\x` -> `\x` literally.
 */
function parseQuotedOrBare(text: string, start: number, end: number): UnquotedSlice {
  if (start >= end) {
    return { text: '', quoted: false, badQuote: false, unterminated: false };
  }
  if (text[start] !== '"') {
    const raw = text.slice(start, end);
    return {
      text: raw,
      quoted: false,
      badQuote: raw.includes('"'),
      unterminated: false,
    };
  }

  let out = '';
  let i = start + 1;
  let closeIndex = -1;
  while (i < end) {
    const ch = text[i];
    if (ch === '\\') {
      if (i + 1 < end) {
        const next = text[i + 1];
        if (next === '"' || next === '\\') {
          out += next;
        } else {
          out += '\\' + next;
        }
        i += 2;
      } else {
        out += '\\';
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      closeIndex = i;
      break;
    }
    out += ch;
    i++;
  }

  if (closeIndex < 0) {
    return { text: out, quoted: true, badQuote: false, unterminated: true };
  }
  if (closeIndex < end - 1) {
    return { text: out, quoted: true, badQuote: true, unterminated: false };
  }
  return { text: out, quoted: true, badQuote: false, unterminated: false };
}

/** Splits `text.slice(start, end)` on commas outside quotes. */
function splitValueSpans(text: string, start: number, end: number): Span[] {
  if (start >= end) return [];
  const spans: Span[] = [];
  let partStart = start;
  let i = start;
  let inQuote = false;

  while (i < end) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '\\') {
        i += i + 1 < end ? 2 : 1;
        continue;
      }
      if (ch === '"') {
        inQuote = false;
      }
      i++;
    } else {
      if (ch === ',') {
        spans.push({ start: partStart, end: i });
        partStart = i + 1;
      } else if (ch === '"') {
        inQuote = true;
      }
      i++;
    }
  }
  spans.push({ start: partStart, end });
  return spans;
}

function normalizeUserLogin(value: string): string {
  if (value.toLowerCase() === ME_VALUE) return ME_VALUE;
  return value.startsWith('@') ? value.slice(1) : value;
}

function parseSpan(text: string, span: Span): Clause {
  const { start, end } = span;
  const raw = text.slice(start, end);

  if (raw === '-') {
    return {
      start,
      end,
      raw,
      negated: false,
      kind: 'term',
      values: [{ start, end, text: '-', quoted: false, invalid: false }],
      status: 'incomplete',
      predicate: null,
      issue: {
        start,
        end,
        code: 'lone-dash',
        message: 'Incomplete negation',
      },
    };
  }

  const negated = raw.startsWith('-') && raw.length > 1;
  const bodyStart = start + (negated ? 1 : 0);
  const body = text.slice(bodyStart, end);
  const keyMatch = QUALIFIER_KEY_RE.exec(body);

  if (!keyMatch) {
    const parsed = parseQuotedOrBare(text, bodyStart, end);
    if (parsed.badQuote) {
      return {
        start,
        end,
        raw,
        negated,
        kind: 'term',
        values: [{ start: bodyStart, end, text: parsed.text, quoted: parsed.quoted, invalid: true }],
        status: 'error',
        predicate: null,
        issue: {
          start,
          end,
          code: 'bad-quote',
          message: 'Quotes must surround the whole term',
        },
      };
    }
    if (parsed.unterminated) {
      return {
        start,
        end,
        raw,
        negated,
        kind: 'term',
        values: [{ start: bodyStart, end, text: parsed.text, quoted: true, invalid: false }],
        status: 'incomplete',
        predicate: null,
        issue: {
          start: bodyStart,
          end,
          code: 'unterminated-quote',
          message: 'Unterminated quote',
        },
      };
    }
    if (parsed.quoted && parsed.text === '') {
      return {
        start,
        end,
        raw,
        negated,
        kind: 'term',
        values: [{ start: bodyStart, end, text: '', quoted: true, invalid: true }],
        status: 'error',
        predicate: null,
        issue: {
          start,
          end,
          code: 'empty-term',
          message: 'Empty search term',
        },
      };
    }

    const numMatch = ITEM_NUMBER_RE.exec(parsed.text);
    const note = numMatch ? `Also matches item number ${numMatch[1]}` : undefined;
    return {
      start,
      end,
      raw,
      negated,
      kind: 'term',
      values: [{ start: bodyStart, end, text: parsed.text, quoted: parsed.quoted, invalid: false }],
      status: 'ok',
      predicate: { field: Field.TEXT, values: [parsed.text], negated },
      ...(note ? { note } : {}),
    };
  }

  const keyLen = keyMatch[1].length;
  const colonIndex = bodyStart + keyLen;
  const keyText = keyMatch[1].toLowerCase();
  const keyNode = { start: bodyStart, end: colonIndex, text: keyText };
  const valStart = colonIndex + 1;
  const rawSpans = splitValueSpans(text, valStart, end);

  let badQuote = false;
  let unterminatedSpan: Span | null = null;
  let emptyValueSpan: Span | null = null;

  const valueNodes: Array<{
    start: number;
    end: number;
    text: string;
    quoted: boolean;
    invalid: boolean;
    empty: boolean;
  }> = [];

  for (const sp of rawSpans) {
    if (sp.start === sp.end) {
      if (!emptyValueSpan) emptyValueSpan = sp;
      valueNodes.push({
        start: sp.start,
        end: sp.end,
        text: '',
        quoted: false,
        invalid: false,
        empty: true,
      });
      continue;
    }
    const parsed = parseQuotedOrBare(text, sp.start, sp.end);
    if (parsed.badQuote) {
      badQuote = true;
    } else if (parsed.unterminated && !unterminatedSpan) {
      unterminatedSpan = { start: sp.start, end };
    } else if (parsed.quoted && parsed.text === '' && !emptyValueSpan) {
      emptyValueSpan = sp;
    }
    valueNodes.push({
      start: sp.start,
      end: sp.end,
      text: parsed.text,
      quoted: parsed.quoted,
      invalid: parsed.badQuote,
      empty: parsed.text === '',
    });
  }

  const toValues = (): ValueNode[] =>
    valueNodes.map(({ start: s, end: e, text: t, quoted, invalid }) => ({
      start: s,
      end: e,
      text: t,
      quoted,
      invalid,
    }));

  const spec = keyText === 'is' ? undefined : specForKey(keyText);
  if (keyText !== 'is' && !spec) {
    const quotedSuggestion = `${negated ? '-' : ''}${formatTerm(body)}`;
    return {
      start,
      end,
      raw,
      negated,
      kind: 'qualifier',
      key: keyNode,
      values: toValues(),
      status: 'error',
      predicate: null,
      issue: {
        start: keyNode.start,
        end: keyNode.end,
        code: 'unknown-key',
        message: `${keyText} is not a known filter. Quote it to search for the text: ${quotedSuggestion}`,
      },
    };
  }

  if (spec && !spec.negatable && negated) {
    return {
      start,
      end,
      raw,
      negated,
      kind: 'qualifier',
      key: keyNode,
      values: toValues(),
      status: 'error',
      predicate: null,
      issue: {
        start,
        end: start + 1,
        code: 'negated-in',
        message: `${spec.key}: cannot be negated`,
      },
    };
  }

  if (badQuote) {
    return {
      start,
      end,
      raw,
      negated,
      kind: 'qualifier',
      key: keyNode,
      values: toValues(),
      status: 'error',
      predicate: null,
      issue: {
        start,
        end,
        code: 'bad-quote',
        message: 'Quotes must surround the whole value',
      },
    };
  }

  if (unterminatedSpan) {
    return {
      start,
      end,
      raw,
      negated,
      kind: 'qualifier',
      key: keyNode,
      values: toValues(),
      status: 'incomplete',
      predicate: null,
      issue: {
        ...unterminatedSpan,
        code: 'unterminated-quote',
        message: 'Unterminated quote',
      },
    };
  }

  const nonEmptyNodes = valueNodes.filter((v) => !v.empty);

  if (keyText === 'is') {
    const fields = new Set<Field>();
    const expandedValues: string[] = [];
    for (const v of nonEmptyNodes) {
      const target = IS_SHORTHAND[v.text.toLowerCase()];
      if (!target) {
        v.invalid = true;
      } else {
        fields.add(target.field);
        expandedValues.push(target.value);
      }
    }

    const firstInvalid = nonEmptyNodes.find((v) => v.invalid);
    if (firstInvalid) {
      return {
        start,
        end,
        raw,
        negated,
        kind: 'qualifier',
        key: keyNode,
        values: toValues(),
        status: 'error',
        predicate: null,
        issue: {
          start: firstInvalid.start,
          end: firstInvalid.end,
          code: 'invalid-value',
          message: `is must be ${formatOrList(Object.keys(IS_SHORTHAND))}`,
        },
      };
    }

    if (fields.size > 1) {
      return {
        start,
        end,
        raw,
        negated,
        kind: 'qualifier',
        key: keyNode,
        values: toValues(),
        status: 'error',
        predicate: null,
        issue: {
          start: valStart,
          end,
          code: 'mixed-is',
          message: 'is: cannot combine values from different filter fields',
        },
      };
    }

    if (valStart === end) {
      return {
        start,
        end,
        raw,
        negated,
        kind: 'qualifier',
        key: keyNode,
        values: toValues(),
        status: 'incomplete',
        predicate: null,
        issue: {
          start: end,
          end,
          code: 'missing-value',
          message: 'Missing value for is:',
        },
      };
    }

    if (emptyValueSpan) {
      return {
        start,
        end,
        raw,
        negated,
        kind: 'qualifier',
        key: keyNode,
        values: toValues(),
        status: 'incomplete',
        predicate: null,
        issue: {
          ...emptyValueSpan,
          code: 'empty-value',
          message: 'Empty value for is:',
        },
      };
    }

    const targetField = [...fields][0];
    return {
      start,
      end,
      raw,
      negated,
      kind: 'qualifier',
      key: keyNode,
      values: toValues(),
      status: 'ok',
      predicate: {
        field: targetField,
        values: expandedValues,
        negated,
      },
    };
  }

  // Known qualifier field from FIELD_SPECS.
  const fieldSpec = spec!;
  if (fieldSpec.closed) {
    for (const v of nonEmptyNodes) {
      if (!fieldSpec.closed.includes(v.text.toLowerCase())) {
        v.invalid = true;
      }
    }
    const firstInvalid = nonEmptyNodes.find((v) => v.invalid);
    if (firstInvalid) {
      return {
        start,
        end,
        raw,
        negated,
        kind: 'qualifier',
        key: keyNode,
        values: toValues(),
        status: 'error',
        predicate: null,
        issue: {
          start: firstInvalid.start,
          end: firstInvalid.end,
          code: 'invalid-value',
          message: `${fieldSpec.key} must be ${formatOrList(fieldSpec.closed)}`,
        },
      };
    }
  }

  if (valStart === end) {
    return {
      start,
      end,
      raw,
      negated,
      kind: 'qualifier',
      key: keyNode,
      values: toValues(),
      status: 'incomplete',
      predicate: null,
      issue: {
        start: end,
        end,
        code: 'missing-value',
        message: `Missing value for ${fieldSpec.key}:`,
      },
    };
  }

  const isUserField =
    fieldSpec.field === Field.AUTHOR || fieldSpec.field === Field.ASSIGNEE;
  const normalizedValues: string[] = [];
  let firstEmptySpan: Span | null = null;
  for (const v of valueNodes) {
    const normalized = fieldSpec.closed
      ? v.text.toLowerCase()
      : isUserField
      ? normalizeUserLogin(v.text)
      : v.text;
    if (v.empty || normalized === '') {
      if (!firstEmptySpan) {
        firstEmptySpan = { start: v.start, end: v.end };
      }
    } else {
      normalizedValues.push(normalized);
    }
  }

  if (firstEmptySpan) {
    return {
      start,
      end,
      raw,
      negated,
      kind: 'qualifier',
      key: keyNode,
      values: toValues(),
      status: 'incomplete',
      predicate: null,
      issue: {
        ...firstEmptySpan,
        code: 'empty-value',
        message: `Empty value for ${fieldSpec.key}:`,
      },
    };
  }

  const note =
    fieldSpec.field === Field.TRIAGE && normalizedValues.includes('all')
      ? '= inbox,acked'
      : undefined;

  return {
    start,
    end,
    raw,
    negated,
    kind: 'qualifier',
    key: keyNode,
    values: toValues(),
    status: 'ok',
    predicate: {
      field: fieldSpec.field,
      values: normalizedValues,
      negated,
    },
    ...(note ? { note } : {}),
  };
}

/** Parses one raw clause at offset 0. */
export function parseClause(raw: string): Clause {
  return parseSpan(raw, { start: 0, end: raw.length });
}

/** Parses a full query string into clauses, predicates, and issues with UTF-16 spans. */
export function parseQuery(text: string): ParsedQuery {
  const clauses = scan(text).map((sp) => parseSpan(text, sp));
  const predicates: FilterPredicate[] = [];
  const clauseOfPredicate: number[] = [];
  const issues: QueryIssue[] = [];

  clauses.forEach((clause, index) => {
    if (clause.predicate) {
      predicates.push(clause.predicate);
      clauseOfPredicate.push(index);
    }
    if (clause.issue) {
      issues.push(clause.issue);
    }
  });

  return {
    text,
    clauses,
    predicates,
    clauseOfPredicate,
    issues,
  };
}

/**
 * Splits a clause into contiguous syntax segments covering `[clause.start, clause.end)`.
 * Used by the query input to colour the parts of each clause pill.
 */
export function segmentClause(clause: Clause): Segment[] {
  const segments: Segment[] = [];
  if (clause.negated) {
    segments.push({ start: clause.start, end: clause.start + 1, role: 'neg' });
  }
  if (clause.kind === 'term' || !clause.key) {
    const bodyStart = clause.start + (clause.negated ? 1 : 0);
    if (clause.end > bodyStart) {
      segments.push({ start: bodyStart, end: clause.end, role: 'text' });
    }
    return segments;
  }

  const badKey = clause.issue?.code === 'unknown-key';
  segments.push({
    start: clause.key.start,
    end: clause.key.end,
    role: badKey ? 'badkey' : 'key',
  });
  segments.push({
    start: clause.key.end,
    end: clause.key.end + 1,
    role: 'colon',
  });

  const allValuesBad = clause.issue?.code === 'mixed-is';
  clause.values.forEach((v, i) => {
    if (i > 0) {
      segments.push({ start: v.start - 1, end: v.start, role: 'comma' });
    }
    if (v.end > v.start) {
      segments.push({
        start: v.start,
        end: v.end,
        role: v.invalid || allValuesBad ? 'badvalue' : 'value',
      });
    }
  });

  return segments;
}
