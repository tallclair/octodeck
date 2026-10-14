import type { Span } from './types';

export interface ScannedClause extends Span {
  readonly raw: string;
}

/**
 * Splits query text into raw clause spans separated by whitespace outside quotes.
 *
 * Inside quotes, `\` and the immediately following character are consumed together as a two-character
 * escape unit so that `\\` followed by `"` closes the string (`label:"a b\\"`), while `\"` stays
 * inside the string. Unterminated quotes run to the end of `text`. Backslashes outside quotes are
 * ordinary characters.
 */
export function scan(text: string): ScannedClause[] {
  const clauses: ScannedClause[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    while (i < n && /\s/.test(text[i])) {
      i++;
    }
    if (i >= n) break;

    const start = i;
    let inQuote = false;
    while (i < n) {
      const ch = text[i];
      if (inQuote) {
        if (ch === '\\') {
          i += i + 1 < n ? 2 : 1;
          continue;
        }
        if (ch === '"') {
          inQuote = false;
        }
        i++;
      } else {
        if (/\s/.test(ch)) break;
        if (ch === '"') {
          inQuote = true;
        }
        i++;
      }
    }

    clauses.push({ start, end: i, raw: text.slice(start, i) });
  }

  return clauses;
}
