// Pure operations on the dashboard's predicate list. The predicate list is the state of record;
// the filter controls (triage tab, state, type, repo, ...) are a read-only projection of
// it, and control changes are translated back into predicate edits here.
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
import { ME_VALUE, encodeLegacyValue, isActivityPredicate, rankOf, specForField } from './vocabulary';

/** A predicate that no control can display, with its index in the predicate list. */
export interface ExtraPredicate {
  readonly predicate: FilterPredicate;
  readonly index: number;
}

export interface Projection {
  controls: FilterControls;
  /** Index in state.predicates of the predicate each control displays. */
  owners: Partial<Record<ControlKey, number>>;
  extras: ExtraPredicate[];
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

const stripAt = (value: string): string | null => {
  const v = value.trim().replace(/^@/, '');
  return v || null;
};

const normalizeAssignee = (value: string): string | null => {
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
  author: { field: Field.AUTHOR, normalize: stripAt },
  assignee: { field: Field.ASSIGNEE, normalize: normalizeAssignee },
  milestone: { field: Field.MILESTONE, normalize: trimNonEmpty },
  label: { field: Field.LABEL, normalize: trimNonEmpty },
  activity: { field: Field.NEW, normalize: normalizeActivity },
};

const TRIAGE_TAB_VALUES: readonly TriageFilter[] = ['acked', 'all'];

function hasTriagePredicate(predicates: readonly FilterPredicate[]): boolean {
  return predicates.some((p) => p.field === Field.TRIAGE);
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
 * Projects the predicates onto the controls. The first non-negated predicate a control can
 * display sets it and records its index in `owners`; every other predicate is returned in `extras`
 * (in list order) so that no active filter is ever hidden.
 */
export function projectControls(state: DashboardQueryState): Projection {
  const controls: FilterControls = {
    ...DEFAULT_FILTER_CONTROLS,
    q: state.q,
    sort: state.sort,
    order: state.order,
    item: state.item,
  };
  const owners: Partial<Record<ControlKey, number>> = {};
  const extras: ExtraPredicate[] = [];
  state.predicates.forEach((predicate, index) => {
    const control = controlFor(predicate);
    if (control && owners[control.key] === undefined) {
      owners[control.key] = index;
      setProjectedControl(controls, control);
    } else {
      extras.push({ predicate, index });
    }
  });

  if (
    owners.triage === undefined &&
    !hasTriagePredicate(state.predicates) &&
    controls.activity.length === 1 &&
    controls.activity[0] === 'any'
  ) {
    controls.triage = 'activity';
    owners.triage = owners.activity;
  }

  return { controls, owners, extras };
}

/** The triage tab shown for a predicate list. */
export function getTriageTab(predicates: readonly FilterPredicate[]): TriageFilter {
  return projectControls({ ...DEFAULT_QUERY_STATE, predicates }).controls.triage;
}

/**
 * Removes the predicates matching `owns` and inserts `next` (if any) where the first removed
 * predicate was, or else at its canonical position.
 */
function replacePredicates(
  predicates: readonly FilterPredicate[],
  owns: (p: FilterPredicate, index: number) => boolean,
  next: FilterPredicate | null
): FilterPredicate[] {
  const firstRemoved = predicates.findIndex((p, i) => owns(p, i));
  const kept = predicates.filter((p, i) => !owns(p, i));
  if (!next) return kept;
  let at: number;
  if (firstRemoved >= 0) {
    // Removed predicates before the first one shift nothing, so its index is still valid.
    at = firstRemoved;
  } else {
    const rank = rankOf(next);
    at = kept.findIndex((p) => rankOf(p) > rank);
    if (at < 0) at = kept.length;
  }
  return [...kept.slice(0, at), next, ...kept.slice(at)];
}

/**
 * Replaces or removes the predicate at `ownerIndex` (when defined), or inserts `next` at its
 * canonical rank when the control currently owns no predicate.
 */
function setOwnedPredicate(
  predicates: readonly FilterPredicate[],
  ownerIndex: number | undefined,
  next: FilterPredicate | null
): FilterPredicate[] {
  if (ownerIndex !== undefined) {
    if (!next) {
      return predicates.filter((_, i) => i !== ownerIndex);
    }
    return predicates.map((p, i) => (i === ownerIndex ? next : p));
  }
  if (!next) return [...predicates];
  const rank = rankOf(next);
  let at = predicates.findIndex((p) => rankOf(p) > rank);
  if (at < 0) at = predicates.length;
  return [...predicates.slice(0, at), next, ...predicates.slice(at)];
}

/**
 * Switches the triage tab: removes every triage predicate (negated ones included, §3.4).
 * Switching to New ('activity') replaces the activity control's predicate with `new:any`;
 * switching to Inbox/Acked/All removes the activity predicate only if it is `new:any`.
 */
export function setTriageTab(state: DashboardQueryState, tab: TriageFilter): DashboardQueryState {
  const { owners } = projectControls(state);
  if (tab === 'activity') {
    const owns = (p: FilterPredicate, index: number) =>
      p.field === Field.TRIAGE || index === owners.activity;
    const next: FilterPredicate = { field: Field.NEW, values: ['any'], negated: false };
    return { ...state, predicates: replacePredicates(state.predicates, owns, next) };
  }
  const owns = (p: FilterPredicate, index: number) =>
    p.field === Field.TRIAGE || (index === owners.activity && isActivityPredicate(p));
  const next: FilterPredicate | null =
    tab === 'acked' || tab === 'all'
      ? { field: Field.TRIAGE, values: [tab], negated: false }
      : null;
  return { ...state, predicates: replacePredicates(state.predicates, owns, next) };
}

/**
 * Sets the activity selection while enforcing Any vs specific exclusivity (§3.4):
 * - Ticking `any` removes `item`, `mention`, `comment`, `code` (keeping `noise` if present).
 * - Ticking any of `item`, `mention`, `comment`, `code` while `any` is ticked removes `any`.
 */
export function setActivity(
  state: DashboardQueryState,
  values: readonly string[]
): DashboardQueryState {
  const { controls, owners } = projectControls(state);
  const prev = controls.activity;
  const normalized: ActivityValue[] = [];
  for (const raw of values) {
    const v = normalizeActivity(raw);
    if (v && !normalized.includes(v)) {
      normalized.push(v);
    }
  }

  const hasAny = normalized.includes('any');
  const hasSpecific = normalized.some((v) => SPECIFIC_ACTIVITY_VALUES.includes(v));
  let resolved = normalized;
  if (hasAny && hasSpecific) {
    const added = normalized.filter((v) => !prev.includes(v));
    if (added.includes('any')) {
      resolved = normalized.filter((v) => !SPECIFIC_ACTIVITY_VALUES.includes(v));
    } else if (added.some((v) => SPECIFIC_ACTIVITY_VALUES.includes(v))) {
      resolved = normalized.filter((v) => v !== 'any');
    } else {
      resolved = normalized.filter((v) => !SPECIFIC_ACTIVITY_VALUES.includes(v));
    }
  }

  const next =
    resolved.length === 0 ? null : { field: Field.NEW, values: resolved, negated: false };
  return { ...state, predicates: setOwnedPredicate(state.predicates, owners.activity, next) };
}

/** Sets one control, editing only the predicate it currently displays (P2). */
export function setControl<K extends keyof FilterControls>(
  state: DashboardQueryState,
  key: K,
  value: FilterControls[K]
): DashboardQueryState {
  switch (key) {
    case 'q':
      return { ...state, q: value as string };
    case 'sort':
      return { ...state, sort: value as DashboardQueryState['sort'] };
    case 'order':
      return { ...state, order: value as DashboardQueryState['order'] };
    case 'item':
      return { ...state, item: (value as string | null) || null };
    case 'triage':
      return setTriageTab(state, value as TriageFilter);
    case 'activity':
      return setActivity(state, value as readonly string[]);
  }
  const { owners } = projectControls(state);
  if (Object.hasOwn(SINGLE_CONTROLS, key)) {
    const singleKey = key as SingleControlKey;
    const spec = SINGLE_CONTROLS[singleKey];
    const model = spec.toModel(value as string);
    const next = model === null ? null : { field: spec.field, values: [model], negated: false };
    return { ...state, predicates: setOwnedPredicate(state.predicates, owners[singleKey], next) };
  }
  const multiKey = key as MultiControlKey;
  const spec = MULTI_CONTROLS[multiKey];
  const values = (value as readonly string[])
    .map(spec.normalize)
    .filter((v): v is string => v !== null);
  const next = values.length === 0 ? null : { field: spec.field, values, negated: false };
  return { ...state, predicates: setOwnedPredicate(state.predicates, owners[multiKey], next) };
}

/** Applies several control changes in their insertion order. */
export function applyControls(state: DashboardQueryState, partial: Partial<FilterControls>): DashboardQueryState {
  return (Object.keys(partial) as (keyof FilterControls)[]).reduce(
    (s, key) => setControl(s, key, partial[key] as FilterControls[typeof key]),
    state
  );
}

/**
 * Sets the org or repo selection while enforcing mutual exclusivity (P3): a non-empty org
 * selection clears the repo control's predicate, and vice versa.
 */
export function setOrgOrRepo(
  state: DashboardQueryState,
  kind: 'org' | 'repo',
  values: readonly string[]
): DashboardQueryState {
  if (kind === 'org') {
    const base = values.length > 0 ? setControl(state, 'repo', []) : state;
    return setControl(base, 'org', values);
  }
  const base = values.length > 0 ? setControl(state, 'org', []) : state;
  return setControl(base, 'repo', values);
}

/**
 * Toggles `@me` in the assignee selection (P19), keeping any other selected assignees.
 */
export function toggleAssignedToMe(state: DashboardQueryState): DashboardQueryState {
  const current = projectControls(state).controls.assignee;
  const hasMe = current.some((v) => v.toLowerCase() === ME_VALUE);
  const next = hasMe ? current.filter((v) => v.toLowerCase() !== ME_VALUE) : [ME_VALUE, ...current];
  return setControl(state, 'assignee', next);
}

/** Sidebar repo shortcut: if repo is exactly `[repo]`, clear it; otherwise set `[repo]` and clear org. */
export function toggleRepo(state: DashboardQueryState, repo: string): DashboardQueryState {
  const current = projectControls(state).controls.repo;
  const isSameSingle = current.length === 1 && current[0].toLowerCase() === repo.toLowerCase();
  return setOrgOrRepo(state, 'repo', isSameSingle ? [] : [repo]);
}

/** Removes the predicate at `index` (a generic chip's remove button). */
export function removePredicate(state: DashboardQueryState, index: number): DashboardQueryState {
  return { ...state, predicates: state.predicates.filter((_, i) => i !== index) };
}

/**
 * "Clear filters": keeps the triage tab, the type control, the search text, sort and selection,
 * and drops every other predicate (including extra predicates).
 */
export function clearSecondary(state: DashboardQueryState): DashboardQueryState {
  const { owners } = projectControls(state);
  const keptIndices = new Set<number>();
  if (owners.triage !== undefined) keptIndices.add(owners.triage);
  if (owners.type !== undefined) keptIndices.add(owners.type);
  const predicates = state.predicates.filter((_, index) => keptIndices.has(index));
  return { ...state, predicates };
}

/** Sidebar workflow shortcut: everything back to defaults, on the given triage tab. */
export function workflowState(tab: TriageFilter): DashboardQueryState {
  return setTriageTab(DEFAULT_QUERY_STATE, tab);
}

export function isDefaultQuery(state: DashboardQueryState): boolean {
  return (
    state.predicates.length === 0 &&
    state.q.trim() === '' &&
    state.sort === DEFAULT_QUERY_STATE.sort &&
    state.order === DEFAULT_QUERY_STATE.order &&
    !state.item
  );
}

/** Number of active filter dimensions: predicates, the search text, and a non-default sort. */
export function activeQueryCount(state: DashboardQueryState): number {
  const sortChanged = state.sort !== DEFAULT_QUERY_STATE.sort || state.order !== DEFAULT_QUERY_STATE.order;
  return state.predicates.length + (state.q.trim() ? 1 : 0) + (sortChanged ? 1 : 0);
}

/** Label and values for a generic filter chip. */
export function formatPredicateChip(p: FilterPredicate): {
  label: string;
  values: string[];
  negated: boolean;
} {
  const spec = specForField(p.field);
  const values = spec ? p.values.map((v) => encodeLegacyValue(spec, v)) : [...p.values];
  return { label: spec?.label ?? 'Filter', values, negated: p.negated };
}

/**
 * Whether any secondary filter chip is currently active (excluding the `new:any` predicate that
 * drives the New tab when `filters.triage === 'activity'`).
 */
export function hasActiveFilterChips(
  filters: FilterControls,
  extraPredicates: readonly ExtraPredicate[]
): boolean {
  return (
    filters.state !== 'all' ||
    filters.tracking !== 'all' ||
    filters.repo.length > 0 ||
    filters.org.length > 0 ||
    filters.author.length > 0 ||
    filters.assignee.length > 0 ||
    filters.milestone.length > 0 ||
    filters.label.length > 0 ||
    (filters.activity.length > 0 && filters.triage !== 'activity') ||
    extraPredicates.length > 0
  );
}
