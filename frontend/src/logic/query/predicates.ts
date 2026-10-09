// Pure operations on the dashboard's predicate list. The predicate list is the state of record;
// the single-select controls (triage tab, state, type, repo, ...) are a read-only projection of
// it, and control changes are translated back into predicate edits here.
import { Field } from '../../api/octodeck/v1/query_pb';
import {
  DEFAULT_FILTER_CONTROLS,
  DEFAULT_QUERY_STATE,
  type DashboardQueryState,
  type FilterControls,
  type FilterPredicate,
  type TriageFilter,
} from '../../types/filters';
import { ME_VALUE, isActivityPredicate, isAssignedToMePredicate, rankOf, specForField } from './vocabulary';

/** A predicate that no control can display, with its index in the predicate list. */
export interface ExtraPredicate {
  readonly predicate: FilterPredicate;
  readonly index: number;
}

/** Controls backed by predicates (every FilterControls key except the non-query tail). */
type PredicateControl = Exclude<keyof FilterControls, 'q' | 'sort' | 'order' | 'item'>;

/** Field-owning controls and the (single) model value each control value stands for. */
interface ControlSpec {
  readonly field: Field;
  /** Control value -> model value; null means "no filter". */
  readonly toModel: (value: string | null) => string | null;
  /** Model value -> control value, or undefined if the control cannot show it. */
  readonly fromModel: (value: string) => string | undefined;
  /** Whether a predicate belongs to (is replaced by) this control. */
  readonly owns: (p: FilterPredicate) => boolean;
}

const mapping = (pairs: Record<string, string>) => ({
  toModel: (value: string | null) => (value !== null && Object.hasOwn(pairs, value) ? pairs[value] : null),
  fromModel: (model: string) => Object.keys(pairs).find((k) => pairs[k] === model),
});
const openText = (strip: boolean) => ({
  toModel: (value: string | null) => {
    const v = value?.trim() ?? '';
    return (strip ? v.replace(/^@/, '') : v) || null;
  },
  fromModel: (model: string) => model,
});
const ownsField = (field: Field) => (p: FilterPredicate) => p.field === field;

const CONTROLS: Readonly<Record<Exclude<PredicateControl, 'triage'>, ControlSpec>> = {
  state: { field: Field.STATE, ...mapping({ open: 'open', closed: 'closed' }), owns: ownsField(Field.STATE) },
  type: { field: Field.TYPE, ...mapping({ pr: 'pr', issue: 'issue' }), owns: ownsField(Field.TYPE) },
  // Only the "Assigned to me" predicate belongs to the toggle; assignee=bob from a URL survives it.
  assigned: { field: Field.ASSIGNEE, ...mapping({ me: ME_VALUE }), owns: isAssignedToMePredicate },
  tracking: { field: Field.TRACKING, ...mapping({ tracked: 'true', untracked: 'false' }), owns: ownsField(Field.TRACKING) },
  repo: { field: Field.REPO, ...openText(false), owns: ownsField(Field.REPO) },
  org: { field: Field.ORG, ...openText(false), owns: ownsField(Field.ORG) },
  author: { field: Field.AUTHOR, ...openText(true), owns: ownsField(Field.AUTHOR) },
  milestone: { field: Field.MILESTONE, ...openText(false), owns: ownsField(Field.MILESTONE) },
  label: { field: Field.LABEL, ...openText(false), owns: ownsField(Field.LABEL) },
};

const TRIAGE_TAB_VALUES: readonly TriageFilter[] = ['acked', 'all'];

function hasTriagePredicate(predicates: readonly FilterPredicate[]): boolean {
  return predicates.some((p) => p.field === Field.TRIAGE);
}

