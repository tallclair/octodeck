/**
 * URL-hash anchor patterns for GitHub timeline targets
 * (docs/internal/extension_dom_engine_design.md section 9.5, step 1).
 *
 * These are GitHub's documented permalink id shapes, not selectors. React variants may prefix
 * them (e.g. `${commentAnchorPrefix}issuecomment-N`), so matching is by suffix and numeric id
 * as well as exact id.
 */

/** Kinds of timeline targets a permalink hash can point at. */
export type AnchorKind =
  | 'issueComment'
  | 'reviewComment'
  | 'review'
  | 'event'
  | 'description'
  | 'crossReference'
  | 'commitsPushed';

export interface ParsedAnchor {
  kind: AnchorKind;
  /** The hash as given (decoded, without '#'). */
  hash: string;
  /** The canonical, unprefixed id GitHub uses in classic markup (e.g. 'issuecomment-123'). */
  canonicalId: string;
  /** Numeric database id (or the short commit sha for commitsPushed). */
  id: string;
  /** Whether the target is a comment GitHub may hold back in a collapsed thread or hidden-comment loader. */
  isComment: boolean;
}

interface AnchorPattern {
  kind: AnchorKind;
  /** Anchored at the end so variant prefixes are tolerated; group 1 is the id. */
  re: RegExp;
  canonical: (id: string) => string;
  isComment: boolean;
}

const PATTERNS: readonly AnchorPattern[] = [
  { kind: 'issueComment', re: /(?:^|-)issuecomment-(\d+)$/, canonical: (id) => `issuecomment-${id}`, isComment: true },
  { kind: 'reviewComment', re: /(?:^|-)discussion_r(\d+)$/, canonical: (id) => `discussion_r${id}`, isComment: true },
  { kind: 'review', re: /(?:^|-)pullrequestreview-(\d+)$/, canonical: (id) => `pullrequestreview-${id}`, isComment: false },
  { kind: 'event', re: /^event-(\d+)$/, canonical: (id) => `event-${id}`, isComment: false },
  { kind: 'crossReference', re: /^ref-(?:pullrequest|issue|commit)-(\w+)$/, canonical: (id) => id, isComment: false },
  { kind: 'commitsPushed', re: /^commits-pushed-([0-9a-f]{7,40})$/, canonical: (id) => `commits-pushed-${id}`, isComment: false },
  { kind: 'description', re: /^(?:issue|pullrequest)-(\d+)$/, canonical: (id) => id, isComment: false },
];

/** Upper bound on hash length we consider; longer values are not GitHub permalinks. */
const MAX_HASH_LENGTH = 200;

/**
 * Parses a URL hash (with or without the leading '#', URL-encoded or not) into a timeline target.
 * Returns null for anything else (diff anchors, markdown headings, empty hashes).
 */
export function parseAnchor(rawHash: string): ParsedAnchor | null {
  let hash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
  try {
    hash = decodeURIComponent(hash);
  } catch {
    // Malformed escapes: keep the raw value; it simply won't match a pattern.
  }
  if (!hash || hash.length > MAX_HASH_LENGTH) return null;

  for (const p of PATTERNS) {
    const m = p.re.exec(hash);
    if (!m) continue;
    const id = m[1];
    // crossReference/description keep the whole canonical id (the type word is part of it).
    const canonicalId = p.kind === 'crossReference' || p.kind === 'description' ? hash : p.canonical(id);
    return { kind: p.kind, hash, canonicalId, id, isComment: p.isComment };
  }
  return null;
}

/**
 * True when a DOM id denotes the same target as the parsed anchor: the exact hash, the canonical
 * id, or the canonical id behind a variant prefix ending in '-'.
 */
export function idMatchesAnchor(domId: string, anchor: ParsedAnchor): boolean {
  if (domId === anchor.hash || domId === anchor.canonicalId) return true;
  return domId.endsWith(`-${anchor.canonicalId}`);
}
