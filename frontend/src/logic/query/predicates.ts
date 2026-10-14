// Pure operations on the dashboard's query clauses and filter controls.
// The filter controls (triage tab, state, type, repo, ...) are a read-only projection of
// the parsed query clauses, and control changes are translated back into text edits via textEdit.ts.
import { Field } from '../../api/octodeck/v1/query_pb';
import {
  DEFAULT_FILTER_CONTROLS,
  DEFAULT_QUERY_STATE,
  type ActivityValue,
  type ControlKey,
  type DashboardQueryState,
  type FilterControls,
  type FilterPredicate,
  type TriageFilter,
} from '../../types/filters';
import { parseQuery, type ParsedQuery } from './syntax';
import { ME_VALUE } from './vocabulary';

export interface Projection {
  controls: FilterControls;
  /** Index of the clause each control displays in `parsed.clauses`. */
  owners: Partial<Record<ControlKey, number>>;
}

export interface ServerInvalidQuery {
  readonly code?: string;
  readonly message: string;
  readonly path?: string;
  /**
   * When resolved against the request's ParsedQuery (`requestParsed`), identifies the failing
   * clause by its raw text and 0-based occurrence index among clauses with that raw text, or
   * `null` when the server error applies to the root query rather than a specific clause.
   */
  readonly clause?: {
    readonly raw: string;
    readonly occurrence: number;
  } | null;
  /** The request text that produced this server error, when known. */
  readonly requestText?: string;
}

export interface ResolvedQueryErrors {
  /** Map from clauseIndex (in parsed.clauses) to a server ExprError message. */
  readonly serverClauseErrors: ReadonlyMap<number, string>;
  /** Server ExprError message when path does not map to a specific clause. */
  readonly serverRootError: string | null;
  /** Ordered list of all active issue/error messages (after excluding excludedClauseIndex). */
  readonly messages: readonly string[];
  /** Formatted summary line ("1 part of the query is ignored: ..."), or null when no errors. */
  readonly summary: string | null;
}

type SingleControlKey = 'state' | 'type' | 'tracking';
type MultiControlKey = 'org' | 'repo' | 'author' | 'assignee' | 'milestone' | 'label' | 'activity';
type StringMultiControlKey = Exclude<MultiControlKey, 'activity'>;

type ProjectedControlValue = {
  [K in ControlKey]: { key: K; value: FilterControls[K] };
}[ControlKey];

function setProjectedControl<K extends ControlKey>(
  controls: FilterControls,
  entry: { key: K; value: FilterControls[K] }
): void {
  controls[entry.key] = entry.value;
}

interface SingleControlSpec<V extends string = string> {
  readonly field: Field;
  readonly toModel: (value: string) => string | null;
  readonly fromModel: (value: string) => V | undefined;
}

interface MultiControlSpec {
  readonly field: Field;
  readonly normalize: (value: string) => string | null;
}

const ACTIVITY_VALUES: readonly ActivityValue[] = [
  'any',
  'item',
  'mention',
  'comment',
  'code',
  'noise',
];
const SPECIFIC_ACTIVITY_VALUES: readonly ActivityValue[] = ['item', 'mention', 'comment', 'code'];

const mapping = <V extends string>(pairs: Record<V, string>) => ({
  toModel: (value: string) => (Object.hasOwn(pairs, value) ? pairs[value as V] : null),
  fromModel: (model: string): V | undefined =>
    (Object.keys(pairs) as V[]).find((k) => pairs[k] === model),
});

const trimNonEmpty = (value: string): string | null => {
  const v = value.trim();
  return v || null;
};

const normalizeUser = (value: string): string | null => {
  const v = value.trim();
  if (!v) return null;
  if (v.toLowerCase() === ME_VALUE) return ME_VALUE;
  return v.replace(/^@/, '') || null;
};

const normalizeActivity = (value: string): ActivityValue | null => {
  const v = value.trim().toLowerCase() as ActivityValue;
  return ACTIVITY_VALUES.includes(v) ? v : null;
};

