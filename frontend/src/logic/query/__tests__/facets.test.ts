import { describe, it, expect } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { FacetValueSchema, Field, type FacetValue } from '../../../api/octodeck/v1/query_pb';
import { GetFacetsResponseSchema } from '../../../api/octodeck/v1/service_pb';
import {
  buildActivityOptions,
  buildAssigneeMenuOptions,
  buildAuthorMenuOptions,
  buildLabelOptions,
  buildOptions,
  buildRepoDropdown,
  buildRepoMenuOptions,
  buildSidebar,
  countOf,
  countsByValue,
  facetValues,
  isAssigneeOptionSelected,
  toggleAssigneeOption,
} from '../facets';

const fv = (value: string, count: number, extra: { color?: string; latestMs?: number } = {}): FacetValue =>
  create(FacetValueSchema, {
    value,
    count,
    color: extra.color ?? '',
    latestActivityAt: extra.latestMs === undefined ? undefined : timestampFromMs(extra.latestMs),
  });

describe('facetValues', () => {
  it('returns the values of the facet for the field, or none', () => {
    const resp = create(GetFacetsResponseSchema, {
      facets: [
        { field: Field.REPO, values: [{ value: 'a/b', count: 1 }] },
        { field: Field.AUTHOR, values: [{ value: 'alice', count: 2 }] },
      ],
    });
    expect(facetValues(resp, Field.AUTHOR).map((v) => v.value)).toEqual(['alice']);
    expect(facetValues(resp, Field.LABEL)).toEqual([]);
    expect(facetValues(undefined, Field.REPO)).toEqual([]);
  });
});

describe('buildOptions', () => {
  const authors = [fv('Bob', 2), fv('alice', 1), fv('Charlie', 0), fv('Dave', 0)];

  it('shows values with matches by default, sorted case-insensitively with counts', () => {
    expect(buildOptions(authors, [], false)).toEqual({
      list: [
        { value: 'alice', count: 1 },
        { value: 'Bob', count: 2 },
      ],
      hasMore: true,
    });
  });

  it('shows zero-count values with Show all', () => {
    expect(buildOptions(authors, [], true).list).toEqual([
      { value: 'alice', count: 1 },
      { value: 'Bob', count: 2 },
      { value: 'Charlie', count: 0 },
      { value: 'Dave', count: 0 },
    ]);
  });

  it('reports no more options when every value has matches', () => {
    expect(buildOptions([fv('a', 1), fv('b', 3)], [], false).hasMore).toBe(false);
  });

  it('always lists all selected values with their counts, without duplicating differently cased matches', () => {
    expect(buildOptions(authors, ['zed', 'Charlie'], false).list).toEqual([
      { value: 'alice', count: 1 },
      { value: 'Bob', count: 2 },
      { value: 'Charlie', count: 0 },
      { value: 'zed', count: 0 },
    ]);
    expect(buildOptions(authors, ['BOB'], false).list).toEqual([
      { value: 'alice', count: 1 },
      { value: 'Bob', count: 2 },
    ]);
  });
});

describe('buildLabelOptions', () => {
  it('carries the label count and color, and an empty color for an unknown selected label', () => {
    const labels = [
      fv('kind/bug', 2, { color: 'd73a4a' }),
      fv('area/api', 1, { color: 'ededed' }),
      fv('size/L', 0, { color: '0075ca' }),
    ];
    expect(buildLabelOptions(labels, ['needs-triage', 'size/L'], false)).toEqual({
      list: [
        { value: 'area/api', count: 1, color: 'ededed' },
        { value: 'kind/bug', count: 2, color: 'd73a4a' },
        { value: 'needs-triage', count: 0, color: '' },
        { value: 'size/L', count: 0, color: '0075ca' },
      ],
      hasMore: false,
    });
  });
});

describe('buildActivityOptions', () => {
  it('returns a New Activity group header for any (count null) with the five flags indented beneath it', () => {
    const activityValues = [fv('item', 4), fv('mention', 2), fv('code', 5)];
    expect(buildActivityOptions(activityValues)).toEqual([
      { value: 'any', label: 'New Activity', count: null, isGroupHeader: true },
      { value: 'item', label: 'New items', count: 4, indented: true },
      { value: 'mention', label: 'Mentions', count: 2, indented: true },
      { value: 'comment', label: 'Comments & reviews', count: 0, indented: true },
      { value: 'code', label: 'New commits', count: 5, indented: true },
      { value: 'noise', label: 'Noise (bots)', count: 0, indented: true },
    ]);
  });
});

