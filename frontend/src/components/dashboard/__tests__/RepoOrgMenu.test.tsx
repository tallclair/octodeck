import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FacetValueSchema, type FacetValue } from '../../../api/octodeck/v1/query_pb';
import { RepoOrgMenu } from '../RepoOrgMenu';

const fv = (value: string, count: number): FacetValue =>
  create(FacetValueSchema, { value, count });

const DEFAULT_REPOS: readonly FacetValue[] = [
  fv('kubernetes/kubernetes', 3),
  fv('kubernetes/minikube', 2),
  fv('golang/go', 0),
];

const DEFAULT_ORGS: readonly FacetValue[] = [
  fv('kubernetes', 5),
  fv('golang', 0),
];

function Harness({
  initialOrgs = [],
  initialRepos = [],
  initialOpen = true,
  repoFacets = DEFAULT_REPOS,
  orgFacets = DEFAULT_ORGS,
}: {
  initialOrgs?: string[];
  initialRepos?: string[];
  initialOpen?: boolean;
  repoFacets?: readonly FacetValue[];
  orgFacets?: readonly FacetValue[];
}) {
  const [orgs, setOrgs] = useState<string[]>(initialOrgs);
  const [repos, setRepos] = useState<string[]>(initialRepos);
  const [open, setOpen] = useState(initialOpen);

  return (
    <RepoOrgMenu
      selectedOrgs={orgs}
      selectedRepos={repos}
      repoFacets={repoFacets}
      orgFacets={orgFacets}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      onClose={() => setOpen(false)}
      setOrgOrRepo={(kind, values) => {
        if (kind === 'org') {
          setOrgs([...values]);
          if (values.length > 0) setRepos([]);
        } else {
          setRepos([...values]);
          if (values.length > 0) setOrgs([]);
        }
      }}
      setFilters={(partial) => {
        if (partial.org !== undefined) setOrgs([...partial.org]);
        if (partial.repo !== undefined) setRepos([...partial.repo]);
      }}
    />
  );
}

describe('RepoOrgMenu', () => {
  it('supports arrow keys, Space/Enter on org vs repo rows with P3 mutual exclusivity, and Escape returning focus to the trigger', () => {
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'Filter by repository' });
    const input = screen.getByPlaceholderText('Filter repositories…');
    const orgOption = screen.getByRole('option', { name: 'kubernetes' });
    const firstRepoOption = screen.getByRole('option', { name: 'kubernetes/kubernetes' });
    const secondRepoOption = screen.getByRole('option', { name: 'kubernetes/minikube' });

    // ArrowDown moves from filter input -> org header -> first repo -> second repo
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(orgOption);

    fireEvent.keyDown(orgOption, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(firstRepoOption);

    fireEvent.keyDown(firstRepoOption, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(secondRepoOption);

    // Space on a repo row selects that repo
    fireEvent.keyDown(secondRepoOption, { key: ' ' });
    expect(secondRepoOption.getAttribute('aria-selected')).toBe('true');

    // ArrowUp back to the org row and Enter on the org row selects the org and clears the repo
    fireEvent.keyDown(secondRepoOption, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(firstRepoOption);
    fireEvent.keyDown(firstRepoOption, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(orgOption);

    fireEvent.keyDown(orgOption, { key: 'Enter' });
    expect(orgOption.getAttribute('aria-selected')).toBe('true');
    expect(secondRepoOption.getAttribute('aria-selected')).toBe('false');

    // Escape closes the menu and returns focus to the trigger button
    fireEvent.keyDown(orgOption, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps an org header visible when only one of its repos matches the filter', () => {
    render(<Harness />);

    const input = screen.getByPlaceholderText('Filter repositories…');
    fireEvent.change(input, { target: { value: 'minikube' } });

    const options = within(screen.getByRole('listbox', { name: 'Repository' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['kubernetes', 'kubernetes/minikube2']);
    expect(screen.getByRole('option', { name: 'kubernetes' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'kubernetes/minikube' })).toBeDefined();
    expect(screen.queryByRole('option', { name: 'kubernetes/kubernetes' })).toBeNull();
  });

  it('reveals zero-count orgs/repos on Show all and resets Show all after the menu is reopened', () => {
    render(<Harness />);

    expect(screen.queryByRole('option', { name: 'golang' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'golang/go' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByRole('option', { name: 'golang' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'golang/go' }).getAttribute('data-zero-count')).toBe('true');

    // Close and reopen -> Show all is reset
    const trigger = screen.getByRole('button', { name: 'Filter by repository' });
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.queryByRole('option', { name: 'golang' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'golang/go' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show all' })).toBeDefined();
  });

  it('renders a selected repo under its org header even when owner casing differs from the org facet', () => {
    render(
      <Harness
        initialRepos={['Kubernetes/foo']}
        repoFacets={[]}
        orgFacets={[fv('kubernetes', 3)]}
      />
    );

    const options = within(screen.getByRole('listbox', { name: 'Repository' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['kubernetes', 'Kubernetes/foo0']);
    expect(screen.getByRole('option', { name: 'Kubernetes/foo' }).getAttribute('aria-selected')).toBe('true');
  });
});
