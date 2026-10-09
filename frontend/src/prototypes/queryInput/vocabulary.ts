// Throwaway UX prototype: query vocabulary from docs/internal/query_model_design.md §4.3.
// Open-valued keys use hardcoded mock values in place of GetFacets results.

export interface KeySpec {
  key: string;
  description: string;
  // Closed value set. Values outside it are flagged as errors.
  closed?: string[];
  // Suggested values for open-valued keys (mock facet data).
  mock?: string[];
}

export const KEYS: KeySpec[] = [
  { key: 'is', description: 'Shorthand for state, type, triage, new, ...' },
  { key: 'repo', description: 'Repository (owner/name)', mock: ['kubernetes/kubernetes', 'kubernetes/enhancements', 'kubernetes-sigs/kind', 'golang/go', 'tallclair/octodeck'] },
  { key: 'org', description: 'Repository owner', mock: ['kubernetes', 'kubernetes-sigs', 'golang', 'tallclair'] },
  { key: 'author', description: 'Item author (login or @me)', mock: ['@me', 'tallclair', 'k8s-ci-robot', 'dependabot[bot]', 'liggitt', 'thockin'] },
  { key: 'assignee', description: 'Assignee (login or @me)', mock: ['@me', 'tallclair', 'liggitt', 'thockin', 'SergeyKanzhelev'] },
  { key: 'label', description: 'Label name', mock: ['bug', 'good first issue', 'kind/flake', 'kind/feature', 'priority/important-soon', 'sig/node', 'needs-triage', 'lgtm', 'approved'] },
  { key: 'milestone', description: 'Milestone name', mock: ['v1.35', 'v1.36', 'next release'] },
  { key: 'state', description: 'Open / closed / merged', closed: ['open', 'closed', 'merged'] },
  { key: 'type', description: 'Pull request or issue', closed: ['pr', 'issue'] },
  { key: 'triage', description: 'Inbox / acked (implicit inbox)', closed: ['inbox', 'acked', 'all'] },
  { key: 'new', description: 'New activity flags', closed: ['item', 'mention', 'comment', 'code', 'noise', 'any'] },
  { key: 'draft', description: 'Draft PRs', closed: ['true', 'false'] },
  { key: 'tracking', description: 'Tracked items', closed: ['true', 'false'] },
  { key: 'starred', description: 'Starred items', closed: ['true', 'false'] },
  { key: 'no', description: 'Missing field', closed: ['assignee', 'label', 'milestone'] },
  { key: 'in', description: 'Narrow free text to title or body', closed: ['title', 'body'] },
  { key: 'text', description: 'Free-text term (same as a bare word)' },
];

export const KEY_MAP: ReadonlyMap<string, KeySpec> = new Map(KEYS.map((k) => [k.key, k]));

// is: shorthand -> per-dimension predicate (§4.2).
export const IS_SHORTHAND: Record<string, { field: string; value: string }> = {
  inbox: { field: 'triage', value: 'inbox' },
  acked: { field: 'triage', value: 'acked' },
  open: { field: 'state', value: 'open' },
  closed: { field: 'state', value: 'closed' },
  merged: { field: 'state', value: 'merged' },
  pr: { field: 'type', value: 'pr' },
  issue: { field: 'type', value: 'issue' },
  draft: { field: 'draft', value: 'true' },
  tracked: { field: 'tracking', value: 'true' },
  untracked: { field: 'tracking', value: 'false' },
  starred: { field: 'starred', value: 'true' },
  new: { field: 'new', value: 'any' },
};

// Values offered by autocomplete for a key, or undefined for unknown keys.
export function valuesForKey(key: string): string[] | undefined {
  if (key === 'is') return Object.keys(IS_SHORTHAND);
  const spec = KEY_MAP.get(key);
  if (!spec) return undefined;
  return spec.closed ?? spec.mock ?? [];
}