describe('buildRepoDropdown', () => {
  const repos = [fv('kubernetes/kubernetes', 3), fv('kubernetes/minikube', 0), fv('golang/go', 1)];
  const orgs = [fv('kubernetes', 3), fv('golang', 1)];

  it('groups repos with matches under their orgs with counts', () => {
    expect(buildRepoDropdown(repos, orgs, { repos: [], orgs: [] }, [], false)).toEqual({
      orgs: ['golang', 'kubernetes'],
      reposByOrg: {
        golang: [{ value: 'golang/go', count: 1 }],
        kubernetes: [{ value: 'kubernetes/kubernetes', count: 3 }],
      },
      hasMore: true,
    });
  });

  it('adds zero-count and pinned repos with Show all', () => {
    const d = buildRepoDropdown(repos, orgs, { repos: [], orgs: [] }, ['octocat/hello'], true);
    expect(d.orgs).toEqual(['golang', 'kubernetes', 'octocat']);
    expect(d.reposByOrg).toEqual({
      golang: [{ value: 'golang/go', count: 1 }],
      kubernetes: [
        { value: 'kubernetes/kubernetes', count: 3 },
        { value: 'kubernetes/minikube', count: 0 },
      ],
      octocat: [{ value: 'octocat/hello', count: 0 }],
    });
  });

  it('lists sibling repos when a repo is selected (own-field exclusion), under every owner', () => {
    // The repo facet ignores repo:golang/go; the org facet is narrowed to golang by it.
    const d = buildRepoDropdown(
      [fv('kubernetes/kubernetes', 2), fv('golang/go', 1)],
      [fv('kubernetes', 0), fv('golang', 1)],
      { repos: ['golang/go'], orgs: [] },
      [],
      false
    );
    expect(d.orgs).toEqual(['golang', 'kubernetes']);
    expect(d.reposByOrg).toEqual({
      golang: [{ value: 'golang/go', count: 1 }],
      kubernetes: [{ value: 'kubernetes/kubernetes', count: 2 }],
    });
  });

  it('lists every org with matches when an org is selected', () => {
    const d = buildRepoDropdown(
      [fv('kubernetes/kubernetes', 0), fv('golang/go', 1)],
      [fv('kubernetes', 3), fv('golang', 1)],
      { repos: [], orgs: ['golang'] },
      [],
      false
    );
    expect(d.orgs).toEqual(['golang', 'kubernetes']);
    expect(d.reposByOrg).toEqual({
      golang: [{ value: 'golang/go', count: 1 }],
      kubernetes: [],
    });
  });

  it('injects all selected repos and orgs even when the daemon does not know them', () => {
    const d = buildRepoDropdown(
      [],
      [],
      { repos: ['new/repo', 'other/repo'], orgs: ['neworg'] },
      [],
      false
    );
    expect(d).toEqual({
      orgs: ['new', 'neworg', 'other'],
      reposByOrg: {
        new: [{ value: 'new/repo', count: 0 }],
        neworg: [],
        other: [{ value: 'other/repo', count: 0 }],
      },
      hasMore: false,
    });
  });

  it('reports no more options when everything is displayed', () => {
    expect(
      buildRepoDropdown([fv('a/b', 1)], [fv('a', 1)], { repos: [], orgs: [] }, [], false).hasMore
    ).toBe(false);
  });

  it('groups a selected repo under its org header when owner casing differs from the org facet', () => {
    const d = buildRepoDropdown(
      [],
      [fv('kubernetes', 3)],
      { repos: ['Kubernetes/foo'], orgs: [] },
      [],
      false
    );
    expect(d.orgs).toEqual(['kubernetes']);
    expect(d.reposByOrg).toEqual({
      kubernetes: [{ value: 'Kubernetes/foo', count: 0 }],
    });

    const menuOpts = buildRepoMenuOptions(
      [],
      [fv('kubernetes', 3)],
      { repos: ['Kubernetes/foo'], orgs: [] },
      [],
      false
    );
    expect(menuOpts.list).toEqual([
      { value: 'kubernetes', count: null, group: 'kubernetes', isGroupHeader: true },
      { value: 'Kubernetes/foo', count: 0, group: 'kubernetes', indented: true },
    ]);
  });
});

