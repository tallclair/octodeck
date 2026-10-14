// The dashboard's query vocabulary: one row per qualifier field in the query language.
// A single table drives text parsing and formatting, legacy URL decoding, chip labels,
// autocomplete suggestions, and the canonical position at which a newly added clause is inserted.
import { Field } from '../../api/octodeck/v1/query_pb';
import type { FilterPredicate } from '../../types/filters';

export interface FieldSpec {
  readonly field: Field;
  /** Text qualifier key and legacy URL parameter name. */
  readonly key: string;
  /**
   * Canonical position. Clauses added through the UI are inserted before the first clause
   * with a higher rank, which reproduces the canonical parameter order.
   */
  readonly rank: number;
  /** Human-readable name used on menus, chips, and accessibility descriptions. */
  readonly label: string;
  /** One-line autocomplete detail. */
  readonly description: string;
  /** Allowed values for closed fields (lower-case, in proto order). Undefined for open fields. */
  readonly closed?: readonly string[];
  /** Legacy URL decoding quirk (tracking tracked/untracked, author leading '@'). */
  readonly legacyDecode?: (raw: string) => string | null;
  /** Whether the qualifier may be negated with '-'. False only for 'in'. */
  readonly negatable: boolean;
}

// tracking is written as tracked/untracked in legacy URLs but is a boolean in the query model.
const TRACKING_URL_TO_MODEL: Readonly<Record<string, string>> = {
  tracked: 'true',
  true: 'true',
  untracked: 'false',
  false: 'false',
};

/** Legacy `triage=activity`: the "New" tab, which is inbox plus `new:any` (design §4.6). */
export const ACTIVITY_TRIAGE_VALUE = 'activity';
/** `@me`: the authenticated user (author/assignee). */
export const ME_VALUE = '@me';
/** Legacy `assigned=me` URL parameter, the "Assigned to me" toggle. */
export const LEGACY_ASSIGNED_KEY = 'assigned';
export const LEGACY_ASSIGNED_ME = 'me';

/** Current URL parameters skipped by the legacy structured parameter decoder. */
export const TAIL_KEYS = ['q', 'sort', 'order', 'item'] as const;

export const FIELD_SPECS: readonly FieldSpec[] = [
  {
    field: Field.TRIAGE,
    key: 'triage',
    rank: 0,
    label: 'Triage',
    description: 'Triage bucket (inbox, acked, all)',
    closed: ['inbox', 'acked', 'all'],
    negatable: true,
  },
  {
    field: Field.STATE,
    key: 'state',
    rank: 1,
    label: 'State',
    description: 'Open / closed / merged',
    closed: ['open', 'closed', 'merged'],
    negatable: true,
  },
  {
    field: Field.TYPE,
    key: 'type',
    rank: 2,
    label: 'Type',
    description: 'Pull request or issue',
    closed: ['pr', 'issue'],
    negatable: true,
  },
  {
    field: Field.ASSIGNEE,
    key: 'assignee',
    rank: 3,
    label: 'Assignee',
    description: 'Assignee (login or @me)',
    negatable: true,
  },
  {
    field: Field.TRACKING,
    key: 'tracking',
    rank: 4,
    label: 'Tracking',
    description: 'Tracked items',
    closed: ['true', 'false'],
    legacyDecode: (raw) => TRACKING_URL_TO_MODEL[raw.toLowerCase()] ?? null,
    negatable: true,
  },
  {
    field: Field.REPO,
    key: 'repo',
    rank: 5,
    label: 'Repo',
    description: 'Repository (owner/name)',
    negatable: true,
  },
  {
    field: Field.ORG,
    key: 'org',
    rank: 6,
    label: 'Org',
    description: 'Repository owner',
    negatable: true,
  },
  {
    field: Field.AUTHOR,
    key: 'author',
    rank: 7,
    label: 'Author',
    description: 'Item author (login or @me)',
    // Legacy URLs strip one leading '@', so author=@me means the login "me", not the @me token.
    legacyDecode: (raw) => raw.replace(/^@/, '') || null,
    negatable: true,
  },
  {
    field: Field.MILESTONE,
    key: 'milestone',
    rank: 8,
    label: 'Milestone',
    description: 'Milestone name',
    negatable: true,
  },
  {
    field: Field.LABEL,
    key: 'label',
    rank: 9,
    label: 'Label',
    description: 'Label name',
    negatable: true,
  },
  {
    field: Field.DRAFT,
    key: 'draft',
    rank: 10,
    label: 'Draft',
    description: 'Draft PRs',
    closed: ['true', 'false'],
    negatable: true,
  },
  {
    field: Field.STARRED,
    key: 'starred',
    rank: 11,
    label: 'Starred',
    description: 'Starred items',
    closed: ['true', 'false'],
    negatable: true,
  },
  {
    field: Field.NEW,
    key: 'new',
    rank: 12,
    label: 'New',
    description: 'New activity flags',
    closed: ['item', 'mention', 'comment', 'code', 'noise', 'any'],
    negatable: true,
  },
  {
    field: Field.NO,
    key: 'no',
    rank: 13,
    label: 'No',
    description: 'Missing field',
    closed: ['assignee', 'label', 'milestone'],
    negatable: true,
  },
  {
    field: Field.IN,
    key: 'in',
    rank: 14,
    label: 'In',
    description: 'Narrow free text to title or body',
    closed: ['title', 'body'],
    negatable: false,
  },
];

export const IS_SHORTHAND: Readonly<Record<string, { field: Field; value: string }>> = {
  open: { field: Field.STATE, value: 'open' },
  closed: { field: Field.STATE, value: 'closed' },
  merged: { field: Field.STATE, value: 'merged' },
  pr: { field: Field.TYPE, value: 'pr' },
  issue: { field: Field.TYPE, value: 'issue' },
  draft: { field: Field.DRAFT, value: 'true' },
  tracked: { field: Field.TRACKING, value: 'true' },
  untracked: { field: Field.TRACKING, value: 'false' },
  starred: { field: Field.STARRED, value: 'true' },
  new: { field: Field.NEW, value: 'any' },
  inbox: { field: Field.TRIAGE, value: 'inbox' },
  acked: { field: Field.TRIAGE, value: 'acked' },
};

const BY_KEY: ReadonlyMap<string, FieldSpec> = new Map(FIELD_SPECS.map((s) => [s.key, s]));
const BY_FIELD: ReadonlyMap<Field, FieldSpec> = new Map(FIELD_SPECS.map((s) => [s.field, s]));

export function specForKey(key: string): FieldSpec | undefined {
  return BY_KEY.get(key);
}

export function specForField(field: Field): FieldSpec | undefined {
  return BY_FIELD.get(field);
}

/** Converts a trimmed legacy URL parameter value to a model value; null drops the value. */
export function decodeLegacyValue(spec: FieldSpec, raw: string): string | null {
  if (spec.legacyDecode) return spec.legacyDecode(raw);
  if (spec.closed) {
    const v = raw.toLowerCase();
    return spec.closed.includes(v) ? v : null;
  }
  return raw || null;
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
  return specForField(p.field)?.rank ?? FIELD_SPECS.length;
}
