/**
 * Selector hygiene rules for the DOM contract (docs/internal/extension_dom_engine_design.md 4.6).
 * Used by tests over every registered variant; not used at runtime.
 */

/**
 * Primer React hashed classes (prc-Component-Part-abc12) and CSS-module classes (name__hash).
 * The hash must contain a digit or an uppercase letter, so BEM elements like `block__header`
 * aren't mistaken for hashes.
 */
const HASH = '(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{5,8}';
const HASHED_CLASS = new RegExp(`^(?:prc-[A-Za-z]+(?:-[A-Za-z]+)+-${HASH}|[A-Za-z][A-Za-z0-9_-]*__${HASH})$`);

export function isHashedClassToken(token: string): boolean {
  return HASHED_CLASS.test(token);
}

/** Class tokens used in a selector via `.token`. */
export function classTokens(selector: string): string[] {
  return Array.from(selector.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g), (m) => m[1]);
}

/** Problems with one selector; `primary` selectors are held to the strictest rules. */
export function selectorProblems(selector: string, primary: boolean): string[] {
  const problems: string[] = [];
  for (const token of classTokens(selector)) {
    if (isHashedClassToken(token)) problems.push(`hashed class .${token}`);
  }
  // Partial class matches against generated names are allowed only as fallbacks.
  if (primary && /\[class\*=/.test(selector)) problems.push('partial class match ([class*=]) in a primary selector');
  try {
    document.createDocumentFragment().querySelector(selector);
  } catch {
    problems.push('invalid selector');
  }
  return problems;
}
