/**
 * Pure classification helpers for the GitHub timeline features (noise collapsing, Hide events,
 * timeline markers). They take plain data, never DOM selectors, so they are shared by the content
 * features and unit-tested in isolation.
 */
import { isAfterWatermark } from './ackState';

const BOT_SUFFIX_REGEX = /(?:\[bot\]|\[robot\]|-bot|_bot|-robot|_robot|\bbot\b|\brobot\b)/i;
const SLASH_CMD_REGEX = /^\/[a-z0-9_-]+(?:\s|:|$)/i;

/** Returns true when the login looks like a bot account or is in the known bots list. */
export function isBotLogin(login: string, knownBots: readonly string[] = []): boolean {
  if (!login) return false;
  const l = login.trim().toLowerCase();
  if (BOT_SUFFIX_REGEX.test(l)) return true;
  if (l.endsWith('[bot]') || l.endsWith('[robot]')) return true;
  const clean = l.replace(/\[(?:bot|robot)\]$/i, '').trim();
  return knownBots.some((b) => {
    const cleanB = b
      .trim()
      .toLowerCase()
      .replace(/\[(?:bot|robot)\]$/i, '')
      .trim();
    return clean === cleanB || l === cleanB;
  });
}

/** Returns true when every non-blank line of the body is a slash command (e.g. "/lgtm"). */
export function isSlashCommandBody(body: string): boolean {
  if (!body) return false;
  let hasCommand = false;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!SLASH_CMD_REGEX.test(trimmed)) return false;
    hasCommand = true;
  }
  return hasCommand;
}

export function extractFirstNonBlankLine(body: string): string {
  if (!body) return '';
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

export function extractRemainingLines(body: string): string {
  if (!body) return '';
  let firstNonBlankFound = false;
  const remainingLines: string[] = [];
  for (const line of body.split('\n')) {
    if (!firstNonBlankFound) {
      if (line.trim()) firstNonBlankFound = true;
    } else {
      remainingLines.push(line);
    }
  }
  return remainingLines.join('\n').trimEnd();
}

export function isCommentMultiLine(body: string): boolean {
  if (!body) return false;
  return (
    body
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean).length > 1
  );
}

export function buildCollapseSummaryText(commentsCount: number, eventsCount: number, authors: readonly string[]): string {
  let itemSummary: string;
  const cStr = commentsCount === 1 ? '1 comment' : `${commentsCount} comments`;
  const eStr = eventsCount === 1 ? '1 other event' : `${eventsCount} other events`;
  if (commentsCount > 0 && eventsCount > 0) {
    itemSummary = `${cStr} and ${eStr}`;
  } else if (commentsCount > 0) {
    itemSummary = cStr;
  } else if (eventsCount > 0) {
    itemSummary = eStr;
  } else {
    itemSummary = 'activity';
  }
  const authorText = authors.length > 0 ? ` from ${authors.map((a) => `@${a}`).join(', ')}` : '';
  return `${itemSummary}${authorText}`;
}

// ---------------------------------------------------------------------------
// Noise classification
// ---------------------------------------------------------------------------

/**
 * A timeline item or row kind, as exposed by the capability layer ('comment', 'event', ...). Kept
 * as a plain string so this shared logic module doesn't import extension types; the capability's
 * TimelineItemKind union is assignable to it.
 */
export type ClassifyKind = string;

/**
 * Row kinds Hide events may hide (decision 11, allowlist). Anything else, including unknown kinds,
 * close/reopen, references and reviews, always stays visible.
 */
export const HIDEABLE_ROW_KINDS: ReadonlySet<ClassifyKind> = new Set(['event', 'commit']);

/** Item kinds that are never part of noise handling at all. */
const NEVER_TOUCHED_ITEM_KINDS: ReadonlySet<ClassifyKind> = new Set(['description']);

/** Returns true when Hide events may hide this row: allowlisted kind and no markdown body. */
export function isRowHideable(row: { kind: ClassifyKind; hasBody: boolean }): boolean {
  return HIDEABLE_ROW_KINDS.has(row.kind) && !row.hasBody;
}

export interface NoiseInput {
  kind: ClassifyKind;
  authorLogin: string;
  /** The capability's page-local bot signal (bot badge next to the author). */
  isBotHint: boolean;
  /** The author links to a GitHub App (/apps/...); treated as a bot (decision 13). */
  isApp: boolean;
  bodyText: string;
}

export interface NoiseVerdict {
  isBot: boolean;
  isSlashCommand: boolean;
  /** Only plain issue comments can be noise; reviews (with or without comments) never are. */
  isNoise: boolean;
}

