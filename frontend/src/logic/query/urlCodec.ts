// Dashboard URL <-> query state (design §7). URLs keep today's structured parameters
// (repo=, author=, triage=, ...), extended with repeated parameters for multiple values (ORed)
// and a '-key=' prefix for negation.
//
// Exact round trip: serializeQueryParams(parseQueryParams(s)) === s for every canonical s, i.e.
//   - predicate parameters come before q, sort, order, item (in that order), in any order
//     among themselves (their order is preserved);
//   - parameters with the same key and sign are adjacent;
//   - no default, sentinel ('all'), invalid or empty values; author has no leading '@';
//     repo and org are not both present;
//   - only '/', ':' and '@' are left unescaped.
// Every URL the dashboard writes is canonical. For any other input, serialize(parse(s)) is a
// normalized form, and normalizing is idempotent.
import { Field } from '../../api/octodeck/v1/query_pb';
import {
  DEFAULT_QUERY_STATE,
  type DashboardQueryState,
  type FilterPredicate,
  type SortOption,
  type SortOrder,
} from '../../types/filters';
import {
  ACTIVITY_TRIAGE_VALUE,
  LEGACY_ASSIGNED_KEY,
  LEGACY_ASSIGNED_ME,
  ME_VALUE,
  TAIL_KEYS,
  isActivityPredicate,
  isAssignedToMePredicate,
  specForField,
  specForKey,
} from './vocabulary';

const SORT_OPTIONS: readonly SortOption[] = ['updated', 'acked', 'created'];
const SORT_ORDERS: readonly SortOrder[] = ['asc', 'desc'];
const TAIL_KEY_SET: ReadonlySet<string> = new Set(TAIL_KEYS);

interface DecodedParam {
  field: Field;
  value: string;
  /** Legacy triage=activity, which becomes its own new:any predicate. */
  activity: boolean;
  /** Legacy assigned=me, which becomes its own assignee:@me predicate for the toggle. */
  assignedMe: boolean;
}

function decodeParam(key: string, raw: string): DecodedParam | null {
  if (key === LEGACY_ASSIGNED_KEY) {
    // assigned=me is the "Assigned to me" toggle; assigned=all (or anything else) means no filter.
    return raw.toLowerCase() === LEGACY_ASSIGNED_ME
      ? { field: Field.ASSIGNEE, value: ME_VALUE, activity: false, assignedMe: true }
      : null;
  }
  const spec = specForKey(key);
  if (!spec) return null;
  if (spec.field === Field.TRIAGE && raw.toLowerCase() === ACTIVITY_TRIAGE_VALUE) {
    return { field: Field.NEW, value: 'any', activity: true, assignedMe: false };
  }
  const value = spec.decode(raw);
  return value === null ? null : { field: spec.field, value, activity: false, assignedMe: false };
}

function toParams(search: string | URLSearchParams): URLSearchParams {
  if (typeof search !== 'string') return search;
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
}

/** Parses dashboard URL parameters into query state. Unknown keys and invalid values are dropped. */
export function parseQueryParams(search: string | URLSearchParams): DashboardQueryState {
  const params = toParams(search);

  // Values are grouped into one predicate per (field, sign), placed at its first occurrence.
  const groups = new Map<string, { field: Field; negated: boolean; values: string[] }>();
  for (const [rawKey, rawValue] of params) {
    if (TAIL_KEY_SET.has(rawKey)) continue;
    const negated = rawKey.startsWith('-');
    const decoded = decodeParam(negated ? rawKey.slice(1) : rawKey, rawValue.trim());
    if (!decoded) continue;
    // "Not the New tab" and "not in:title" have no meaning (in: must not be negated).
    if (negated && (decoded.activity || decoded.field === Field.IN)) continue;
    const groupKey = decoded.activity
      ? 'activity'
      : decoded.assignedMe
      ? `assigned|${negated}`
      : `${decoded.field}|${negated}`;
    const group = groups.get(groupKey) ?? { field: decoded.field, negated, values: [] };
    if (!group.values.includes(decoded.value)) group.values.push(decoded.value);
    groups.set(groupKey, group);
  }

  const hasRepo = [...groups.values()].some((g) => g.field === Field.REPO && !g.negated);
  const hasActivity = groups.has('activity');
  const predicates: FilterPredicate[] = [];
  for (const group of groups.values()) {
    const p: FilterPredicate = { field: group.field, values: group.values, negated: group.negated };
    // triage=inbox is the implicit scope; writing it adds nothing.
    if (p.field === Field.TRIAGE && !p.negated && p.values.length === 1 && p.values[0] === 'inbox') continue;
    // Today a repo selection wins over an org selection.
    if (p.field === Field.ORG && !p.negated && hasRepo) continue;
    // new=any next to triage=activity repeats the same condition.
    if (hasActivity && p.field === Field.NEW && !p.negated && isActivityPredicate(p) && group !== groups.get('activity')) continue;
    // assignee=@me next to assigned=me repeats the same condition.
    const assignedGroup = groups.get(`assigned|${p.negated}`);
    if (assignedGroup && isAssignedToMePredicate(p) && group !== assignedGroup) continue;
    predicates.push(p);
  }

  const rawSort = params.get('sort')?.toLowerCase();
  const rawOrder = params.get('order')?.toLowerCase();
  return {
    predicates,
    q: params.get('q')?.trim() ?? '',
    sort: SORT_OPTIONS.find((s) => s === rawSort) ?? DEFAULT_QUERY_STATE.sort,
    order: SORT_ORDERS.find((o) => o === rawOrder) ?? DEFAULT_QUERY_STATE.order,
    item: params.get('item')?.trim() || null,
  };
}

/** Serializes query state to URL parameters (without a leading '?'). Defaults are omitted. */
export function serializeQueryParams(state: DashboardQueryState): string {
  const params = new URLSearchParams();
  const hasTriage = state.predicates.some((p) => p.field === Field.TRIAGE);
  let activityWritten = false;
  for (const p of state.predicates) {
    const sign = p.negated ? '-' : '';
    if (isActivityPredicate(p) && !hasTriage && !activityWritten) {
      params.append('triage', ACTIVITY_TRIAGE_VALUE);
      activityWritten = true;
      continue;
    }
    if (isAssignedToMePredicate(p)) {
      params.append(sign + LEGACY_ASSIGNED_KEY, LEGACY_ASSIGNED_ME);
      continue;
    }
    const spec = specForField(p.field);
    if (!spec) continue;
    for (const value of p.values) {
      params.append(sign + spec.key, spec.encode(value));
    }
  }

  const q = state.q.trim();
  if (q) params.append('q', q);
  if (state.sort !== DEFAULT_QUERY_STATE.sort) params.append('sort', state.sort);
  if (state.order !== DEFAULT_QUERY_STATE.order) params.append('order', state.order);
  if (state.item) params.append('item', state.item);

  // URLSearchParams escapes '/', ':' and '@', which are legal in a query string (RFC 3986).
  // Leaving them readable keeps links such as repo=kubernetes/kubernetes unchanged.
  return params.toString().replace(/%2F/g, '/').replace(/%3A/g, ':').replace(/%40/g, '@');
}
