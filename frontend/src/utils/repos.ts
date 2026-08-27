import {
  matchWildcard,
  parseFilterPatterns,
  serializeFilterPatterns,
  validateBasePattern,
  validatePatterns,
  validateFilterPatterns,
  filterByPatterns,
  type ParsedFilterPatterns,
} from './patterns';

export {
  matchWildcard,
  parseFilterPatterns,
  serializeFilterPatterns,
  type ParsedFilterPatterns,
};

/**
 * Validates a single repository pattern (e.g. "kubernetes/*", "kubernetes/kubernetes", or "!kubernetes/steering").
 * Returns an error message if invalid, or null if valid.
 */
export function validateRepoPattern(pattern: string): string | null {
  const baseResult = validateBasePattern(pattern, 'Repository');
  if (!baseResult.valid) {
    return baseResult.error;
  }

  const { rawTrimmed, cleanPattern, isExclude } = baseResult;
  const parts = cleanPattern.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return `Repository pattern "${rawTrimmed}" must be in "owner/repo" format (e.g. "kubernetes/*" or "${isExclude ? '!' : ''}kubernetes/kubernetes")`;
  }

  for (let i = 0; i < cleanPattern.length; i++) {
    const ch = cleanPattern[i];
    const isAlphanumeric = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
    const isAllowedSymbol = ch === '-' || ch === '_' || ch === '.' || ch === '/' || ch === '*' || ch === '?';
    if (!isAlphanumeric && !isAllowedSymbol) {
      return `Repository pattern "${rawTrimmed}" contains invalid character "${ch}"`;
    }
  }
  return null;
}

/**
 * Validates a list of repository patterns. Returns the first error message, or null if valid.
 */
export function validateRepoPatterns(patterns: string[]): string | null {
  return validatePatterns(patterns, validateRepoPattern);
}

/**
 * Validates a multi-line repository filter string. Returns the first error message, or null if valid.
 */
export function validateRepoFilterPatterns(patternsText: string): string | null {
  return validateFilterPatterns(patternsText, validateRepoPattern);
}

/**
 * Filters a list of repositories based on included and excluded wildcard patterns.
 * If includedPatterns is non-empty, repos must match at least one include pattern.
 * If excludedPatterns is non-empty, repos matching any exclude pattern are removed.
 * Exclude patterns take precedence over include patterns.
 */
export function filterRepos(
  repos: string[],
  includedPatterns?: string[],
  excludedPatterns?: string[]
): string[] {
  return filterByPatterns(repos, repo => repo, includedPatterns, excludedPatterns);
}