const SINGLE_CONTROLS: {
  readonly state: SingleControlSpec<'open' | 'closed' | 'merged'>;
  readonly type: SingleControlSpec<'pr' | 'issue'>;
  readonly tracking: SingleControlSpec<'tracked' | 'untracked'>;
} = {
  state: { field: Field.STATE, ...mapping({ open: 'open', closed: 'closed', merged: 'merged' }) },
  type: { field: Field.TYPE, ...mapping({ pr: 'pr', issue: 'issue' }) },
  tracking: { field: Field.TRACKING, ...mapping({ tracked: 'true', untracked: 'false' }) },
};

const MULTI_CONTROLS: Readonly<Record<MultiControlKey, MultiControlSpec>> = {
  repo: { field: Field.REPO, normalize: trimNonEmpty },
  org: { field: Field.ORG, normalize: trimNonEmpty },
  author: { field: Field.AUTHOR, normalize: normalizeUser },
  assignee: { field: Field.ASSIGNEE, normalize: normalizeUser },
  milestone: { field: Field.MILESTONE, normalize: trimNonEmpty },
  label: { field: Field.LABEL, normalize: trimNonEmpty },
  activity: { field: Field.NEW, normalize: normalizeActivity },
};

const TRIAGE_TAB_VALUES: readonly TriageFilter[] = ['acked', 'all'];

function hasTriagePredicate(predicates: readonly FilterPredicate[]): boolean {
  return predicates.some((p) => p.field === Field.TRIAGE);
}

/**
 * Resolves a next activity selection against `prev`, enforcing Any vs specific exclusivity (§3.4):
 * - Ticking `any` removes `item`, `mention`, `comment`, `code` (keeping `noise` if present).
 * - Ticking any of `item`, `mention`, `comment`, `code` while `any` is ticked removes `any`.
 */
export function resolveActivityValues(
  prev: readonly ActivityValue[],
  values: readonly string[]
): ActivityValue[] {
  const normalized: ActivityValue[] = [];
  for (const raw of values) {
    const v = normalizeActivity(raw);
    if (v && !normalized.includes(v)) {
      normalized.push(v);
    }
  }

  const hasAny = normalized.includes('any');
  const hasSpecific = normalized.some((v) => SPECIFIC_ACTIVITY_VALUES.includes(v));
  if (!hasAny || !hasSpecific) {
    return normalized;
  }

  const added = normalized.filter((v) => !prev.includes(v));
  if (added.includes('any')) {
    return normalized.filter((v) => !SPECIFIC_ACTIVITY_VALUES.includes(v));
  }
  if (added.some((v) => SPECIFIC_ACTIVITY_VALUES.includes(v))) {
    return normalized.filter((v) => v !== 'any');
  }
  return normalized.filter((v) => !SPECIFIC_ACTIVITY_VALUES.includes(v));
}

/** Converts a non-triage control value to its corresponding FilterPredicate (or null when empty/default). */
export function controlToPredicate<K extends Exclude<ControlKey, 'triage'>>(
  key: K,
  value: FilterControls[K],
  prevActivity: readonly ActivityValue[] = []
): FilterPredicate | null {
  if (key === 'activity') {
    const resolved = resolveActivityValues(prevActivity, value as readonly string[]);
    return resolved.length === 0 ? null : { field: Field.NEW, values: resolved, negated: false };
  }
  if (Object.hasOwn(SINGLE_CONTROLS, key)) {
    const singleKey = key as SingleControlKey;
    const spec = SINGLE_CONTROLS[singleKey];
    const model = spec.toModel(value as string);
    return model === null ? null : { field: spec.field, values: [model], negated: false };
  }
  const multiKey = key as MultiControlKey;
  const spec = MULTI_CONTROLS[multiKey];
  const values = (value as readonly string[])
    .map(spec.normalize)
    .filter((v): v is string => v !== null);
  return values.length === 0 ? null : { field: spec.field, values, negated: false };
}

