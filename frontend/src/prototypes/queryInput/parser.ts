// Throwaway UX prototype: a small mock query parser shared by both input designs.
// It follows the syntax in docs/internal/query_model_design.md §4.1-§4.5 closely
// enough to evaluate the input UX; it is not the Phase 2 parser.

import { IS_SHORTHAND, KEY_MAP, KEYS, valuesForKey } from './vocabulary';

export interface Span {
  start: number;
  end: number;
}

export interface Predicate {
  field: string;
  values: string[];
  negated: boolean;
}

export interface ValuePart extends Span {
  text: string;
  invalid: boolean;
}

export type TokenStatus = 'ok' | 'incomplete' | 'error';

export interface Token extends Span {
  raw: string;
  kind: 'qualifier' | 'text';
  negated: boolean;
  key?: Span & { text: string };
  values: ValuePart[];
  status: TokenStatus;
  message?: string;
  // Expansion into per-dimension predicates (is: shorthand expanded).
  predicates: Predicate[];
}

export type SegmentRole = 'neg' | 'key' | 'badkey' | 'colon' | 'value' | 'badvalue' | 'comma' | 'text';

export interface Segment extends Span {
  role: SegmentRole;
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

// Splits text into raw token spans. Whitespace separates tokens except inside
// double quotes; an unterminated quote extends to the end of the text.
export function scanTokens(text: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && isSpace(text[i])) i++;
    if (i >= text.length) break;
    const start = i;
    let inQuote = false;
    while (i < text.length && (inQuote || !isSpace(text[i]))) {
      if (text[i] === '"') inQuote = !inQuote;
      i++;
    }
    spans.push({ start, end: i });
  }
  return spans;
}

const unquote = (s: string) => s.replace(/^"/, '').replace(/"$/, '');

export function quoteIfNeeded(v: string): string {
  return /[\s,"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v;
}

// Splits [start, end) of text on commas outside quotes.
function splitValues(text: string, start: number, end: number): Span[] {
  const parts: Span[] = [];
  let inQuote = false;
  let segStart = start;
  for (let i = start; i < end; i++) {
    if (text[i] === '"') inQuote = !inQuote;
    else if (text[i] === ',' && !inQuote) {
      parts.push({ start: segStart, end: i });
      segStart = i + 1;
    }
  }
  parts.push({ start: segStart, end });
  return parts;
}

// Index of the key/value colon in [start, end), or -1. The key must be a bare
// word appearing before any quote.
function findColon(text: string, start: number, end: number): number {
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c === ':') return i > start && /^[a-zA-Z_]+$/.test(text.slice(start, i)) ? i : -1;
    if (c === '"') return -1;
  }
  return -1;
}

export function parseToken(text: string, span: Span): Token {
  const raw = text.slice(span.start, span.end);
  const negated = raw.length > 1 && raw[0] === '-';
  const bodyStart = span.start + (negated ? 1 : 0);
  const colon = findColon(text, bodyStart, span.end);

  if (colon < 0) {
    const value = unquote(text.slice(bodyStart, span.end));
    return {
      ...span,
      raw,
      kind: 'text',
      negated,
      values: [{ start: bodyStart, end: span.end, text: value, invalid: false }],
      status: 'ok',
      message: /^#?\d+$/.test(value) ? 'Also matches the item number' : undefined,
      predicates: [{ field: 'text', values: [value], negated }],
    };
  }

  const keyText = text.slice(bodyStart, colon).toLowerCase();
  const values: ValuePart[] = splitValues(text, colon + 1, span.end).map((p) => ({
    ...p,
    text: unquote(text.slice(p.start, p.end)),
    invalid: false,
  }));
  const token: Token = {
    ...span,
    raw,
    kind: 'qualifier',
    negated,
    key: { start: bodyStart, end: colon, text: keyText },
    values,
    status: 'ok',
    predicates: [],
  };
  const nonEmpty = values.filter((v) => v.text !== '');
  const incomplete = nonEmpty.length !== values.length;

  if (keyText === 'is') {
    const fields = new Set<string>();
    for (const v of nonEmpty) {
      const exp = IS_SHORTHAND[v.text.toLowerCase()];
      if (exp) fields.add(exp.field);
      else v.invalid = true;
    }
    if (nonEmpty.some((v) => v.invalid)) {
      token.status = 'error';
      token.message = `Unknown is: value (expected ${Object.keys(IS_SHORTHAND).join(', ')})`;
    } else if (fields.size > 1) {
      token.status = 'error';
      token.message = `is: clause mixes dimensions (${[...fields].join(', ')}); use separate clauses`;
    } else if (fields.size === 1) {
      const field = [...fields][0];
      token.predicates = [
        { field, values: nonEmpty.map((v) => IS_SHORTHAND[v.text.toLowerCase()].value), negated },
      ];
    }
  } else {
    const spec = KEY_MAP.get(keyText);
    if (!spec) {
      token.status = 'error';
      token.message = `Unknown key "${keyText}"`;
    } else {
      if (spec.closed) {
        for (const v of nonEmpty) {
          if (!spec.closed.includes(v.text.toLowerCase())) v.invalid = true;
        }
      }
      if (nonEmpty.some((v) => v.invalid)) {
        token.status = 'error';
        token.message = `Invalid ${keyText}: value (expected ${spec.closed?.join(', ')})`;
      } else {
        token.predicates = [{ field: keyText, values: nonEmpty.map((v) => v.text), negated }];
        if (keyText === 'triage' && nonEmpty.some((v) => v.text.toLowerCase() === 'all')) {
          token.message = 'triage:all = triage:inbox,acked';
        }
      }
    }
  }
  if (token.status === 'ok' && (incomplete || nonEmpty.length === 0)) {
    token.status = 'incomplete';
    token.message = nonEmpty.length === 0 ? 'Missing value' : 'Empty value after comma';
  }
  return token;
}

