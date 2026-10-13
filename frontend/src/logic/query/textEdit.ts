// Clause-level surgical text edits (Phase 2 §5).
// Dropdowns, triage tabs, and sidebar shortcuts edit the query text by splicing only the
// clause(s) they own, leaving every other clause (including `is:` shorthands, negated clauses,
// and error/incomplete clauses) byte-identical.
import { Field } from '../../api/octodeck/v1/query_pb';
import type { ControlKey, FilterControls, TriageFilter } from '../../types/filters';
import { controlToPredicate, projectClauses } from './predicates';
import { formatPredicate, parseQuery, type ParsedQuery, type Span } from './syntax';
import { ME_VALUE, isActivityPredicate, rankOf } from './vocabulary';

/** Replaces `clause` in `text` with `raw`. */
export function replaceClause(text: string, clause: Span, raw: string): string {
  return text.slice(0, clause.start) + raw + text.slice(clause.end);
}

/**
 * Removes `clause` and one adjacent whitespace run (the following run when another clause
 * follows; otherwise the preceding run), so no double spaces or leading/trailing spaces remain.
 */
export function removeClause(text: string, clause: Span): string {
  const before = text.slice(0, clause.start);
  const after = text.slice(clause.end);

  const trailingWs = /^\s+/.exec(after);
  const trailingWsLen = trailingWs ? trailingWs[0].length : 0;
  const hasFollowingContent = after.length > trailingWsLen;

  if (hasFollowingContent) {
    return before + after.slice(trailingWsLen);
  }

  const leadingWs = /\s+$/.exec(before);
  const leadingWsLen = leadingWs ? leadingWs[0].length : 0;
  return before.slice(0, before.length - leadingWsLen) + after.slice(trailingWsLen);
}

/** Removes the clause at `index` in `parsed.clauses` from `text`. */
export function removeClauseInText(
  text: string,
  parsed: ParsedQuery,
  index: number
): string {
  const clause = parsed.clauses[index];
  return clause ? removeClause(text, clause) : text;
}

/**
 * Inserts `raw` before the first `ok` clause whose canonical rank (`rankOf`) is greater than
 * `rank` (free-text terms rank after every qualifier), separated by a single space.
 * Empty text becomes `raw`.
 */
export function insertClause(
  text: string,
  parsed: ParsedQuery,
  raw: string,
  rank: number
): string {
  if (parsed.clauses.length === 0 || text.trim() === '') {
    return raw;
  }

  const target = parsed.clauses.find(
    (c) => c.status === 'ok' && c.predicate !== null && rankOf(c.predicate) > rank
  );
  if (target) {
    return text.slice(0, target.start) + raw + ' ' + text.slice(target.start);
  }

  const last = parsed.clauses[parsed.clauses.length - 1];
  return text.slice(0, last.end) + ' ' + raw + text.slice(last.end);
}

/**
 * Switches the triage tab in query text (§5):
 * - Removes every clause whose predicate is `Field.TRIAGE` (negated ones included, in reverse
 *   span order so offsets never go stale).
 * - When switching to `activity` (New tab), replaces the `activity` control's owned clause
 *   (whatever `new:` values it holds) with `new:any`, or inserts `new:any` at rank 0 if none.
 * - When switching to `inbox`, `acked`, or `all`, removes the `activity` clause only if it is
 *   `new:any`, and for `acked` / `all` inserts `triage:acked` / `triage:all` at rank 0.
 */
export function setTriageTabInText(
  text: string,
  parsed: ParsedQuery,
  tab: TriageFilter
): string {
  let currentText = text;
  let currentParsed = parsed;

  const triageClauses = currentParsed.clauses
    .filter((c) => c.predicate?.field === Field.TRIAGE)
    .reverse();
  if (triageClauses.length > 0) {
    for (const clause of triageClauses) {
      currentText = removeClause(currentText, clause);
    }
    currentParsed = parseQuery(currentText);
  }

  const { owners } = projectClauses(currentParsed);

  if (tab === 'activity') {
    if (owners.activity !== undefined) {
      return replaceClause(
        currentText,
        currentParsed.clauses[owners.activity],
        'new:any'
      );
    }
    return insertClause(currentText, currentParsed, 'new:any', 0);
  }

  if (owners.activity !== undefined) {
    const actClause = currentParsed.clauses[owners.activity];
    if (actClause.predicate && isActivityPredicate(actClause.predicate)) {
      currentText = removeClause(currentText, actClause);
      currentParsed = parseQuery(currentText);
    }
  }

  if (tab === 'acked' || tab === 'all') {
    return insertClause(currentText, currentParsed, `triage:${tab}`, 0);
  }
  return currentText;
}

/**
 * Sets one filter control in `text`, splicing only the clause that control currently owns (P2).
 * Enforces P3 (`org`/`repo` mutual exclusion) and P4 (`activity` `any` vs specific flags).
 */
export function setControlInText<K extends ControlKey>(
  text: string,
  parsed: ParsedQuery,
  key: K,
  value: FilterControls[K]
): string {
  if (key === 'triage') {
    return setTriageTabInText(text, parsed, value as TriageFilter);
  }

  let currentText = text;
  let currentParsed = parsed;

  // Enforce org/repo mutual exclusivity (P3): a non-empty org clears the owned repo clause, and vice versa.
  if (key === 'org' && (value as readonly string[]).length > 0) {
    const { owners } = projectClauses(currentParsed);
    if (owners.repo !== undefined) {
      currentText = removeClause(currentText, currentParsed.clauses[owners.repo]);
      currentParsed = parseQuery(currentText);
    }
  } else if (key === 'repo' && (value as readonly string[]).length > 0) {
    const { owners } = projectClauses(currentParsed);
    if (owners.org !== undefined) {
      currentText = removeClause(currentText, currentParsed.clauses[owners.org]);
      currentParsed = parseQuery(currentText);
    }
  }

  const { controls, owners } = projectClauses(currentParsed);
  const nonTriageKey = key as Exclude<ControlKey, 'triage'>;
  const next = controlToPredicate(
    nonTriageKey,
    value as FilterControls[typeof nonTriageKey],
    controls.activity
  );
  const ownerIndex = owners[key];

  if (ownerIndex !== undefined) {
    const clause = currentParsed.clauses[ownerIndex];
    if (!next) {
      return removeClause(currentText, clause);
    }
    return replaceClause(currentText, clause, formatPredicate(next));
  }

  if (!next) {
    return currentText;
  }
  return insertClause(currentText, currentParsed, formatPredicate(next), rankOf(next));
}

/**
 * Sidebar repo shortcut in query text: if the owned `repo` control is already `[repo]`, clear it;
 * otherwise set `repo` to `[repo]` (which also clears any owned `org` clause).
 */
export function toggleRepoInText(
  text: string,
  parsed: ParsedQuery,
  repo: string
): string {
  const current = projectClauses(parsed).controls.repo;
  const isSameSingle =
    current.length === 1 && current[0].toLowerCase() === repo.toLowerCase();
  return setControlInText(text, parsed, 'repo', isSameSingle ? [] : [repo]);
}

/**
 * Toggles `@me` in the `assignee` control's owned clause (P19), keeping any other selected assignees.
 */
export function toggleAssignedToMeInText(text: string, parsed: ParsedQuery): string {
  const current = projectClauses(parsed).controls.assignee;
  const hasMe = current.some((v) => v.toLowerCase() === ME_VALUE);
  const next = hasMe
    ? current.filter((v) => v.toLowerCase() !== ME_VALUE)
    : [ME_VALUE, ...current];
  return setControlInText(text, parsed, 'assignee', next);
}
