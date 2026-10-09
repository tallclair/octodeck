// The dashboard's URL vocabulary: one row per query field that can appear as a URL parameter.
// A single table drives URL parsing and serialization, chip labels and the canonical position
// at which a newly added predicate is inserted.
import { Field } from '../../api/octodeck/v1/query_pb';
import type { FilterPredicate } from '../../types/filters';

export interface UrlFieldSpec {
  readonly field: Field;
  /** URL parameter name (a leading '-' marks a negated predicate). */
  readonly key: string;
  /**
   * Canonical position. Predicates added through the UI are inserted before the first predicate
   * with a higher rank, which reproduces the parameter order of today's URLs.
   */
  readonly rank: number;
  /** Human-readable name used on generic filter chips. */
  readonly label: string;
  /** Converts a trimmed URL value to a model value; null drops the value. */
  readonly decode: (raw: string) => string | null;
  /** Converts a model value back to its URL form. */
  readonly encode: (value: string) => string;
}

const identity = (v: string) => v;
const openValue = (raw: string): string | null => raw || null;
const closedValue =
  (allowed: readonly string[]) =>
  (raw: string): string | null => {
    const v = raw.toLowerCase();
    return allowed.includes(v) ? v : null;
  };

// tracking is written as tracked/untracked (today's URLs) but is a boolean in the query model.
const TRACKING_URL_TO_MODEL: Readonly<Record<string, string>> = {
  tracked: 'true',
  true: 'true',
  untracked: 'false',
  false: 'false',
};
const TRACKING_MODEL_TO_URL: Readonly<Record<string, string>> = { true: 'tracked', false: 'untracked' };

/** Legacy `triage=activity`: the "New" tab, which is inbox plus `new:any` (design §4.6). */
export const ACTIVITY_TRIAGE_VALUE = 'activity';
/** `@me`: the authenticated user (author/assignee). */
export const ME_VALUE = '@me';
/** Legacy `assigned=me` URL parameter, the "Assigned to me" toggle. */
export const LEGACY_ASSIGNED_KEY = 'assigned';
export const LEGACY_ASSIGNED_ME = 'me';

/** Parameters that are not predicates. Written after the predicates, in this order. */
export const TAIL_KEYS = ['q', 'sort', 'order', 'item'] as const;

export const URL_FIELDS: readonly UrlFieldSpec[] = [
  { field: Field.TRIAGE, key: 'triage', rank: 0, label: 'Triage', decode: closedValue(['inbox', 'acked', 'all']), encode: identity },
  { field: Field.STATE, key: 'state', rank: 1, label: 'State', decode: closedValue(['open', 'closed', 'merged']), encode: identity },
  { field: Field.TYPE, key: 'type', rank: 2, label: 'Type', decode: closedValue(['pr', 'issue']), encode: identity },
  { field: Field.ASSIGNEE, key: 'assignee', rank: 3, label: 'Assignee', decode: openValue, encode: identity },
  {
    field: Field.TRACKING,
    key: 'tracking',
    rank: 4,
    label: 'Tracking',
    decode: (raw) => TRACKING_URL_TO_MODEL[raw.toLowerCase()] ?? null,
    encode: (v) => TRACKING_MODEL_TO_URL[v] ?? v,
  },
  { field: Field.REPO, key: 'repo', rank: 5, label: 'Repo', decode: openValue, encode: identity },
  { field: Field.ORG, key: 'org', rank: 6, label: 'Org', decode: openValue, encode: identity },
  {
    field: Field.AUTHOR,
    key: 'author',
    rank: 7,
    label: 'Author',
    // Today's URLs strip one leading '@', so author=@me means the login "me", not the @me token.
    decode: (raw) => raw.replace(/^@/, '') || null,
    encode: identity,
  },
  { field: Field.MILESTONE, key: 'milestone', rank: 8, label: 'Milestone', decode: openValue, encode: identity },
  { field: Field.LABEL, key: 'label', rank: 9, label: 'Label', decode: openValue, encode: identity },
  { field: Field.DRAFT, key: 'draft', rank: 10, label: 'Draft', decode: closedValue(['true', 'false']), encode: identity },
  { field: Field.STARRED, key: 'starred', rank: 11, label: 'Starred', decode: closedValue(['true', 'false']), encode: identity },
  {
    field: Field.NEW,
    key: 'new',
    rank: 12,
    label: 'New',
    decode: closedValue(['item', 'mention', 'comment', 'code', 'noise', 'any']),
    encode: identity,
  },
  { field: Field.NO, key: 'no', rank: 13, label: 'No', decode: closedValue(['assignee', 'label', 'milestone']), encode: identity },
  { field: Field.IN, key: 'in', rank: 14, label: 'In', decode: closedValue(['title', 'body']), encode: identity },
];

const BY_KEY: ReadonlyMap<string, UrlFieldSpec> = new Map(URL_FIELDS.map((s) => [s.key, s]));
const BY_FIELD: ReadonlyMap<Field, UrlFieldSpec> = new Map(URL_FIELDS.map((s) => [s.field, s]));

export function specForKey(key: string): UrlFieldSpec | undefined {
  return BY_KEY.get(key);
}

export function specForField(field: Field): UrlFieldSpec | undefined {
  return BY_FIELD.get(field);
}

/** The "New" tab's predicate: non-negated `new:any`. Shown as the triage tab when no triage predicate is present. */
export function isActivityPredicate(p: FilterPredicate): boolean {
  return p.field === Field.NEW && !p.negated && p.values.length === 1 && p.values[0] === 'any';
}

/** The "Assigned to me" toggle's predicate (either sign): `assignee:@me`. */
export function isAssignedToMePredicate(p: FilterPredicate): boolean {
  return p.field === Field.ASSIGNEE && p.values.length === 1 && p.values[0] === ME_VALUE;
}

/** Canonical rank of a predicate; the activity predicate sits with triage. */
export function rankOf(p: FilterPredicate): number {
  if (isActivityPredicate(p)) return 0;
  return specForField(p.field)?.rank ?? URL_FIELDS.length;
}
