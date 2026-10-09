import { describe, it, expect } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { FacetValueSchema, Field, type FacetValue } from '../../../api/octodeck/v1/query_pb';
import { GetFacetsResponseSchema } from '../../../api/octodeck/v1/service_pb';
import {
  buildLabelOptions,
  buildOptions,
  buildRepoDropdown,
  buildSidebar,
  countOf,
  countsByValue,
  facetValues,
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

  it('shows values with matches by default, sorted case-insensitively', () => {
    expect(buildOptions(authors, null, false)).toEqual({ list: ['alice', 'Bob'], hasMore: true });
  });

  it('shows zero-count values with Show all', () => {
    expect(buildOptions(authors, null, true).list).toEqual(['alice', 'Bob', 'Charlie', 'Dave']);
  });

  it('reports no more options when every value has matches', () => {
    expect(buildOptions([fv('a', 1), fv('b', 3)], null, false).hasMore).toBe(false);
  });

  it('always lists the selected value, without duplicating a differently cased match', () => {
    expect(buildOptions(authors, 'zed', false).list).toEqual(['alice', 'Bob', 'zed']);
    expect(buildOptions(authors, 'Charlie', false).list).toEqual(['alice', 'Bob', 'Charlie']);
    expect(buildOptions(authors, 'BOB', false).list).toEqual(['alice', 'Bob']);
  });
});

describe('buildLabelOptions', () => {
  it('carries the label color, and an empty color for an unknown selected label', () => {
    const labels = [fv('kind/bug', 2, { color: 'd73a4a' }), fv('area/api', 1, { color: 'ededed' }), fv('size/L', 0, { color: '0075ca' })];
    expect(buildLabelOptions(labels, 'needs-triage', false)).toEqual({
      list: [
        { name: 'area/api', color: 'ededed' },
        { name: 'kind/bug', color: 'd73a4a' },
        { name: 'needs-triage', color: '' },
      ],
      hasMore: true,
    });
  });
});

describe('buildRepoDropdown', () => {
  const repos = [fv('kubernetes/kubernetes', 3), fv('kubernetes/minikube', 0), fv('golang/go', 1)];
  const orgs = [fv('kubernetes', 3), fv('golang', 1)];

  it('groups repos with matches under their orgs', () => {
    expect(buildRepoDropdown(repos, orgs, { repo: null, org: null }, [], false)).toEqual({
      orgs: ['golang', 'kubernetes'],
      reposByOrg: { golang: ['golang/go'], kubernetes: ['kubernetes/kubernetes'] },
      hasMore: true,
    });
  });

  it('adds zero-count and pinned repos with Show all', () => {
    const d = buildRepoDropdown(repos, orgs, { repo: null, org: null }, ['octocat/hello'], true);
    expect(d.orgs).toEqual(['golang', 'kubernetes', 'octocat']);
    expect(d.reposByOrg).toEqual({
      golang: ['golang/go'],
      kubernetes: ['kubernetes/kubernetes', 'kubernetes/minikube'],
      octocat: ['octocat/hello'],
    });
  });

  it('lists sibling repos when a repo is selected (own-field exclusion), under every owner', () => {
    // The repo facet ignores repo:golang/go; the org facet is narrowed to golang by it.
    const d = buildRepoDropdown(
      [fv('kubernetes/kubernetes', 2), fv('golang/go', 1)],
      [fv('kubernetes', 0), fv('golang', 1)],
      { repo: 'golang/go', org: null },
      [],
      false
    );
    expect(d.orgs).toEqual(['golang', 'kubernetes']);
    expect(d.reposByOrg).toEqual({ golang: ['golang/go'], kubernetes: ['kubernetes/kubernetes'] });
  });

  it('lists every org with matches when an org is selected', () => {
    const d = buildRepoDropdown(
      [fv('kubernetes/kubernetes', 0), fv('golang/go', 1)],
      [fv('kubernetes', 3), fv('golang', 1)],
      { repo: null, org: 'golang' },
      [],
      false
    );
    expect(d.orgs).toEqual(['golang', 'kubernetes']);
    expect(d.reposByOrg).toEqual({ golang: ['golang/go'], kubernetes: [] });
  });

  it('injects the selected repo or org even when the daemon does not know it', () => {
    const d = buildRepoDropdown([], [], { repo: 'new/repo', org: null }, [], false);
    expect(d).toEqual({ orgs: ['new'], reposByOrg: { new: ['new/repo'] }, hasMore: false });
    expect(buildRepoDropdown([], [], { repo: null, org: 'neworg' }, [], false).orgs).toEqual(['neworg']);
  });

  it('reports no more options when everything is displayed', () => {
    expect(buildRepoDropdown([fv('a/b', 1)], [fv('a', 1)], { repo: null, org: null }, [], false).hasMore).toBe(false);
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
