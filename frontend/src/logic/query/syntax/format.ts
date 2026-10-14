import { type Expr, Field } from '../../../api/octodeck/v1/query_pb';
import type { FilterPredicate } from '../../../types/filters';
import type { ExprInit } from '../expr';
import { ME_VALUE, specForField } from '../vocabulary';
import { parseQuery } from './parse';
import { escapeQuoted, formatTerm, formatValue } from './quote';

export { escapeQuoted, formatTerm, formatValue };

export class QueryFormatError extends Error {
  readonly path: string;

  constructor(message: string, path = '') {
    super(path ? `${path}: ${message}` : message);
    this.name = 'QueryFormatError';
    this.path = path;
  }
}

function normalizeFormattedValue(field: Field, value: string, isClosed: boolean): string {
  if (isClosed) {
    return value.toLowerCase();
  }
  if (
    (field === Field.AUTHOR || field === Field.ASSIGNEE) &&
    value.toLowerCase() === ME_VALUE
  ) {
    return ME_VALUE;
  }
  return value;
}

/** Formats a single FilterPredicate into canonical query text. */
export function formatPredicate(p: FilterPredicate): string {
  const prefix = p.negated ? '-' : '';
  if (p.field === Field.TEXT) {
    return `${prefix}${formatTerm(p.values[0] ?? '')}`;
  }
  const spec = specForField(p.field);
  if (!spec) {
    throw new QueryFormatError(`unknown field: ${String(p.field)}`, 'predicate.field');
  }
  if (p.negated && !spec.negatable) {
    throw new QueryFormatError(`${spec.key} predicate cannot be negated`, 'predicate.negated');
  }
  const isClosed = Boolean(spec.closed);
  const formattedValues = p.values
    .map((v) => formatValue(normalizeFormattedValue(p.field, v, isClosed)))
    .join(',');
  return `${prefix}${spec.key}:${formattedValues}`;
}

/** Formats a list of FilterPredicates joined by single spaces. */
export function formatPredicates(ps: readonly FilterPredicate[]): string {
  return ps.map(formatPredicate).join(' ');
}

interface RawPredicateShape {
  readonly field?: Field;
  readonly values?: readonly string[];
  readonly negated?: boolean;
}

function validateAndConvertPredicate(
  raw: RawPredicateShape | undefined,
  path: string
): FilterPredicate {
  if (!raw) {
    throw new QueryFormatError('missing predicate value', path);
  }
  const field = raw.field ?? Field.UNSPECIFIED;
  const values = raw.values ?? [];
  const negated = Boolean(raw.negated);

  if (values.length === 0) {
    throw new QueryFormatError('predicate must have at least one value', `${path}.values`);
  }
  for (let j = 0; j < values.length; j++) {
    if (values[j] === '') {
      throw new QueryFormatError('predicate value must not be empty', `${path}.values[${j}]`);
    }
  }

  if (field === Field.TEXT) {
    if (values.length !== 1) {
      throw new QueryFormatError(
        'text predicate must have exactly one value',
        `${path}.values`
      );
    }
    return { field: Field.TEXT, values: [values[0]], negated };
  }

  const spec = specForField(field);
  if (!spec) {
    throw new QueryFormatError(`unknown field: ${String(field)}`, `${path}.field`);
  }
  if (negated && !spec.negatable) {
    throw new QueryFormatError(`${spec.key} predicate cannot be negated`, `${path}.negated`);
  }
  if (spec.closed) {
    for (let j = 0; j < values.length; j++) {
      if (!spec.closed.includes(values[j].toLowerCase())) {
        throw new QueryFormatError(
          `invalid value "${values[j]}" for ${spec.key}`,
          `${path}.values[${j}]`
        );
      }
    }
  }

  return { field, values: [...values], negated };
}

/**
 * Formats a flat-AND Expr into canonical query text.
 * Throws QueryFormatError (with offending path) on `or`, `not`, nested `and`, negated `in`,
 * unknown fields, empty values, or multi-value `TEXT`.
 */
export function formatQuery(expr: ExprInit | Expr | undefined): string {
  if (!expr || !expr.kind || !expr.kind.case) {
    return '';
  }

  switch (expr.kind.case) {
    case 'or':
      throw new QueryFormatError('or expressions cannot be formatted as query text', 'or');
    case 'not':
      throw new QueryFormatError('not expressions cannot be formatted as query text', 'not');
    case 'predicate': {
      const p = validateAndConvertPredicate(expr.kind.value, 'predicate');
      return formatPredicate(p);
    }
    case 'and': {
      const children = expr.kind.value?.exprs ?? [];
      if (children.length === 0) return '';
      const predicates: FilterPredicate[] = children.map((child, i) => {
        const elemPath = `and.exprs[${i}]`;
        if (!child || !child.kind || !child.kind.case) {
          throw new QueryFormatError('empty expression in and list', elemPath);
        }
        if (child.kind.case !== 'predicate') {
          throw new QueryFormatError(
            `nested ${child.kind.case} cannot be formatted as query text`,
            `${elemPath}.${child.kind.case}`
          );
        }
        return validateAndConvertPredicate(child.kind.value, `${elemPath}.predicate`);
      });
      return formatPredicates(predicates);
    }
  }
}

/** Parses `text` and formats its ok predicates into canonical query text. */
export function canonicalQuery(text: string): string {
  return formatPredicates(parseQuery(text).predicates);
}
