// Pure helpers that decide how the query input decorates each clause of the query text. They
// work on the text plus spans from the real parser (syntax/), so nothing here forks the grammar.
import type { Clause, ParsedQuery, Segment, Span } from './syntax';
import { scan } from './syntax';

/**
 * Visual tone of a clause pill. `draft` is an incomplete clause the caret is still inside: it is
 * shown neutrally so a half-typed `label:` does not flash amber on every keystroke.
 */
export type ClauseTone =
  | 'ok'
  | 'negated'
  | 'error'
  | 'incomplete'
  | 'draft'
  | 'term'
  | 'negatedTerm';

/**
 * Tone of `clause`. A server error (ExprError mapped to this clause) turns an otherwise valid
 * clause into an error. `caretInside` is only true while the field is focused.
 */
export function clauseTone(clause: Clause, caretInside: boolean, serverError = false): ClauseTone {
  if (clause.status === 'error' || serverError) return 'error';
  if (clause.status === 'incomplete') return caretInside ? 'draft' : 'incomplete';
  if (clause.kind === 'term') return clause.negated ? 'negatedTerm' : 'term';
  return clause.negated ? 'negated' : 'ok';
}

/**
 * Index of the clause whose span contains `offset`, treating both edges as inside (a caret right
 * after `bug` is "in" `label:bug`). Returns -1 when the offset is in whitespace between clauses.
 * Clauses are separated by whitespace, so at most one clause can touch an offset.
 */
export function clauseIndexAt(parsed: ParsedQuery, offset: number): number {
  return parsed.clauses.findIndex((c) => offset >= c.start && offset <= c.end);
}

/**
 * The exact range `removeClause` (textEdit.ts) deletes: the clause plus the following whitespace
 * run, or the preceding run when the clause is last. Lets a focused field apply the removal as
 * one native edit (keeping the browser's undo stack) with the same result as `removeClause`.
 */
export function clauseRemovalRange(text: string, clause: Span): Span {
  const after = text.slice(clause.end);
  const trailingWs = /^\s+/.exec(after)?.[0].length ?? 0;
  if (after.length > trailingWs) {
    return { start: clause.start, end: clause.end + trailingWs };
  }
  const leadingWs = /\s+$/.exec(text.slice(0, clause.start))?.[0].length ?? 0;
  return { start: clause.start - leadingWs, end: clause.end + trailingWs };
}

/** Whether a clause has a specific bad key/value segment (otherwise errors mark the whole clause). */
export function hasBadSegment(segments: readonly Segment[]): boolean {
  return segments.some((s) => s.role === 'badkey' || s.role === 'badvalue');
}

/**
 * Query text with clause whitespace normalised: single spaces between clauses, no leading or
 * trailing whitespace. This is the form every writer of the dashboard's query text maintains.
 */
export function normalizeQuerySpacing(text: string): string {
  return scan(text)
    .map((c) => c.raw)
    .join(' ');
}