/** The control a predicate is displayed by, if any, with the control value. */
function controlFor(
  p: FilterPredicate,
  predicates: readonly FilterPredicate[]
): { key: PredicateControl; value: string } | undefined {
  if (p.negated) return undefined;
  if (isActivityPredicate(p) && !hasTriagePredicate(predicates)) return { key: 'triage', value: 'activity' };
  if (p.values.length !== 1) return undefined;
  const model = p.values[0];
  if (p.field === Field.TRIAGE) {
    const tab = TRIAGE_TAB_VALUES.find((t) => t === model);
    return tab ? { key: 'triage', value: tab } : undefined;
  }
  for (const [key, spec] of Object.entries(CONTROLS) as [Exclude<PredicateControl, 'triage'>, ControlSpec][]) {
    if (spec.field !== p.field || !spec.owns(p)) continue;
    const value = spec.fromModel(model);
    return value === undefined ? undefined : { key, value };
  }
  return undefined;
}

/**
 * Projects the predicates onto the single-select controls. The first predicate a control can
 * display sets it; every other predicate is returned in `extras` (in list order) so that no
 * active filter is ever hidden.
 */
export function projectControls(state: DashboardQueryState): { controls: FilterControls; extras: ExtraPredicate[] } {
  const controls: FilterControls = {
    ...DEFAULT_FILTER_CONTROLS,
    q: state.q,
    sort: state.sort,
    order: state.order,
    item: state.item,
  };
  const taken = new Set<PredicateControl>();
  const extras: ExtraPredicate[] = [];
  state.predicates.forEach((predicate, index) => {
    const control = controlFor(predicate, state.predicates);
    if (control && !taken.has(control.key)) {
      taken.add(control.key);
      (controls as unknown as Record<string, string>)[control.key] = control.value;
    } else {
      extras.push({ predicate, index });
    }
  });
  return { controls, extras };
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
  owns: (p: FilterPredicate) => boolean,
  next: FilterPredicate | null
): FilterPredicate[] {
  const firstRemoved = predicates.findIndex(owns);
  const kept = predicates.filter((p) => !owns(p));
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

/** Switches the triage tab: replaces every triage predicate and the "New" tab's new:any. */
export function setTriageTab(state: DashboardQueryState, tab: TriageFilter): DashboardQueryState {
  const owns = (p: FilterPredicate) => p.field === Field.TRIAGE || isActivityPredicate(p);
  let next: FilterPredicate | null = null;
  if (tab === 'activity') next = { field: Field.NEW, values: ['any'], negated: false };
  else if (tab === 'acked' || tab === 'all') next = { field: Field.TRIAGE, values: [tab], negated: false };
  return { ...state, predicates: replacePredicates(state.predicates, owns, next) };
}

/** Sets one control, replacing the predicates it owns (single-select semantics). */
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
  }
  const spec = CONTROLS[key as Exclude<PredicateControl, 'triage'>];
  const model = spec.toModel(value as string | null);
  const next = model === null ? null : { field: spec.field, values: [model], negated: false };
  return { ...state, predicates: replacePredicates(state.predicates, spec.owns, next) };
}

/** Applies several control changes in their insertion order. */
export function applyControls(state: DashboardQueryState, partial: Partial<FilterControls>): DashboardQueryState {
  return (Object.keys(partial) as (keyof FilterControls)[]).reduce(
    (s, key) => setControl(s, key, partial[key] as FilterControls[typeof key]),
    state
  );
}

/** Sidebar repo shortcut: selects the repo (or clears it if already selected) and clears org. */
export function toggleRepo(state: DashboardQueryState, repo: string): DashboardQueryState {
  const current = projectControls(state).controls.repo;
  const isSame = current !== null && current.toLowerCase() === repo.toLowerCase();
  return applyControls(state, { repo: isSame ? null : repo, org: null });
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
  const kept = state.predicates.filter((p) => {
    const control = controlFor(p, state.predicates);
    return control !== undefined && (control.key === 'triage' || control.key === 'type');
  });
  // Keep only the first predicate per kept control, as the projection does.
  const seen = new Set<string>();
  const predicates = kept.filter((p) => {
    const key = controlFor(p, state.predicates)?.key ?? '';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
export function formatPredicateChip(p: FilterPredicate): { label: string; value: string; negated: boolean } {
  const spec = specForField(p.field);
  const values = spec ? p.values.map((v) => spec.encode(v)) : [...p.values];
  return { label: spec?.label ?? 'Filter', value: values.join(', '), negated: p.negated };
}