describe('buildAuthorMenuOptions and buildAssigneeMenuOptions', () => {
  it('pins the current user first in Author options as @<login> (you) with value @me', () => {
    const authors = [fv('bob', 2), fv('alice', 4)];
    const built = buildAuthorMenuOptions(authors, [], 'alice', false);
    expect(built.list).toEqual([
      { value: '@me', label: '@alice (you)', count: 4, pinned: true },
      { value: 'bob', count: 2 },
    ]);
  });

  it('shows a single @alice (you) row with alice count and ticked when selection is [@me]', () => {
    const assignees = [fv('bob', 2), fv('alice', 5)];
    const selected = ['@me'];
    const built = buildAssigneeMenuOptions(assignees, selected, 'alice', false);
    expect(built.list).toEqual([
      { value: '@me', label: '@alice (you)', count: 5, pinned: true },
      { value: 'bob', count: 2 },
    ]);
    expect(isAssigneeOptionSelected(built.list[0], selected, 'alice')).toBe(true);
  });

  it('also ticks the @alice (you) row when selection is [alice]', () => {
    const assignees = [fv('bob', 2), fv('alice', 5)];
    const selected = ['alice'];
    const built = buildAssigneeMenuOptions(assignees, selected, 'alice', false);
    expect(built.list).toEqual([
      { value: '@me', label: '@alice (you)', count: 5, pinned: true },
      { value: 'bob', count: 2 },
    ]);
    expect(isAssigneeOptionSelected(built.list[0], selected, 'alice')).toBe(true);
  });

  it('removes both @me and alice when unticking the (you) row', () => {
    expect(toggleAssigneeOption({ value: '@me' }, true, ['@me', 'alice', 'bob'], 'alice')).toEqual([
      'bob',
    ]);
    expect(toggleAssigneeOption({ value: '@me' }, true, ['alice'], 'alice')).toEqual([]);
    expect(toggleAssigneeOption({ value: '@me' }, true, ['@me'], 'alice')).toEqual([]);
  });

  it('shows one @me (you) row when selection is [@me] and there is no current user', () => {
    const assignees = [fv('bob', 2)];
    const selected = ['@me'];
    const built = buildAssigneeMenuOptions(assignees, selected, null, false);
    expect(built.list).toEqual([
      { value: '@me', label: '@me (you)', count: 0, pinned: true },
      { value: 'bob', count: 2 },
    ]);
    expect(isAssigneeOptionSelected(built.list[0], selected, null)).toBe(true);
  });
});

describe('buildSidebar', () => {
  const now = 1700000000000;
  const day = 86400 * 1000;

  it('splits non-pinned repos by 30-day activity and keeps pinned repos first', () => {
    const repos = [
      fv('kubernetes/kubernetes', 0, { latestMs: now - 31 * day }),
      fv('kubernetes/minikube', 2, { latestMs: now - 5 * day }),
      fv('golang/go', 1, { latestMs: now - 31 * day }),
      fv('octocat/Hello-World', 0, { latestMs: now - 31 * day }),
    ];
    expect(buildSidebar(repos, ['kubernetes/kubernetes', 'pinned/no-items'], now)).toEqual({
      pinnedList: ['kubernetes/kubernetes', 'pinned/no-items'],
      otherList: ['golang/go', 'kubernetes/minikube', 'octocat/Hello-World'],
      activeOtherList: ['kubernetes/minikube'],
      hiddenOtherList: ['golang/go', 'octocat/Hello-World'],
    });
  });

  it('treats activity exactly 30 days old as active and unknown activity as hidden', () => {
    const repos = [fv('a/edge', 0, { latestMs: now - 30 * day }), fv('a/unknown', 1)];
    const s = buildSidebar(repos, [], now);
    expect(s.activeOtherList).toEqual(['a/edge']);
    expect(s.hiddenOtherList).toEqual(['a/unknown']);
  });

  it('matches pinned repos case-insensitively', () => {
    expect(buildSidebar([fv('Kubernetes/Kubernetes', 1, { latestMs: now })], ['kubernetes/kubernetes'], now).otherList).toEqual([]);
  });
});

describe('counts', () => {
  it('keys counts by lower-cased value', () => {
    const values = [fv('Kubernetes/Kubernetes', 3), fv('golang/go', 0)];
    expect(countsByValue(values)).toEqual({ 'kubernetes/kubernetes': 3, 'golang/go': 0 });
    expect(countOf(values, 'kubernetes/kubernetes')).toBe(3);
    expect(countOf(values, 'missing/repo')).toBe(0);
  });
});