/** The control a predicate is displayed by, if any, with the control value. */
function controlFor(p: FilterPredicate): ProjectedControlValue | undefined {
  if (p.negated) return undefined;
  if (p.field === Field.TRIAGE) {
    if (p.values.length !== 1) return undefined;
    const tab = TRIAGE_TAB_VALUES.find((t) => t === p.values[0]);
    return tab ? { key: 'triage', value: tab } : undefined;
  }
  if (p.field === Field.STATE) {
    if (p.values.length !== 1) return undefined;
    const value = SINGLE_CONTROLS.state.fromModel(p.values[0]);
    return value ? { key: 'state', value } : undefined;
  }
  if (p.field === Field.TYPE) {
    if (p.values.length !== 1) return undefined;
    const value = SINGLE_CONTROLS.type.fromModel(p.values[0]);
    return value ? { key: 'type', value } : undefined;
  }
  if (p.field === Field.TRACKING) {
    if (p.values.length !== 1) return undefined;
    const value = SINGLE_CONTROLS.tracking.fromModel(p.values[0]);
    return value ? { key: 'tracking', value } : undefined;
  }
  if (p.field === Field.NEW) {
    if (p.values.length === 0) return undefined;
    const normalized = p.values.map(normalizeActivity);
    if (normalized.some((v) => v === null)) return undefined;
    return { key: 'activity', value: normalized as ActivityValue[] };
  }
  for (const [key, spec] of Object.entries(MULTI_CONTROLS) as [MultiControlKey, MultiControlSpec][]) {
    if (key === 'activity' || spec.field !== p.field) continue;
    if (p.values.length === 0) return undefined;
    return { key: key as StringMultiControlKey, value: [...p.values] };
  }
  return undefined;
}

/**
 * Projects parsed clauses onto the dashboard's filter controls (§4, §5).
 * Only `ok` clauses have a predicate; `owners` stores the clause index in `parsed.clauses`.
 */
export function projectClauses(
  parsed: ParsedQuery,
  tail?: Partial<Pick<FilterControls, 'sort' | 'order' | 'item'>>
): Projection {
  const controls: FilterControls = {
    ...DEFAULT_FILTER_CONTROLS,
    ...(tail?.sort !== undefined ? { sort: tail.sort } : {}),
    ...(tail?.order !== undefined ? { order: tail.order } : {}),
    ...(tail?.item !== undefined ? { item: tail.item } : {}),
  };
  const owners: Partial<Record<ControlKey, number>> = {};

  parsed.clauses.forEach((clause, clauseIndex) => {
    if (!clause.predicate) return;
    const control = controlFor(clause.predicate);
    if (control && owners[control.key] === undefined) {
      owners[control.key] = clauseIndex;
      setProjectedControl(controls, control);
    }
  });

  if (
    owners.triage === undefined &&
    !hasTriagePredicate(parsed.predicates) &&
    controls.activity.length === 1 &&
    controls.activity[0] === 'any'
  ) {
    controls.triage = 'activity';
    owners.triage = owners.activity;
  }

  return { controls, owners };
}

/** Sidebar workflow shortcut: everything back to defaults, on the given triage tab. */
export function workflowState(tab: TriageFilter): DashboardQueryState {
  const text =
    tab === 'activity'
      ? 'new:any'
      : tab === 'acked' || tab === 'all'
      ? `triage:${tab}`
      : '';
  return { ...DEFAULT_QUERY_STATE, text };
}

export function isDefaultQuery(state: DashboardQueryState): boolean {
  return (
    state.text.trim() === '' &&
    state.sort === DEFAULT_QUERY_STATE.sort &&
    state.order === DEFAULT_QUERY_STATE.order &&
    !state.item
  );
}

/** Number of active filter dimensions: qualifier predicates, free-text search, and non-default sort. */
export function activeQueryCount(
  state: DashboardQueryState,
  parsed: ParsedQuery = parseQuery(state.text)
): number {
  const nonTextPredicates = parsed.predicates.filter((p) => p.field !== Field.TEXT).length;
  const hasText = parsed.predicates.some((p) => p.field === Field.TEXT);
  const sortChanged =
    state.sort !== DEFAULT_QUERY_STATE.sort || state.order !== DEFAULT_QUERY_STATE.order;
  return nonTextPredicates + (hasText ? 1 : 0) + (sortChanged ? 1 : 0);
}

const SERVER_PATH_RE = /^and\.exprs\[(\d+)\]/;

/**
 * Resolves a raw server ExprError (`and.exprs[i]`) against the request's ParsedQuery (`requestParsed`)
 * so that subsequent typing edits before the next request settles still highlight the right clause
 * (or clear the error once that clause is edited/removed) rather than indexing into `localState`'s
 * `clauseOfPredicate` (§7).
 */
