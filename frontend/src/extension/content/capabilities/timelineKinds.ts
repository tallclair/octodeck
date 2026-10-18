/**
 * GitHub GraphQL global-ID typename prefix -> timeline kind
 * (docs/internal/extension_dom_engine_design.md section 6.2).
 *
 * GitHub node ids start with a structured type tag (e.g. "IC_" = IssueComment, "PRR_" =
 * PullRequestReview). These tags are part of GitHub's ID format, not per-item opaque values, so
 * classifying by them does not depend on English text or icons.
 *
 * Only prefixes observed in fixtures or listed in the design are mapped. Anything else maps to
 * 'unknown', which is never hidden and is reported (TIMELINE_UNKNOWN_KIND) so the table can grow
 * from real drift records instead of guesses.
 */
import type { TimelineItemKind } from './types';

/** Typename prefix (without the trailing underscore) -> kind. */
export const GID_PREFIX_KINDS: Readonly<Record<string, TimelineItemKind>> = {
  IC: 'comment', // IssueComment
  PRR: 'review', // PullRequestReview
  PRRT: 'reviewThread', // PullRequestReviewThread
  CE: 'closeReopen', // ClosedEvent
  REE: 'closeReopen', // ReopenedEvent
  ME: 'closeReopen', // MergedEvent (merges stay visible)
  CRE: 'reference', // CrossReferencedEvent
  REFE: 'reference', // ReferencedEvent
  REF: 'reference', // ReferencedEvent (alternate encoding)
  C: 'commit', // Commit (classic "added N commits" group)
  PRC: 'commit', // PullRequestCommit
  // 'event' = allowlisted bodiless noise hidden by "Hide events" (decision 11 + #57): labels,
  // assignments, review requests, renames, projects, milestones, force-pushes, draft state,
  // branch refs, lock/pin, transfer and deployments.
  LE: 'event', // LabeledEvent
  UNLE: 'event', // UnlabeledEvent
  AE: 'event', // AssignedEvent
  UAE: 'event', // UnassignedEvent
  RTE: 'event', // RenamedTitleEvent
  RFRE: 'event', // ReadyForReviewEvent
  PR: 'description', // PullRequest
  I: 'description', // Issue
};


/** Extracts the typename prefix ("IC" from "IC_kwDO..."), or null when the id has no prefix. */
export function gidPrefix(nodeId: string | null | undefined): string | null {
  if (!nodeId) return null;
  const m = /^([A-Z][A-Z0-9]*)_[A-Za-z0-9]/.exec(nodeId);
  return m ? m[1] : null;
}

/**
 * Kind for a node id. Returns null when the id carries no typename prefix, and 'unknown' when the
 * prefix is not in the table (callers report TIMELINE_UNKNOWN_KIND).
 */
export function kindFromGid(nodeId: string | null | undefined): TimelineItemKind | null {
  const prefix = gidPrefix(nodeId);
  if (!prefix) return null;
  return GID_PREFIX_KINDS[prefix] ?? 'unknown';
}
