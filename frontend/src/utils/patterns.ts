export interface ParsedFilterPatterns {
  includes: string[];
  excludes: string[];
}

export const MAX_FILTER_PATTERN_LENGTH = 100;

/**
 * Performs case-insensitive wildcard matching ('*' matches 0+ chars, '?' matches 1 char).
 */
export function matchWildcard(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();

  const pLen = p.length;
  const tLen = t.length;
  let pIdx = 0;
  let tIdx = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (tIdx < tLen) {
    if (pIdx < pLen && (p[pIdx] === '?' || p[pIdx] === t[tIdx])) {
      pIdx++;
      tIdx++;
    } else if (pIdx < pLen && p[pIdx] === '*') {
      starIdx = pIdx;
      matchIdx = tIdx;
      pIdx++;
    } else if (starIdx !== -1) {
      pIdx = starIdx + 1;
      matchIdx++;
      tIdx = matchIdx;
    } else {
      return false;
    }
  }

  while (pIdx < pLen && p[pIdx] === '*') {
    pIdx++;
  }

  return pIdx === pLen;
}

/**
 * Parses a multi-line string into include and exclude patterns.
 * Lines starting with '!' are treated as exclude patterns.
 */
export function parseFilterPatterns(input: string): ParsedFilterPatterns {
  const lines = input.split('\n');
  const includes: string[] = [];
  const excludes: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('!')) {
      const pattern = trimmed.slice(1).trim();
      if (pattern) {
        excludes.push(pattern);
      }
    } else {
      includes.push(trimmed);
    }
  }

  return { includes, excludes };
}

/**
 * Serializes include and exclude pattern arrays into a multi-line string.
 * Exclude patterns are prefixed with '!'.
 */
export function serializeFilterPatterns(includes?: string[], excludes?: string[]): string {
  const lines: string[] = [];
  if (includes) {
    for (const inc of includes) {
      const trimmed = inc.trim();
      if (trimmed) lines.push(trimmed);
    }
  }
  if (excludes) {
    for (const exc of excludes) {
      const trimmed = exc.trim().replace(/^!/, '').trim();
      if (trimmed) lines.push(`!${trimmed}`);
    }
  }
  return lines.join('\n');
}

export type BasePatternValidation =
  | { valid: true; rawTrimmed: string; cleanPattern: string; isExclude: boolean; error: null }
  | { valid: false; rawTrimmed: string; cleanPattern: string; isExclude: boolean; error: string };

/**
 * Validates baseline pattern length, emptiness, and control characters.
 */
export function validateBasePattern(
  pattern: string,
  typeName: string
): BasePatternValidation {
  const rawTrimmed = pattern.trim();
  if (!rawTrimmed) {
    return { valid: false, rawTrimmed: '', cleanPattern: '', isExclude: false, error: `${typeName} pattern cannot be empty` };
  }
  const isExclude = rawTrimmed.startsWith('!');
  const cleanPattern = rawTrimmed.replace(/^!/, '').trim();
  if (!cleanPattern) {
    return { valid: false, rawTrimmed, cleanPattern: '', isExclude, error: `${typeName} pattern cannot be empty` };
  }
  if (cleanPattern.length > MAX_FILTER_PATTERN_LENGTH) {
    return {
      valid: false,
      rawTrimmed,
      cleanPattern,
      isExclude,
      error: `${typeName} pattern "${rawTrimmed}" exceeds maximum length of ${MAX_FILTER_PATTERN_LENGTH} characters`,
    };
  }
  for (let i = 0; i < cleanPattern.length; i++) {
    const code = cleanPattern.charCodeAt(i);
    if (code < 32 || code === 127) {
      return {
        valid: false,
        rawTrimmed,
        cleanPattern,
        isExclude,
        error: `${typeName} pattern "${rawTrimmed}" contains invalid control characters`,
      };
    }
  }
  return { valid: true, rawTrimmed, cleanPattern, isExclude, error: null };
}

/**
 * Validates a list of patterns using the provided validator function.
 * Empty or whitespace-only lines are ignored.
 * Returns the first error message, or null if all are valid.
 */
export function validatePatterns(
  patterns: string[],
  validateItemFn: (pattern: string) => string | null
): string | null {
  for (const p of patterns) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    const err = validateItemFn(trimmed);
    if (err) return err;
  }
  return null;
}

/**
 * Validates a multi-line filter patterns string.
 */
export function validateFilterPatterns(
  patternsText: string,
  validateItemFn: (pattern: string) => string | null
): string | null {
  const lines = patternsText.split('\n');
  return validatePatterns(lines, validateItemFn);
}

/**
 * Checks if a string value matches a set of include and exclude wildcard patterns.
 * Exclude patterns take precedence over include patterns.
 */
export function matchesFilter(
  text: string,
  includedPatterns?: string[],
  excludedPatterns?: string[]
): boolean {
  const activeIncludes = (includedPatterns || []).map(p => p.trim()).filter(Boolean);
  const activeExcludes = (excludedPatterns || []).map(p => p.trim()).filter(Boolean);

  if (activeIncludes.length > 0) {
    const matchesAnyInclude = activeIncludes.some(p => matchWildcard(p, text));
    if (!matchesAnyInclude) return false;
  }

  if (activeExcludes.length > 0) {
    const matchesAnyExclude = activeExcludes.some(p => matchWildcard(p, text));
    if (matchesAnyExclude) return false;
  }

  return true;
}

/**
 * Generic filter helper for items by wildcard patterns.
 */
export function filterByPatterns<T>(
  items: T[],
  getIdentifier: (item: T) => string | undefined,
  includedPatterns?: string[],
  excludedPatterns?: string[]
): T[] {
  const activeIncludes = (includedPatterns || []).map(p => p.trim()).filter(Boolean);
  const activeExcludes = (excludedPatterns || []).map(p => p.trim()).filter(Boolean);

  if (activeIncludes.length === 0 && activeExcludes.length === 0) {
    return items;
  }

  return items.filter(item => {
    const id = getIdentifier(item);
    if (!id) return false;
    return matchesFilter(id, activeIncludes, activeExcludes);
  });
}
