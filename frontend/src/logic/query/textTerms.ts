// Splits the search box into free-text terms (design §4.5): separate words are ANDed and
// "quoted phrases" match exactly. This is deliberately not a query parser: `key:value` and a
// leading '-' are kept as plain text (Phase 0 has no text query syntax).

const TERM = /"([^"]*)(?:"|$)|[^\s"]+/g;

/** Returns the search terms in order: one per bare word or quoted phrase. */
export function tokenizeSearch(q: string): string[] {
  const terms: string[] = [];
  for (const match of q.matchAll(TERM)) {
    if (match[1] !== undefined) {
      // Quoted phrase (an unterminated quote runs to the end); trim its ends, keep inner spacing.
      const phrase = match[1].trim();
      if (phrase) terms.push(phrase);
    } else {
      terms.push(match[0]);
    }
  }
  return terms;
}
