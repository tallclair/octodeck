import type { FilterPredicate } from '../../../types/filters';

/** Half-open UTF-16 code-unit range [start, end) into the query string. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export type ClauseStatus = 'ok' | 'incomplete' | 'error';

export type IssueCode =
  | 'missing-value'
  | 'empty-value'
  | 'unterminated-quote'
  | 'lone-dash'
  | 'unknown-key'
  | 'invalid-value'
  | 'mixed-is'
  | 'negated-in'
  | 'bad-quote'
  | 'empty-term';

export interface QueryIssue extends Span {
  readonly code: IssueCode;
  readonly message: string;
}

export interface ValueNode extends Span {
  /** Unquoted, unescaped value text. */
  readonly text: string;
  readonly quoted: boolean;
  readonly invalid: boolean;
}

export interface Clause extends Span {
  /** Exact substring from the input: text.slice(start, end). */
  readonly raw: string;
  readonly negated: boolean;
  readonly kind: 'qualifier' | 'term';
  /** Present for qualifiers. `text` is the lower-cased key; original casing is in `raw`. */
  readonly key?: Span & { readonly text: string };
  /** Qualifier value nodes (comma-separated) or the single value node of a term. */
  readonly values: readonly ValueNode[];
  readonly status: ClauseStatus;
  /** Set if and only if status === 'ok'. */
  readonly predicate: FilterPredicate | null;
  readonly issue?: QueryIssue;
  readonly note?: string;
}

export interface ParsedQuery {
  readonly text: string;
  readonly clauses: readonly Clause[];
  /** Predicates of the ok clauses, in text order. */
  readonly predicates: readonly FilterPredicate[];
  /** exprIndex -> clause index: predicates[i] came from clauses[clauseOfPredicate[i]]. */
  readonly clauseOfPredicate: readonly number[];
  readonly issues: readonly QueryIssue[];
}

export type SegmentRole =
  | 'neg'
  | 'key'
  | 'colon'
  | 'value'
  | 'badvalue'
  | 'badkey'
  | 'comma'
  | 'text';

export interface Segment extends Span {
  readonly role: SegmentRole;
}
