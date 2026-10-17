import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FILTER_CONTROLS } from '../../../types/filters';
import type { SidebarRepos } from '../../../logic/query/facets';
import { DashboardSidebar, type DashboardSidebarProps } from '../DashboardSidebar';

function createProps(overrides: Partial<DashboardSidebarProps> = {}): DashboardSidebarProps {
  const sidebar: SidebarRepos = {
    repoList: ['owner/alpha', 'owner/beta', 'owner/gamma'],
    activeList: ['owner/alpha', 'owner/beta'],
    hiddenList: ['owner/gamma'],
  };

  return {
    filters: DEFAULT_FILTER_CONTROLS,
    hasNoSecondaryFilters: true,
    sidebar,
    repoSortMode: 'alphabetical',
    repoInboxCounts: {
      'owner/alpha': 2,
      'owner/beta': 0,
      'owner/gamma': 1,
    },
    repoHasUnread: new Set(['owner/alpha']),
    totals: { inbox: 5, new: 2, acked: 10 },
    savedSearches: [],
    applyWorkflowShortcut: vi.fn(),
    toggleRepo: vi.fn(),
    showSettings: false,
    setShowSettings: vi.fn(),
    setShowShortcutsModal: vi.fn(),
    ...overrides,
  };
}

describe('DashboardSidebar', () => {
  it('renders Inbox and Acked buttons without a Workflows header and without a New button', () => {
    const props = createProps();
    render(<DashboardSidebar {...props} />);

    expect(screen.queryByText('Workflows')).toBeNull();
    expect(screen.getByRole('button', { name: /^Inbox/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^Acked/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^New$/i })).toBeNull();
  });

  it('calls applyWorkflowShortcut on clicking Inbox or Acked', () => {
    const applyWorkflowShortcut = vi.fn();
    const props = createProps({ applyWorkflowShortcut });
    render(<DashboardSidebar {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /^Inbox/i }));
    expect(applyWorkflowShortcut).toHaveBeenCalledWith('inbox');

    fireEvent.click(screen.getByRole('button', { name: /^Acked/i }));
    expect(applyWorkflowShortcut).toHaveBeenCalledWith('acked');
  });

  it('renders orange badge on Inbox whenever totals.new > 0', () => {
    const propsWithNew = createProps({
      totals: { inbox: 7, new: 3, acked: 1 },
      filters: { ...DEFAULT_FILTER_CONTROLS, triage: 'inbox' },
      hasNoSecondaryFilters: true,
    });
    const { rerender } = render(<DashboardSidebar {...propsWithNew} />);

    const inboxBtn = screen.getByRole('button', { name: /^Inbox/i });
    const countBadge = inboxBtn.querySelector('span.font-mono');
    expect(countBadge?.textContent).toBe('7');
    expect(countBadge?.className).toContain('text-orange-700');
    expect(countBadge?.className).toContain('bg-orange-100');

    // When totals.new === 0 and Inbox is active, badge is blue/white
    const propsWithoutNew = createProps({
      totals: { inbox: 7, new: 0, acked: 1 },
      filters: { ...DEFAULT_FILTER_CONTROLS, triage: 'inbox' },
      hasNoSecondaryFilters: true,
    });
    rerender(<DashboardSidebar {...propsWithoutNew} />);
    const updatedBadge = screen.getByRole('button', { name: /^Inbox/i }).querySelector('span.font-mono');
    expect(updatedBadge?.className).toContain('bg-blue-700');
    expect(updatedBadge?.className).toContain('text-white');
  });

  it('renders active repos and toggles hidden repos via More / Less in alphabetical mode', () => {
    const toggleRepo = vi.fn();
    const props = createProps({ toggleRepo });
    render(<DashboardSidebar {...props} />);

    expect(screen.getByText('owner/alpha')).toBeDefined();
    expect(screen.getByText('owner/beta')).toBeDefined();
    expect(screen.queryByText('owner/gamma')).toBeNull();

    // Click repo to toggle
    fireEvent.click(screen.getByText('owner/alpha'));
    expect(toggleRepo).toHaveBeenCalledWith('owner/alpha');

    // Click More to show hidden repos
    const moreBtn = screen.getByTestId('toggle-hidden-repos');
    expect(moreBtn.textContent).toContain('More');
    fireEvent.click(moreBtn);

    expect(screen.getByText('owner/gamma')).toBeDefined();
    expect(moreBtn.textContent).toContain('Less');

    // Click Less to collapse
    fireEvent.click(moreBtn);
    expect(screen.queryByText('owner/gamma')).toBeNull();
  });

  it('measures DOM height in non-alphabetical sort and dynamically overflows into More', () => {
    const clientHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.tagName === 'ASIDE') {
          return 100;
        }
        return 0;
      });

    try {
      const sidebar: SidebarRepos = {
        repoList: ['repo/1', 'repo/2', 'repo/3', 'repo/4'],
        activeList: ['repo/1', 'repo/2', 'repo/3', 'repo/4'],
        hiddenList: [],
      };

      const props = createProps({
        sidebar,
        repoSortMode: 'recent_activity',
      });
      render(<DashboardSidebar {...props} />);

      // Exactly 1 visible repo due to clientHeight=100
      expect(screen.getByText('repo/1')).toBeDefined();
      expect(screen.queryByText('repo/2')).toBeNull();
      expect(screen.queryByText('repo/3')).toBeNull();
      expect(screen.queryByText('repo/4')).toBeNull();

      // More button is rendered
      const moreBtn = screen.getByTestId('toggle-hidden-repos');
      expect(moreBtn).toBeDefined();

      // Expand More
      fireEvent.click(moreBtn);
      expect(screen.getByText('repo/2')).toBeDefined();
      expect(screen.getByText('repo/3')).toBeDefined();
      expect(screen.getByText('repo/4')).toBeDefined();
    } finally {
      clientHeightSpy.mockRestore();
    }
  });

  it('shows all repos without More toggle when DOM height accommodates all repositories', () => {
    const clientHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.tagName === 'ASIDE') {
          return 500;
        }
        return 0;
      });

    try {
      const sidebar: SidebarRepos = {
        repoList: ['repo/1', 'repo/2'],
        activeList: ['repo/1', 'repo/2'],
        hiddenList: [],
      };

      const props = createProps({
        sidebar,
        repoSortMode: 'total_items',
      });
      render(<DashboardSidebar {...props} />);

      expect(screen.getByText('repo/1')).toBeDefined();
      expect(screen.getByText('repo/2')).toBeDefined();
      expect(screen.queryByTestId('toggle-hidden-repos')).toBeNull();
    } finally {
      clientHeightSpy.mockRestore();
    }
  });

  it('decrements visible repos when scrollHeight exceeds clientHeight while More is collapsed', () => {
    const clientHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.tagName === 'ASIDE') {
          return 100;
        }
        return 0;
      });

    const scrollHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.tagName === 'ASIDE') {
          return 120; // Causes overflow decrement
        }
        return 0;
      });

    try {
      const sidebar: SidebarRepos = {
        repoList: ['repo/1', 'repo/2', 'repo/3', 'repo/4'],
        activeList: ['repo/1', 'repo/2', 'repo/3', 'repo/4'],
        hiddenList: [],
      };

      const props = createProps({
        sidebar,
        repoSortMode: 'recent_activity',
      });
      render(<DashboardSidebar {...props} />);

      // Normally fitCount is 1 with clientHeight=100.
      // But scrollHeight (120) > clientHeight (100) triggers the decrement pass (1 -> 0).
      expect(screen.queryByText('repo/1')).toBeNull();
      expect(screen.queryByText('repo/2')).toBeNull();
      expect(screen.getByTestId('toggle-hidden-repos')).toBeDefined();
    } finally {
      clientHeightSpy.mockRestore();
      scrollHeightSpy.mockRestore();
    }
  });

  it('calls shortcuts and settings handlers when clicking footer buttons', () => {
    const setShowShortcutsModal = vi.fn();
    const setShowSettings = vi.fn();
    const props = createProps({
      setShowShortcutsModal,
      setShowSettings,
      showSettings: false,
    });
    render(<DashboardSidebar {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Keyboard Shortcuts/i }));
    expect(setShowShortcutsModal).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: /^Settings$/i }));
    expect(setShowSettings).toHaveBeenCalledWith(true);
  });
});