export function mapServerErrorToRequest(
  requestParsed: ParsedQuery,
  invalidQuery?: { readonly code?: string; readonly message: string; readonly path?: string } | null
): ServerInvalidQuery | null {
  if (!invalidQuery) return null;
  const match = invalidQuery.path ? SERVER_PATH_RE.exec(invalidQuery.path) : null;
  const predIndex = match ? Number(match[1]) : -1;
  const reqClauseIndex =
    predIndex >= 0 && predIndex < requestParsed.clauseOfPredicate.length
      ? requestParsed.clauseOfPredicate[predIndex]
      : undefined;

  if (reqClauseIndex !== undefined) {
    const raw = requestParsed.clauses[reqClauseIndex].raw;
    let occurrence = 0;
    for (let i = 0; i < reqClauseIndex; i++) {
      if (requestParsed.clauses[i].raw === raw) {
        occurrence++;
      }
    }
    return {
      code: invalidQuery.code,
      message: invalidQuery.message,
      path: invalidQuery.path,
      clause: { raw, occurrence },
      requestText: requestParsed.text,
    };
  }

  return {
    code: invalidQuery.code,
    message: invalidQuery.message,
    path: invalidQuery.path,
    clause: null,
    requestText: requestParsed.text,
  };
}

/**
 * Combines client parse issues with a server ExprError (mapped via `requestParsed` or
 * `and.exprs[i]` -> `clauseOfPredicate[i]`) and builds the muted summary line (§7).
 */
export function resolveQueryErrors(
  parsed: ParsedQuery,
  invalidQuery?: ServerInvalidQuery | null,
  options?: { excludedClauseIndex?: number | null; requestParsed?: ParsedQuery }
): ResolvedQueryErrors {
  const serverClauseErrors = new Map<number, string>();
  let serverRootError: string | null = null;

  const effectiveInvalidQuery =
    invalidQuery && invalidQuery.clause === undefined && options?.requestParsed
      ? mapServerErrorToRequest(options.requestParsed, invalidQuery)
      : invalidQuery;

  if (effectiveInvalidQuery) {
    if (effectiveInvalidQuery.clause !== undefined) {
      if (effectiveInvalidQuery.clause !== null) {
        const { raw, occurrence } = effectiveInvalidQuery.clause;
        let seen = 0;
        for (let i = 0; i < parsed.clauses.length; i++) {
          if (parsed.clauses[i].raw === raw) {
            if (seen === occurrence) {
              serverClauseErrors.set(i, effectiveInvalidQuery.message);
              break;
            }
            seen++;
          }
        }
      } else if (
        effectiveInvalidQuery.requestText === undefined ||
        effectiveInvalidQuery.requestText === parsed.text
      ) {
        serverRootError = effectiveInvalidQuery.message;
      }
    } else {
      const match = effectiveInvalidQuery.path
        ? SERVER_PATH_RE.exec(effectiveInvalidQuery.path)
        : null;
      const predIndex = match ? Number(match[1]) : -1;
      const clauseIndex =
        predIndex >= 0 && predIndex < parsed.clauseOfPredicate.length
          ? parsed.clauseOfPredicate[predIndex]
          : undefined;
      if (clauseIndex !== undefined) {
        serverClauseErrors.set(clauseIndex, effectiveInvalidQuery.message);
      } else {
        serverRootError = effectiveInvalidQuery.message;
      }
    }
  }

  const excluded = options?.excludedClauseIndex ?? null;
  const messages: string[] = [];
  parsed.clauses.forEach((clause, index) => {
    if (index === excluded) return;
    const msg = clause.issue?.message ?? serverClauseErrors.get(index);
    if (msg) {
      messages.push(msg);
    }
  });
  if (serverRootError) {
    messages.push(serverRootError);
  }

  let summary: string | null = null;
  if (messages.length === 1) {
    summary = `1 part of the query is ignored: ${messages[0]}`;
  } else if (messages.length > 1) {
    summary = `${messages.length} parts of the query are ignored: ${messages[0]}`;
  }

  return {
    serverClauseErrors,
    serverRootError,
    messages,
    summary,
  };
}


