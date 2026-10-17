import { useState } from 'react';
import { create } from '@bufbuild/protobuf';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FacetValueSchema } from '../../../api/octodeck/v1/query_pb';
import { useMenuGroup, type DashboardMenuId } from '../../../hooks/useMenuGroup';
import { DEFAULT_FILTER_CONTROLS, type FilterControls } from '../../../types/filters';
import { OverflowFilterMenu } from '../OverflowFilterMenu';
import { iconTriggerClass } from '../menuStyles';

const fc = (value: string, count: number) => create(FacetValueSchema, { value, count });

function Harness({
  initialFilters = {},
  initialMenu = null,
  withRepository = false,
  withActivity = false,
}: {
  initialFilters?: Partial<FilterControls>;
  initialMenu?: DashboardMenuId | null;
  withRepository?: boolean;
  withActivity?: boolean;
}) {
  const [filters, setFiltersState] = useState<FilterControls>({
    ...DEFAULT_FILTER_CONTROLS,
    ...initialFilters,
  });
  const menus = useMenuGroup<DashboardMenuId>();
  const [initialized, setInitialized] = useState(false);
  if (!initialized && initialMenu) {
    setInitialized(true);
    menus.openMenu(initialMenu);
  }

  const setFilter = <K extends keyof FilterControls>(
    key: K,
    value: FilterControls[K]
  ) => {
    setFiltersState((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <OverflowFilterMenu
      assignee={filters.assignee}
      milestone={filters.milestone}
      assigneeFacets={[fc('alice', 3), fc('bob', 1)]}
      milestoneFacets={[fc('v1.0', 2), fc('v2.0', 1)]}
      currentUser="alice"
      menus={menus}
      setFilter={setFilter}
      repository={
        withRepository
          ? {
              selectedOrgs: filters.org,
              selectedRepos: filters.repo,
              repoFacets: [fc('kubernetes/kubernetes', 5), fc('kubernetes/website', 2)],
              orgFacets: [fc('kubernetes', 7)],
              setOrgOrRepo: (kind, values) =>
                setFiltersState((prev) => ({
                  ...prev,
                  org: kind === 'org' ? [...values] : [],
                  repo: kind === 'repo' ? [...values] : [],
                })),
              setFilters: (partial) => setFiltersState((prev) => ({ ...prev, ...partial })),
            }
          : undefined
      }
      activity={
        withActivity
          ? {
              tracking: filters.tracking,
              triage: filters.triage,
              activity: filters.activity,
              activityFacets: [fc('mention', 2), fc('code', 1)],
              setFilter,
            }
          : undefined
      }
    />
  );
}

describe('OverflowFilterMenu', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the flyout submenu on hover while keeping the parent menu visible, and delays switching between submenus by 100ms', () => {
    vi.useFakeTimers();
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: /More filters/i });
    expect(trigger.className).toBe(iconTriggerClass(false, false));
    expect(trigger.className).toMatch(/\bborder\b/);
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'More filters' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Filter by repository/i })).toBeNull();

    // Parent menu lists Assignee and Milestone
    const assigneeRow = screen.getByRole('button', { name: /Filter by assignee/i });
    const milestoneRow = screen.getByRole('button', { name: /Filter by milestone/i });
    expect(assigneeRow.textContent).toContain('Assignee');
    expect(milestoneRow.textContent).toContain('Milestone');

    // Hovering Assignee when no submenu is open opens the Assignee flyout immediately
    fireEvent.mouseEnter(assigneeRow);
    expect(screen.getByPlaceholderText('Filter assignees…')).toBeDefined();
    expect(screen.getByRole('button', { name: /Filter by assignee/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Filter by milestone/i })).toBeDefined();

    fireEvent.click(screen.getByRole('option', { name: /@bob/i }));
    expect(screen.getByRole('button', { name: /Filter by assignee/i }).textContent).toContain(
      'Assignee'
    );

    // Brushing across Milestone and leaving before 100ms cancels the switch and keeps Assignee open
    fireEvent.mouseEnter(milestoneRow);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.getByPlaceholderText('Filter assignees…')).toBeDefined();
    expect(screen.queryByPlaceholderText('Filter milestones…')).toBeNull();
    fireEvent.mouseLeave(milestoneRow);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByPlaceholderText('Filter assignees…')).toBeDefined();

    // Hovering Milestone for the full 100ms switches the flyout to Milestone
    fireEvent.mouseEnter(milestoneRow);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByPlaceholderText('Filter milestones…')).toBeDefined();
    expect(screen.queryByPlaceholderText('Filter assignees…')).toBeNull();

    // Clicking Assignee switches back immediately without waiting for the hover timer
    fireEvent.click(screen.getByRole('button', { name: /Filter by assignee/i }));
    expect(screen.getByPlaceholderText('Filter assignees…')).toBeDefined();

    // Clicking Milestone switches immediately and lets us select an option
    fireEvent.click(screen.getByRole('button', { name: /Filter by milestone/i }));
    fireEvent.click(screen.getByRole('option', { name: /^v1\.0$/i }));

    // Trigger is highlighted (no count) when Assignee or Milestone is set
    expect(trigger.textContent).toBe('');
    expect(trigger.className).toContain('bg-blue-50');

    // Escape closes both the flyout and parent menu and returns focus to the More filters trigger
    const filterInput = screen.getByPlaceholderText('Filter milestones…');
    fireEvent.keyDown(filterInput, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Filter milestones…')).toBeNull();
    expect(screen.queryByRole('button', { name: /Filter by milestone/i })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('moves between parent rows with the arrow keys and returns focus to the trigger on Escape', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: /More filters/i });
    fireEvent.click(trigger);

    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Filter by assignee/i }));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    const milestoneRow = screen.getByRole('button', { name: /Filter by milestone/i });
    expect(document.activeElement).toBe(milestoneRow);

    fireEvent.keyDown(milestoneRow, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /Filter by milestone/i })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('opens directly into the Assignee or Milestone flyout alongside the parent menu when triggered by menuId', () => {
    render(<Harness initialFilters={{ assignee: ['bob'] }} initialMenu="assignee" />);

    expect(screen.getByRole('button', { name: /Filter by assignee/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Filter by milestone/i })).toBeDefined();
    expect(screen.getByPlaceholderText('Filter assignees…')).toBeDefined();
    const bobOption = screen.getByRole('option', { name: /@bob/i });
    expect(bobOption.getAttribute('aria-selected')).toBe('true');
  });

  it('shows a Repository row when the selector is collapsed into the menu and opens it as a flyout', () => {
    vi.useFakeTimers();
    render(<Harness withRepository />);
    const trigger = screen.getByRole('button', { name: /More filters/i });
    fireEvent.click(trigger);

    const rows = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-haspopup') === 'listbox')
      .map((b) => b.getAttribute('aria-label'));
    expect(rows).toEqual(['Filter by repository', 'Filter by assignee', 'Filter by milestone']);

    // Hovering opens the Repository flyout next to the parent menu
    const repoRow = screen.getByRole('button', { name: /Filter by repository/i });
    fireEvent.mouseEnter(repoRow);
    expect(screen.getByPlaceholderText('Filter repositories…')).toBeDefined();
    expect(repoRow.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /Filter by assignee/i })).toBeDefined();

    // A repo selection highlights the overflow trigger
    fireEvent.click(screen.getByRole('option', { name: 'kubernetes/website' }));
    expect(trigger.className).toBe(iconTriggerClass(true, true));

    // Escape from the flyout closes everything and returns focus to the overflow trigger
    fireEvent.keyDown(screen.getByPlaceholderText('Filter repositories…'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'More filters' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('shows an Activity row when the selector is collapsed into the menu and opens it as a flyout', () => {
    vi.useFakeTimers();
    render(<Harness withActivity />);
    const trigger = screen.getByRole('button', { name: /More filters/i });
    fireEvent.click(trigger);

    const rows = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-haspopup') === 'listbox')
      .map((b) => b.getAttribute('aria-label'));
    expect(rows).toEqual(['Filter by activity', 'Filter by assignee', 'Filter by milestone']);

    // Hovering opens the Activity flyout next to the parent menu
    const activityRow = screen.getByRole('button', { name: /Filter by activity/i });
    fireEvent.mouseEnter(activityRow);
    expect(screen.getByRole('dialog', { name: 'Activity filters' })).toBeDefined();
    expect(activityRow.getAttribute('aria-expanded')).toBe('true');

    // Selecting Subscribed updates filter and highlights the overflow trigger
    fireEvent.click(screen.getByRole('button', { name: /^Subscribed$/i }));
    expect(trigger.className).toBe(iconTriggerClass(true, true));
  });

  it('shows both Repository and Activity rows when both are collapsed', () => {
    render(<Harness withRepository withActivity />);
    const trigger = screen.getByRole('button', { name: /More filters/i });
    fireEvent.click(trigger);

    const rows = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-haspopup') === 'listbox')
      .map((b) => b.getAttribute('aria-label'));
    expect(rows).toEqual([
      'Filter by repository',
      'Filter by activity',
      'Filter by assignee',
      'Filter by milestone',
    ]);
  });
});