export function parseQuery(text: string): Token[] {
  return scanTokens(text).map((s) => parseToken(text, s));
}

// Classifies every character of a token for rendering. Segments cover the
// token span exactly, so renderers can map click offsets back to the text.
export function segmentToken(text: string, token: Token): Segment[] {
  const segs: Segment[] = [];
  if (token.negated) segs.push({ start: token.start, end: token.start + 1, role: 'neg' });
  if (token.kind === 'text' || !token.key) {
    segs.push({ start: token.start + (token.negated ? 1 : 0), end: token.end, role: 'text' });
    return segs;
  }
  const badKey = token.key.text !== 'is' && !KEY_MAP.has(token.key.text);
  segs.push({ start: token.key.start, end: token.key.end, role: badKey ? 'badkey' : 'key' });
  segs.push({ start: token.key.end, end: token.key.end + 1, role: 'colon' });
  token.values.forEach((v, i) => {
    if (i > 0) segs.push({ start: v.start - 1, end: v.start, role: 'comma' });
    if (v.end > v.start) segs.push({ start: v.start, end: v.end, role: v.invalid ? 'badvalue' : 'value' });
  });
  return segs.filter((s) => s.end > s.start && text.length >= s.end);
}

export function formatPredicate(p: Predicate): string {
  const vals = p.values.map(quoteIfNeeded).join(',');
  return `${p.negated ? '-' : ''}${p.field === 'text' ? vals : `${p.field}:${vals}`}`;
}

export interface QuerySummary {
  tokens: Token[];
  predicates: Predicate[];
  errors: Token[];
  implicitInbox: boolean;
  canonical: string;
}

export function summarize(text: string): QuerySummary {
  const tokens = parseQuery(text);
  const predicates = tokens.flatMap((t) => t.predicates);
  return {
    tokens,
    predicates,
    errors: tokens.filter((t) => t.status === 'error'),
    implicitInbox: !predicates.some((p) => p.field === 'triage'),
    canonical: predicates.map(formatPredicate).join(' '),
  };
}

// ---------------------------------------------------------------------------
// Autocomplete

export interface Suggestion {
  label: string;
  insert: string;
  kind: 'key' | 'value' | 'shorthand';
  detail?: string;
}

export interface SuggestionResult extends Span {
  // Replace text[start, end) with the suggestion's insert text.
  items: Suggestion[];
}

const MAX_ITEMS = 8;

// Suggestions for the token under the caret. Key suggestions appear once a
// prefix is typed (or always when showEmpty); value suggestions appear after
// "key:" and after each comma.
export function suggest(text: string, caret: number, showEmpty: boolean): SuggestionResult | null {
  const span = scanTokens(text).find((s) => s.start <= caret && caret <= s.end) ?? { start: caret, end: caret };
  const token = span.end > span.start ? parseToken(text, span) : null;
  const bodyStart = span.start + (token?.negated ? 1 : 0);

  if (!token?.key || caret <= token.key.end) {
    // Key context.
    if (caret < bodyStart) return null;
    const prefix = text.slice(bodyStart, caret).toLowerCase();
    if (prefix === '' && !showEmpty) return null;
    if (prefix.startsWith('"')) return null;
    const end = token?.key ? token.key.end + 1 : span.end;
    const keys: Suggestion[] = KEYS.filter((k) => k.key.startsWith(prefix)).map((k) => ({
      label: `${k.key}:`,
      insert: `${k.key}:`,
      kind: 'key',
      detail: k.description,
    }));
    const shorthands: Suggestion[] =
      prefix.length >= 2
        ? Object.entries(IS_SHORTHAND)
            .filter(([v]) => v.startsWith(prefix) || `is:${v}`.startsWith(prefix))
            .map(([v, exp]) => ({ label: `is:${v}`, insert: `is:${v}`, kind: 'shorthand', detail: `${exp.field}:${exp.value}` }))
        : [];
    const items = [...keys, ...shorthands].slice(0, MAX_ITEMS);
    return items.length ? { start: bodyStart, end, items } : null;
  }

  // Value context.
  const options = valuesForKey(token.key.text);
  if (!options) return null;
  const seg = token.values.find((v) => v.start <= caret && caret <= v.end);
  if (!seg) return null;
  const prefix = unquote(text.slice(seg.start, caret)).toLowerCase();
  const used = new Set(token.values.filter((v) => v !== seg).map((v) => v.text.toLowerCase()));
  const items: Suggestion[] = options
    .filter((o) => !used.has(o.toLowerCase()) && o.toLowerCase().includes(prefix))
    .sort((a, b) => Number(!a.toLowerCase().startsWith(prefix)) - Number(!b.toLowerCase().startsWith(prefix)))
    .slice(0, MAX_ITEMS)
    .map((o) => {
      const exp = token.key?.text === 'is' ? IS_SHORTHAND[o] : undefined;
      return { label: o, insert: quoteIfNeeded(o), kind: 'value', detail: exp ? `${exp.field}:${exp.value}` : undefined };
    });
  // Hide the list when the only option is exactly what is already typed.
  if (items.length === 1 && items[0].label.toLowerCase() === prefix) return null;
  return items.length ? { start: seg.start, end: seg.end, items } : null;
}

// Applies a suggestion to text, returning the new text and caret position.
export function applySuggestion(text: string, r: SuggestionResult, s: Suggestion): { text: string; caret: number } {
  const next = text.slice(0, r.start) + s.insert + text.slice(r.end);
  return { text: next, caret: r.start + s.insert.length };
}