export function classifyNoise(input: NoiseInput, knownBots: readonly string[], viewerLogin: string | null): NoiseVerdict {
  const login = input.authorLogin.trim().toLowerCase();
  // The signed-in viewer is a human by definition, even if a stray heuristic fires or their login
  // was persisted to the known bots list.
  const isViewer = Boolean(viewerLogin) && login === viewerLogin!.trim().toLowerCase();
  const isBot = !isViewer && (isBotLogin(input.authorLogin, knownBots) || input.isBotHint || input.isApp);
  const isSlashCommand = isSlashCommandBody(input.bodyText);
  const isNoise = input.kind === 'comment' && (isBot || isSlashCommand);
  return { isBot, isSlashCommand, isNoise };
}

/** Per-item facts the run grouping needs. */
export interface RunInput {
  /** Collapsible noise comment. */
  isNoise: boolean;
  /** Every row of the item is hidden by Hide events. */
  fullyHidden: boolean;
  kind: ClassifyKind;
}

/**
 * Groups noise comments into runs (arrays of indices into `items`).
 *
 * - Events shown: only directly adjacent noise comments group; anything else breaks the run.
 * - Events hidden: fully hidden items don't break a run; every visible non-noise item does.
 */
export function computeCollapseRuns(items: readonly RunInput[], hideEvents: boolean): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];
  const flush = () => {
    if (current.length > 0) runs.push(current);
    current = [];
  };
  items.forEach((item, i) => {
    if (NEVER_TOUCHED_ITEM_KINDS.has(item.kind)) {
      flush();
      return;
    }
    if (item.isNoise) {
      current.push(i);
      return;
    }
    if (hideEvents && item.fullyHidden) return;
    flush();
  });
  flush();
  return runs;
}

/** Classification evidence for one timeline item or row. */
export interface ClassifyEvidence {
  kind: ClassifyKind;
  /** How the capability determined the kind ('gid' | 'structure' | 'heuristic'); items omit it. */
  kindSource?: string;
  hasBody: boolean;
}

/** Item kinds that legitimately carry a markdown body. */
const BODY_KINDS: ReadonlySet<ClassifyKind> = new Set(['comment', 'review', 'reviewThread', 'description', 'reference']);

/**
 * Returns a reason string when the classification itself looks drifted (section 7.3), so Hide
 * events skips this pass instead of acting on bad kinds. It tests classification evidence, not
 * page shape: bot PRs with no comments, or label-heavy timelines, are legitimate.
 *
 * - user content (a body) inside an item or row of unknown kind;
 * - a body inside an item whose kind never has one (e.g. 'event', 'commit');
 * - a hideable row whose kind came only from a text heuristic.
 */
export function hideSanityAnomaly(items: readonly ClassifyEvidence[], rows: readonly ClassifyEvidence[]): string | null {
  for (const e of [...items, ...rows]) {
    if (e.hasBody && e.kind === 'unknown') return 'body inside an item of unknown kind';
  }
  for (const item of items) {
    if (item.hasBody && !BODY_KINDS.has(item.kind)) return `body inside a '${item.kind}' item`;
  }
  for (const row of rows) {
    if (row.kindSource === 'heuristic' && HIDEABLE_ROW_KINDS.has(row.kind)) return 'hideable row classified by heuristic';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Timeline markers
// ---------------------------------------------------------------------------

export interface MarkerIndices {
  showViewIndex: number;
  showAckIndex: number;
}

export function calculateTimelineMarkerIndices(
  items: ReadonlyArray<{ timestamp: number }>,
  lastViewedAtMs: number | null,
  ackedActivityMs: number | null,
  options?: { wasViewMarkerShown?: boolean }
): MarkerIndices {
  if (items.length === 0) {
    return { showViewIndex: -1, showAckIndex: -1 };
  }

  // Both markers go before the first entry newer than their timestamp, compared at whole-second
  // precision: the effective last-viewed time may be the GitHub timestamp of the user's own
  // activity, which must not be placed after its own (possibly millisecond-precision) DOM entry.
  const newViewIndex =
    lastViewedAtMs && lastViewedAtMs > 0
      ? items.findIndex((item) => isAfterWatermark(item.timestamp, lastViewedAtMs))
      : -1;

  const newAckIndex =
    ackedActivityMs && ackedActivityMs > 0
      ? items.findIndex((item) => isAfterWatermark(item.timestamp, ackedActivityMs))
      : -1;

  // Suppress "Last Viewed" if:
  // 1. Both would appear at the exact same timeline position (newViewIndex === newAckIndex)
  // 2. Both are at the end (-1)
  const suppressLastViewed =
    ackedActivityMs !== null &&
    ackedActivityMs !== undefined &&
    ackedActivityMs > 0 &&
    ((newViewIndex !== -1 && newViewIndex === newAckIndex) || (newViewIndex === -1 && newAckIndex === -1));

  let showViewIndex = suppressLastViewed ? -1 : newViewIndex;
  if (options?.wasViewMarkerShown === false) {
    showViewIndex = -1;
  }
  return { showViewIndex, showAckIndex: newAckIndex };
}
