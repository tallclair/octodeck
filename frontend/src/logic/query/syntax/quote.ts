const BARE_VALUE_RE = /^[^\s,"]+$/;
const BARE_TERM_RE = /^[^\s"]+$/;
const QUALIFIER_PREFIX_RE = /^[A-Za-z_]+:/;

export function escapeQuoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Formats one qualifier value. Bare if `/^[^\s,"]+$/`, otherwise quoted with `\\` and `\"` escapes.
 */
export function formatValue(value: string): string {
  if (BARE_VALUE_RE.test(value)) {
    return value;
  }
  return escapeQuoted(value);
}

/**
 * Formats one free-text term. Bare if `/^[^\s"]+$/` and it does not start with `-` and does not
 * match `/^[A-Za-z_]+:/`; otherwise quoted with `\\` and `\"` escapes.
 */
export function formatTerm(value: string): string {
  if (
    BARE_TERM_RE.test(value) &&
    !value.startsWith('-') &&
    !QUALIFIER_PREFIX_RE.test(value)
  ) {
    return value;
  }
  return escapeQuoted(value);
}
