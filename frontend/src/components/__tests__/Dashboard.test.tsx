/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { Dashboard } from '../Dashboard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as connectQuery from '@connectrpc/connect-query';
import { ItemType, ItemState, ItemStatus, type Item, type User } from '../../api/octodeck/v1/resources_pb';

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
    refetchQueries: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@connectrpc/connect-query', () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(() => ({ mutateAsync: vi.fn() })),
}));

const mockItem: Partial<Item> = {
  id: 'PR_1',
  repo: 'kubernetes/kubernetes',
  number: 100,
  type: ItemType.PR,
  title: 'Test PR',
  body: 'Test body',
  state: ItemState.OPEN,
  url: 'https://github.com/kubernetes/kubernetes/pull/100',
  author: { login: 'octo', avatarUrl: 'https://avatar.url', type: 1 } as unknown as User,
  assignees: [{ login: 'testuser', avatarUrl: '', type: 1 } as unknown as User],
  commits: [],
  comments: [],
  reviews: [],
  createdAt: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 } as any,
  updatedAt: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 } as any,
  local: {
    computedStatus: ItemStatus.NEW,
    isAcked: false,
    privateNotes: '',
  } as unknown as NonNullable<Item['local']>,
};

const mockConfig = {
  pollingIntervalMin: 15,
  watchedRepos: ['kubernetes/kubernetes'],
  pinnedRepos: [],
  excludedRepos: [],
  knownBots: [],
  autoAckOwnActivity: true,
};

describe('Dashboard Component - Settings Modal & Navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState(null, '', '/');
    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [mockItem as Item] },
          isLoading: false,
          isError: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });
  });

  it('toggles settings modal when clicking the settings button', () => {
    render(<Dashboard />);

    expect(screen.queryByRole('dialog')).toBeNull();

    const settingsBtn = screen.getByRole('button', { name: /^Settings$/i });
    fireEvent.click(settingsBtn);

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByRole('heading', { name: /Settings/i })).toBeDefined();

    // Floating Configuration label outside modal should NOT exist
    expect(screen.queryByRole('heading', { name: /^Configuration$/i })).toBeNull();

    // Close via close button in header
    const closeBtn = screen.getByRole('button', { name: /Close settings/i });
    fireEvent.click(closeBtn);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes settings modal when pressing Escape key', () => {
    render(<Dashboard />);

    const settingsBtn = screen.getByRole('button', { name: /^Settings$/i });
    fireEvent.click(settingsBtn);

    expect(screen.getByRole('dialog')).toBeDefined();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes settings modal when clicking the backdrop overlay', () => {
    render(<Dashboard />);

    const settingsBtn = screen.getByRole('button', { name: /^Settings$/i });
    fireEvent.click(settingsBtn);

    const modalDialog = screen.getByRole('dialog');
    fireEvent.click(modalDialog);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('refetches items, config, and sync status when settings are saved', async () => {
    const refetchItemsMock = vi.fn();
    const refetchConfigMock = vi.fn();
    const refetchSyncStatusMock = vi.fn();
    const updateConfigMutate = vi.fn().mockResolvedValue({});

    vi.mocked(connectQuery.useMutation).mockReturnValue({
      mutateAsync: updateConfigMutate,
      isPending: false,
    } as any);

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.method?.name === 'GetItems') {
        return { data: { items: [mockItem as Item] }, isLoading: false, error: null, refetch: refetchItemsMock } as any;
      }
      if (schema?.name === 'GetConfig' || schema?.method?.name === 'GetConfig') {
        return { data: { config: mockConfig }, isLoading: false, error: null, refetch: refetchConfigMock } as any;
      }
      if (schema?.name === 'GetSyncStatus' || schema?.method?.name === 'GetSyncStatus') {
        return { data: {}, isLoading: false, error: null, refetch: refetchSyncStatusMock } as any;
      }
      return { data: {}, isLoading: false, error: null, refetch: vi.fn() } as any;
    });

    render(<Dashboard />);

    const settingsBtn = screen.getByRole('button', { name: /^Settings$/i });
    fireEvent.click(settingsBtn);

    const saveButton = screen.getByRole('button', { name: /Save Settings/i });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(refetchItemsMock).toHaveBeenCalled();
    expect(refetchConfigMock).toHaveBeenCalled();
    expect(refetchSyncStatusMock).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders pinned repositories at the top under Pinned section and other repos under Other Repositories', () => {
    const customConfig = {
      ...mockConfig,
      pinnedRepos: ['kubernetes/kubernetes'],
    };

    const item1: Item = { ...mockItem, id: 'PR_1', repo: 'kubernetes/kubernetes' } as Item;
    const item2: Item = { ...mockItem, id: 'PR_2', repo: 'kubernetes/community' } as Item;

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [item1, item2] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: customConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    // Pinned section should exist
    expect(screen.getByText('Pinned')).toBeDefined();
    expect(screen.getByText('Other Repositories')).toBeDefined();

    // Verify pinned repo appears in sidebar
    const repoButtons = screen.getAllByRole('button', { name: /kubernetes\/kubernetes/i });
    expect(repoButtons.length).toBeGreaterThan(0);

    // Clicking pinned repo displays active repo chip and updates URL
    fireEvent.click(repoButtons[0]);
    expect(window.location.search).toContain('repo=kubernetes%2Fkubernetes');
    const removeRepoBtn = screen.getByLabelText(/Remove repository filter/i);
    expect(removeRepoBtn).toBeDefined();

    // Clicking remove chip clears the repo filter
    fireEvent.click(removeRepoBtn);
    expect(screen.queryByLabelText(/Remove repository filter/i)).toBeNull();
    expect(window.location.search).not.toContain('repo=');
  });

  it('renders pinned repo at the top even when it has zero items', () => {
    const customConfig = {
      ...mockConfig,
      pinnedRepos: ['kubernetes/kubernetes'],
    };

    const itemOther: Item = { ...mockItem, id: 'PR_2', repo: 'kubernetes/enhancements' } as Item;

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [itemOther] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: customConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    expect(screen.getByText('Pinned')).toBeDefined();
    const repoButtons = screen.getAllByRole('button', { name: /kubernetes\/kubernetes/i });
    expect(repoButtons.length).toBeGreaterThan(0);
    expect(screen.getByText('Other Repositories')).toBeDefined();
    expect(screen.getAllByText('kubernetes/enhancements').length).toBeGreaterThan(0);
  });

  it('hides repos without activity in the last 30 days and toggles them with More / Less', () => {
    const customConfig = {
      ...mockConfig,
      pinnedRepos: ['kubernetes/kubernetes'],
    };

    const activeItem: Item = {
      ...mockItem,
      id: 'PR_ACTIVE',
      repo: 'kubernetes/minikube',
      updatedAt: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 } as any,
    } as Item;

    const staleItem: Item = {
      ...mockItem,
      id: 'PR_STALE',
      repo: 'kubernetes/stale-repo',
      createdAt: { seconds: BigInt(Math.floor((Date.now() - 40 * 86400 * 1000) / 1000)), nanos: 0 } as any,
      updatedAt: { seconds: BigInt(Math.floor((Date.now() - 40 * 86400 * 1000) / 1000)), nanos: 0 } as any,
    } as Item;

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [activeItem, staleItem] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: customConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    // Active repo is visible in sidebar
    expect(screen.getByText('kubernetes/minikube')).toBeDefined();

    // Stale repo is hidden by default in the sidebar
    const toggleBtn = screen.getByTestId('toggle-hidden-repos');
    expect(toggleBtn.textContent).toContain('More');
    expect(screen.queryByTestId('hidden-repos-list')).toBeNull();

    // Clicking "More" expands the hidden repos
    fireEvent.click(toggleBtn);
    expect(toggleBtn.textContent).toContain('Less');
    expect(screen.getByTestId('hidden-repos-list')).toBeDefined();
    expect(screen.getByText('kubernetes/stale-repo')).toBeDefined();

    // Clicking "Less" collapses the hidden repos again
    fireEvent.click(toggleBtn);
    expect(toggleBtn.textContent).toContain('More');
    expect(screen.queryByTestId('hidden-repos-list')).toBeNull();
  });
});

describe('Dashboard Component - Generalized Filters & URL Sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState(null, '', '/');
  });

  it('filters items by type (All, PRs, Issues) using the slider segmented control', () => {
    const prItem: Item = { ...mockItem, id: 'PR_1', type: ItemType.PR, url: 'https://github.com/kubernetes/kubernetes/pull/100', title: 'Fix bug PR' } as Item;
    const issueItem: Item = { ...mockItem, id: 'ISSUE_1', type: ItemType.ISSUE, url: 'https://github.com/kubernetes/kubernetes/issues/101', title: 'Open feature issue' } as Item;

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [prItem, issueItem] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    // Initially All items
    expect(screen.getByText('Fix bug PR')).toBeDefined();
    expect(screen.getByText('Open feature issue')).toBeDefined();

    const typeGroup = screen.getByRole('group', { name: /Filter item type/i });

    // Select PRs
    const prsBtn = within(typeGroup).getByRole('button', { name: /PRs/i });
    fireEvent.click(prsBtn);
    expect(screen.getByText('Fix bug PR')).toBeDefined();
    expect(screen.queryByText('Open feature issue')).toBeNull();
    expect(window.location.search).toContain('type=pr');

    // Select Issues
    const issuesBtn = within(typeGroup).getByRole('button', { name: /Issues/i });
    fireEvent.click(issuesBtn);
    expect(screen.queryByText('Fix bug PR')).toBeNull();
    expect(screen.getByText('Open feature issue')).toBeDefined();
    expect(window.location.search).toContain('type=issue');

    // Select All
    const allBtn = within(typeGroup).getByRole('button', { name: /^All$/i });
    fireEvent.click(allBtn);
    expect(screen.getByText('Fix bug PR')).toBeDefined();
    expect(screen.getByText('Open feature issue')).toBeDefined();
    expect(window.location.search).not.toContain('type=');
  });

  it('filters items by triage status (Inbox, New, Acked, All) via title dropdown and sidebar shortcuts', () => {
    const unackedNewItem: Item = {
      ...mockItem,
      id: 'PR_1',
      title: 'New PR',
      local: { computedStatus: ItemStatus.NEW_ACTIVITY, isAcked: false } as any,
    } as Item;
    const unackedIdleItem: Item = {
      ...mockItem,
      id: 'PR_2',
      title: 'Idle PR',
      local: { computedStatus: ItemStatus.IDLE, isAcked: false } as any,
    } as Item;
    const ackedItem: Item = {
      ...mockItem,
      id: 'PR_3',
      title: 'Acked PR',
      local: { computedStatus: ItemStatus.ACKED } as any,
    } as Item;

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [unackedNewItem, unackedIdleItem, ackedItem] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    // Default Inbox: unacked items
    expect(screen.getByText('New PR')).toBeDefined();
    expect(screen.getByText('Idle PR')).toBeDefined();
    expect(screen.queryByText('Acked PR')).toBeNull();

    // Select New via sidebar shortcut
    const newSidebarBtn = screen.getByRole('button', { name: /^New/i });
    fireEvent.click(newSidebarBtn);

    expect(screen.getByText('New PR')).toBeDefined();
    expect(screen.queryByText('Idle PR')).toBeNull();
    expect(screen.queryByText('Acked PR')).toBeNull();
    expect(window.location.search).toContain('triage=activity');

    // Open title status dropdown and select Acked
    const titleDropdownBtn = screen.getByLabelText(/Select triage status/i);
    fireEvent.click(titleDropdownBtn);

    const ackedDropdownOption = screen.getAllByRole('button', { name: /Acked/i })[1];
    fireEvent.click(ackedDropdownOption);

    expect(screen.queryByText('New PR')).toBeNull();
    expect(screen.queryByText('Idle PR')).toBeNull();
    expect(screen.getByText('Acked PR')).toBeDefined();
    expect(window.location.search).toContain('triage=acked');

    // Switch back to Inbox via title dropdown
    fireEvent.click(titleDropdownBtn);
    const inboxDropdownOption = screen.getAllByRole('button', { name: /Inbox/i })[1];
    fireEvent.click(inboxDropdownOption);
    expect(screen.getByText('New PR')).toBeDefined();
    expect(screen.getByText('Idle PR')).toBeDefined();
  });

  it('filters items by state (Open, Closed, All) using the state slider', () => {
    const openItem: Item = { ...mockItem, id: 'PR_1', title: 'Open PR', state: ItemState.OPEN } as Item;
    const closedItem: Item = { ...mockItem, id: 'PR_2', title: 'Closed PR', state: ItemState.CLOSED } as Item;

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [openItem, closedItem] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    // Default: All items (both Open PR and Closed PR)
    expect(screen.getByText('Open PR')).toBeDefined();
    expect(screen.getByText('Closed PR')).toBeDefined();

    const stateTrigger = screen.getByRole('button', { name: /Filter by state/i });

    // Open State menu & select Closed
    fireEvent.click(stateTrigger);
    const closedOption = screen.getByRole('button', { name: /^Closed$/i });
    fireEvent.click(closedOption);

    expect(screen.queryByText('Open PR')).toBeNull();
    expect(screen.getByText('Closed PR')).toBeDefined();
    expect(window.location.search).toContain('state=closed');

    // Open State menu & select Open
    fireEvent.click(stateTrigger);
    const stateMenu = stateTrigger.parentElement!;
    const openOption = within(stateMenu).getByRole('button', { name: /^Open$/i });
    fireEvent.click(openOption);
    expect(screen.getByText('Open PR')).toBeDefined();
    expect(screen.queryByText('Closed PR')).toBeNull();
    expect(window.location.search).toContain('state=open');
  });

  it('filters by assigned=me using the Assigned to me toggle', () => {
    const assignedItem: Item = {
      ...mockItem,
      id: 'PR_1',
      title: 'Assigned PR',
      assignees: [{ login: 'testuser' } as any],
    } as Item;
    const unassignedItem: Item = {
      ...mockItem,
      id: 'PR_2',
      title: 'Unassigned PR',
      assignees: [{ login: 'otheruser' } as any],
    } as Item;

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [assignedItem, unassignedItem] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    expect(screen.getByText('Assigned PR')).toBeDefined();
    expect(screen.getByText('Unassigned PR')).toBeDefined();

    // Click Assigned to me toggle
    const assignedBtn = screen.getByRole('button', { name: /Assigned to me/i });
    fireEvent.click(assignedBtn);

    expect(screen.getByText('Assigned PR')).toBeDefined();
    expect(screen.queryByText('Unassigned PR')).toBeNull();
    expect(window.location.search).toContain('assigned=me');

    // Click again to untoggle
    fireEvent.click(assignedBtn);

    expect(screen.getByText('Assigned PR')).toBeDefined();
    expect(screen.getByText('Unassigned PR')).toBeDefined();
    expect(window.location.search).not.toContain('assigned=');
  });

  it('filters items by author using the list header author select and clears via reset', () => {
    const itemAlice: Item = {
      ...mockItem,
      id: 'PR_1',
      title: 'Alice PR',
      author: { login: 'alice', avatarUrl: '', type: 1 } as unknown as User,
    } as Item;
    const itemBob: Item = {
      ...mockItem,
      id: 'PR_2',
      title: 'Bob PR',
      author: { login: 'bob', avatarUrl: '', type: 1 } as unknown as User,
    } as Item;

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [itemAlice, itemBob] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    const authorTrigger = screen.getByRole('button', { name: /Filter by author/i });
    expect(authorTrigger).toBeDefined();

    // Filter to Alice
    fireEvent.click(authorTrigger);
    const aliceOption = screen.getByRole('button', { name: /@alice/i });
    fireEvent.click(aliceOption);
    expect(screen.getByText('Alice PR')).toBeDefined();
    expect(screen.queryByText('Bob PR')).toBeNull();
    expect(window.location.search).toContain('author=alice');

    // Clear via reset filters button
    const clearFiltersBtn = screen.getByRole('button', { name: /Reset filters/i });
    fireEvent.click(clearFiltersBtn);

    expect(screen.getByText('Alice PR')).toBeDefined();
    expect(screen.getByText('Bob PR')).toBeDefined();
  });

  it('filters by combined Org & Repo selector in the header', () => {
    const itemK8s1: Item = { ...mockItem, id: 'PR_1', repo: 'kubernetes/kubernetes', title: 'K8s core' } as Item;
    const itemK8s2: Item = { ...mockItem, id: 'PR_2', repo: 'kubernetes/minikube', title: 'Minikube' } as Item;
    const itemGo: Item = { ...mockItem, id: 'PR_3', repo: 'golang/go', title: 'Go lang' } as Item;

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [itemK8s1, itemK8s2, itemGo] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    const repoTrigger = screen.getByRole('button', { name: /Filter by repository/i });
    const repoMenu = repoTrigger.parentElement!;

    // Filter by entire Org: kubernetes
    fireEvent.click(repoTrigger);
    const orgOption = within(repoMenu).getByRole('button', { name: /^kubernetes$/i });
    fireEvent.click(orgOption);
    expect(screen.getByText('K8s core')).toBeDefined();
    expect(screen.getByText('Minikube')).toBeDefined();
    expect(screen.queryByText('Go lang')).toBeNull();
    expect(window.location.search).toContain('org=kubernetes');

    // Filter by specific Repo: kubernetes/minikube
    fireEvent.click(repoTrigger);
    const repoOption = within(repoMenu).getByRole('button', { name: /kubernetes\/minikube/i });
    fireEvent.click(repoOption);
    expect(screen.queryByText('K8s core')).toBeNull();
    expect(screen.getByText('Minikube')).toBeDefined();
    expect(window.location.search).toContain('repo=kubernetes%2Fminikube');
  });

  it('initializes filters directly from URL on mount and responds to popstate', () => {
    window.history.pushState(null, '', '/?triage=acked&repo=golang%2Fgo');

    const itemGoAcked: Item = {
      ...mockItem,
      id: 'PR_1',
      repo: 'golang/go',
      title: 'Go PR',
      local: { computedStatus: ItemStatus.ACKED } as any,
    } as Item;
    const itemGoUnacked: Item = {
      ...mockItem,
      id: 'PR_2',
      repo: 'golang/go',
      title: 'Go Unacked PR',
      local: { computedStatus: ItemStatus.NEW } as any,
    } as Item;

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [itemGoAcked, itemGoUnacked] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    // Initial load reflects URL (?triage=acked&repo=golang/go)
    expect(screen.getByText('Go PR')).toBeDefined();
    expect(screen.queryByText('Go Unacked PR')).toBeNull();

    // Trigger popstate event (e.g. user clicked browser Back to '/')
    act(() => {
      window.history.pushState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    // Back to Inbox: unacked items
    expect(screen.queryByText('Go PR')).toBeNull();
    expect(screen.getByText('Go Unacked PR')).toBeDefined();
  });

  it('calls viewItem when opening the details pane for an item', () => {
    const mockViewItemMutate = vi.fn().mockResolvedValue({});
    const mockAckItemMutate = vi.fn().mockResolvedValue({});

    vi.mocked(connectQuery.useMutation).mockImplementation((schema: any) => {
      if (schema?.name === 'ViewItem' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'ViewItem') {
        return { mutateAsync: mockViewItemMutate } as any;
      }
      return { mutateAsync: mockAckItemMutate } as any;
    });

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [mockItem] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    const itemCard = screen.getByText('Test PR');
    fireEvent.click(itemCard);

    expect(mockViewItemMutate).toHaveBeenCalledWith({ itemId: 'PR_1' });
  });

  it('adds item query parameter when opening details pane and removes it when closing', () => {
    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [mockItem] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    expect(window.location.search).not.toContain('item=PR_1');

    // Click item card to open details pane
    const itemCard = screen.getByText('Test PR');
    fireEvent.click(itemCard);

    expect(window.location.search).toContain('item=PR_1');

    // Close details pane via close button
    const closeBtn = screen.getByRole('button', { name: /Close details pane/i });
    fireEvent.click(closeBtn);

    expect(window.location.search).not.toContain('item=PR_1');
  });

  it('closes details pane and sends ack mutation when acking an item', async () => {
    const mockAckItemMutate = vi.fn().mockResolvedValue({});
    const refetchItemsMock = vi.fn().mockResolvedValue({});

    vi.mocked(connectQuery.useMutation).mockImplementation((schema: any) => {
      if (schema?.name === 'AckItem' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'AckItem') {
        return { mutateAsync: mockAckItemMutate } as any;
      }
      return { mutateAsync: vi.fn().mockResolvedValue({}) } as any;
    });

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [mockItem] },
          isLoading: false,
          error: null,
          refetch: refetchItemsMock,
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    // Click item card to open details pane
    const itemCard = screen.getByText('Test PR');
    fireEvent.click(itemCard);

    expect(window.location.search).toContain('item=PR_1');

    // Click Ack button in details pane
    const ackBtn = screen.getByRole('button', { name: /^Ack$/i });
    await act(async () => {
      fireEvent.click(ackBtn);
    });

    expect(mockAckItemMutate).toHaveBeenCalledWith({ itemId: 'PR_1', acked: true });
    expect(window.location.search).not.toContain('item=PR_1');
  });

  it('reopens details pane for item when page is loaded with ?item= parameter', () => {
    window.history.pushState(null, '', '/?item=PR_1');

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [mockItem] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    // Details pane header should be visible with item title link and repo/number
    expect(screen.getAllByText('Test PR').length).toBeGreaterThan(1);
    expect(screen.getAllByText(/kubernetes\/kubernetes/i).length).toBeGreaterThan(1);
  });

  it('reopens details pane for item when page is loaded with ?item=repo#number canonical reference', () => {
    window.history.pushState(null, '', '/?item=kubernetes%2Fkubernetes%23100');

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [mockItem] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    // Details pane header should be visible with item title link and repo/number
    expect(screen.getAllByText('Test PR').length).toBeGreaterThan(1);
    expect(screen.getAllByText(/kubernetes\/kubernetes/i).length).toBeGreaterThan(1);
  });

  it('filters by milestone via dropdown and manages milestone filter chip', () => {
    const item1: Partial<Item> = {
      ...mockItem,
      id: 'PR_1',
      title: 'Milestone 1.32 PR',
      milestone: {
        id: 'MS_1',
        number: 1,
        title: 'v1.32',
      } as any,
    };
    const item2: Partial<Item> = {
      ...mockItem,
      id: 'PR_2',
      title: 'Milestone 1.33 PR',
      milestone: {
        id: 'MS_2',
        number: 2,
        title: 'v1.33',
      } as any,
    };

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [item1, item2] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    // Both items visible initially
    expect(screen.getByText('Milestone 1.32 PR')).toBeDefined();
    expect(screen.getByText('Milestone 1.33 PR')).toBeDefined();

    // Click Milestone dropdown button
    const milestoneDropdownBtn = screen.getByRole('button', { name: /Filter by milestone/i });
    fireEvent.click(milestoneDropdownBtn);

    // Dropdown options visible
    expect(screen.getByRole('button', { name: /^v1\.32$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^v1\.33$/i })).toBeDefined();

    // Select v1.32
    fireEvent.click(screen.getByRole('button', { name: /^v1\.32$/i }));

    // Verify filter applied: item 1 visible, item 2 not
    expect(screen.getByText('Milestone 1.32 PR')).toBeDefined();
    expect(screen.queryByText('Milestone 1.33 PR')).toBeNull();

    // Verify filter chip is displayed
    expect(screen.getByText('Milestone:')).toBeDefined();
    expect(screen.getByRole('button', { name: /Remove milestone filter/i })).toBeDefined();

    // Verify URL param updated
    expect(window.location.search).toContain('milestone=v1.32');

    // Click remove milestone filter chip [x]
    fireEvent.click(screen.getByRole('button', { name: /Remove milestone filter/i }));

    // Both items visible again and URL param cleared
    expect(screen.getByText('Milestone 1.32 PR')).toBeDefined();
    expect(screen.getByText('Milestone 1.33 PR')).toBeDefined();
    expect(window.location.search).not.toContain('milestone=');
  });

  it('filters author, milestone, and repository dropdowns to currently displayed items with Show all toggle', () => {
    // 3 items in the workspace:
    // item 1: New activity, author: alice, milestone: v1.0, repo: kubernetes/kubernetes
    // item 2: New activity, author: bob, milestone: v1.1, repo: kubernetes/minikube
    // item 3: Idle, author: charlie, milestone: v2.0, repo: golang/go
    const item1: Item = {
      ...mockItem,
      id: 'PR_1',
      title: 'Item 1',
      repo: 'kubernetes/kubernetes',
      author: { login: 'alice', avatarUrl: '', type: 1 } as unknown as User,
      milestone: { id: 'MS_1', number: 1, title: 'v1.0' } as any,
      local: { computedStatus: ItemStatus.NEW_ACTIVITY, isAcked: false } as any,
    } as Item;

    const item2: Item = {
      ...mockItem,
      id: 'PR_2',
      title: 'Item 2',
      repo: 'kubernetes/minikube',
      author: { login: 'bob', avatarUrl: '', type: 1 } as unknown as User,
      milestone: { id: 'MS_2', number: 2, title: 'v1.1' } as any,
      local: { computedStatus: ItemStatus.NEW_ACTIVITY, isAcked: false } as any,
    } as Item;

    const item3: Item = {
      ...mockItem,
      id: 'PR_3',
      title: 'Item 3',
      repo: 'golang/go',
      author: { login: 'charlie', avatarUrl: '', type: 1 } as unknown as User,
      milestone: { id: 'MS_3', number: 3, title: 'v2.0' } as any,
      local: { computedStatus: ItemStatus.IDLE, isAcked: false } as any,
    } as Item;

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [item1, item2, item3] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    // Switch to "New" activity view (triage=activity) where only item1 & item2 are displayed
    const newSidebarBtn = screen.getByRole('button', { name: /^New/i });
    fireEvent.click(newSidebarBtn);

    expect(screen.getByText('Item 1')).toBeDefined();
    expect(screen.getByText('Item 2')).toBeDefined();
    expect(screen.queryByText('Item 3')).toBeNull();

    // 1. Check Author dropdown: only alice and bob shown by default, charlie is hidden
    const authorTrigger = screen.getByRole('button', { name: /Filter by author/i });
    fireEvent.click(authorTrigger);

    expect(screen.getByRole('button', { name: /@alice/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /@bob/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /@charlie/i })).toBeNull();

    // "Show all" option should be present at the bottom of Author dropdown
    const authorShowAllBtn = screen.getByRole('button', { name: /^Show all$/i });
    expect(authorShowAllBtn).toBeDefined();

    // Clicking "Show all" unfilters the author dropdown options
    fireEvent.click(authorShowAllBtn);
    expect(screen.getByRole('button', { name: /@charlie/i })).toBeDefined();

    // Closing the author dropdown (press Escape) and reopening should reset it back to filtered
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /@charlie/i })).toBeNull();

    fireEvent.click(authorTrigger);
    expect(screen.getByRole('button', { name: /@alice/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /@bob/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /@charlie/i })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });

    // 2. Check Milestone dropdown: only v1.0 and v1.1 shown by default, v2.0 is hidden
    const milestoneTrigger = screen.getByRole('button', { name: /Filter by milestone/i });
    fireEvent.click(milestoneTrigger);

    expect(screen.getByRole('button', { name: /^v1\.0$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^v1\.1$/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^v2\.0$/i })).toBeNull();

    // "Show all" option should be present in Milestone dropdown
    const milestoneShowAllBtn = screen.getByRole('button', { name: /^Show all$/i });
    expect(milestoneShowAllBtn).toBeDefined();

    // Clicking "Show all" reveals v2.0
    fireEvent.click(milestoneShowAllBtn);
    expect(screen.getByRole('button', { name: /^v2\.0$/i })).toBeDefined();
    fireEvent.keyDown(window, { key: 'Escape' });

    // 3. Check Repository dropdown: only kubernetes/kubernetes and kubernetes/minikube shown by default, golang/go is hidden
    const repoTrigger = screen.getByRole('button', { name: /Filter by repository/i });
    const repoMenu = repoTrigger.parentElement!;
    fireEvent.click(repoTrigger);

    expect(within(repoMenu).getByRole('button', { name: /^kubernetes$/i })).toBeDefined();
    expect(within(repoMenu).getByRole('button', { name: /kubernetes\/kubernetes/i })).toBeDefined();
    expect(within(repoMenu).getByRole('button', { name: /kubernetes\/minikube/i })).toBeDefined();
    expect(within(repoMenu).queryByRole('button', { name: /^golang$/i })).toBeNull();
    expect(within(repoMenu).queryByRole('button', { name: /golang\/go/i })).toBeNull();

    // "Show all" option should be present in Repository dropdown
    const repoShowAllBtn = within(repoMenu).getByRole('button', { name: /^Show all$/i });
    expect(repoShowAllBtn).toBeDefined();

    // Clicking "Show all" reveals golang org and golang/go repo
    fireEvent.click(repoShowAllBtn);
    expect(within(repoMenu).getByRole('button', { name: /^golang$/i })).toBeDefined();
    expect(within(repoMenu).getByRole('button', { name: /golang\/go/i })).toBeDefined();
    fireEvent.keyDown(window, { key: 'Escape' });
  });

  it('hides Show all button when all workspace options are already displayed', () => {
    const item1: Item = {
      ...mockItem,
      id: 'PR_1',
      title: 'Item 1',
      repo: 'kubernetes/kubernetes',
      author: { login: 'alice', avatarUrl: '', type: 1 } as unknown as User,
      milestone: { id: 'MS_1', number: 1, title: 'v1.0' } as any,
    } as Item;

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [item1] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    // In Author dropdown with all items displayed, Show all should not be present
    const authorTrigger = screen.getByRole('button', { name: /Filter by author/i });
    const authorMenu = authorTrigger.parentElement!;
    fireEvent.click(authorTrigger);
    expect(within(authorMenu).getByRole('button', { name: /@alice/i })).toBeDefined();
    expect(within(authorMenu).queryByRole('button', { name: /^Show all$/i })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });

    // In Milestone dropdown, Show all should not be present
    const milestoneTrigger = screen.getByRole('button', { name: /Filter by milestone/i });
    const milestoneMenu = milestoneTrigger.parentElement!;
    fireEvent.click(milestoneTrigger);
    expect(within(milestoneMenu).getByRole('button', { name: /^v1\.0$/i })).toBeDefined();
    expect(within(milestoneMenu).queryByRole('button', { name: /^Show all$/i })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });

    // In Repository dropdown, Show all should not be present
    const repoTrigger = screen.getByRole('button', { name: /Filter by repository/i });
    const repoMenu = repoTrigger.parentElement!;
    fireEvent.click(repoTrigger);
    expect(within(repoMenu).getByRole('button', { name: /kubernetes\/kubernetes/i })).toBeDefined();
    expect(within(repoMenu).queryByRole('button', { name: /^Show all$/i })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
  });

  it('filters items by label from dropdown menu and clears via active chip', () => {
    const item1: Item = {
      ...mockItem,
      id: 'PR_1',
      title: 'Fix issue 1',
      labels: [{ name: 'kind/bug', color: 'd73a4a' } as any],
    } as Item;
    const item2: Item = {
      ...mockItem,
      id: 'PR_2',
      title: 'Feature 2',
      labels: [{ name: 'kind/feature', color: 'a2eeef' } as any],
    } as Item;

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [item1, item2] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);

    // Initially both items are shown
    expect(screen.getByText('Fix issue 1')).toBeDefined();
    expect(screen.getByText('Feature 2')).toBeDefined();

    // Open Label dropdown and select 'kind/bug'
    const labelTrigger = screen.getByRole('button', { name: /Filter by label/i });
    fireEvent.click(labelTrigger);

    const bugOption = screen.getByRole('button', { name: /kind\/bug/i });
    fireEvent.click(bugOption);

    // Only item1 matches
    expect(screen.getByText('Fix issue 1')).toBeDefined();
    expect(screen.queryByText('Feature 2')).toBeNull();

    // Active chip is displayed
    expect(screen.getByText('Label:')).toBeDefined();
    expect(screen.getAllByText('kind/bug').length).toBeGreaterThanOrEqual(1);

    // Remove label filter chip
    const removeChipBtn = screen.getByRole('button', { name: /Remove label filter/i });
    fireEvent.click(removeChipBtn);

    // Both items visible again
    expect(screen.getByText('Fix issue 1')).toBeDefined();
    expect(screen.getByText('Feature 2')).toBeDefined();
  });

  it('renders a prominent warning banner when disconnected from backend daemon and allows reconnecting', async () => {
    const mockRefetchItems = vi.fn();
    const mockRefetchConfig = vi.fn();
    const mockRefetchSyncStatus = vi.fn();

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: null,
          isLoading: false,
          isError: true,
          error: new Error('Failed to fetch'),
          refetch: mockRefetchItems,
        } as any;
      }
      if (schema?.name === 'GetSyncStatus' || schema?.method?.name === 'GetSyncStatus') {
        return {
          data: null,
          isLoading: false,
          isError: true,
          error: new Error('Failed to fetch'),
          refetch: mockRefetchSyncStatus,
        } as any;
      }
      return {
        data: null,
        isLoading: false,
        isError: true,
        error: new Error('Failed to fetch'),
        refetch: mockRefetchConfig,
      } as any;
    });

    render(<Dashboard />);

    // Prominent warning banner should be visible
    const banner = screen.getByTestId('daemon-disconnected-banner');
    expect(banner).toBeDefined();
    expect(within(banner).getByText(/Disconnected from OctoDeck daemon/i)).toBeDefined();
    expect(within(banner).getByText('octodeck serve')).toBeDefined();

    // Click Reconnect button
    const reconnectBtn = within(banner).getByRole('button', { name: /Reconnect/i });
    expect(reconnectBtn).toBeDefined();
    fireEvent.click(reconnectBtn);

    expect(mockRefetchItems).toHaveBeenCalled();
    expect(mockRefetchConfig).toHaveBeenCalled();
    expect(mockRefetchSyncStatus).toHaveBeenCalled();
  });

  it('does not render warning banner when daemon is connected and healthy', () => {
    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [mockItem as Item] },
          isLoading: false,
          isError: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: mockConfig, currentUserLogin: 'testuser' },
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<Dashboard />);
    expect(screen.queryByTestId('daemon-disconnected-banner')).toBeNull();
  });

  describe('Sidebar Repository Badges', () => {
    it('displays unacked item count with orange New styling when repo has new activity', () => {
      const repoWithNewActivity: Partial<Item> = {
        ...mockItem,
        id: 'PR_1',
        repo: 'kubernetes/kubernetes',
        local: { computedStatus: ItemStatus.NEW, isAcked: false, privateNotes: '' } as any,
      };
      const repoWithIdle: Partial<Item> = {
        ...mockItem,
        id: 'PR_2',
        repo: 'kubernetes/kubernetes',
        local: { computedStatus: ItemStatus.IDLE, isAcked: false, privateNotes: '' } as any,
      };

      vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
        if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
          return {
            data: { items: [repoWithNewActivity as Item, repoWithIdle as Item] },
            isLoading: false,
            error: null,
            refetch: vi.fn(),
          } as any;
        }
        return {
          data: { config: mockConfig, currentUserLogin: 'testuser' },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      });

      render(<Dashboard />);

      // Total unacked count is 2 (1 NEW + 1 IDLE)
      const countEl = screen.getByTestId('repo-count-kubernetes/kubernetes');
      expect(countEl.textContent).toBe('2');

      // Orange styling from New section should be applied
      expect(countEl.className).toContain('bg-orange-100');
      expect(countEl.className).toContain('text-orange-700');
    });

    it('displays unacked count with neutral slate styling when repo has unacked items but no unread activity', () => {
      const repoWithIdle1: Partial<Item> = {
        ...mockItem,
        id: 'PR_1',
        repo: 'kubernetes/kubernetes',
        local: { computedStatus: ItemStatus.IDLE, isAcked: false, privateNotes: '' } as any,
      };
      const repoWithNoise: Partial<Item> = {
        ...mockItem,
        id: 'PR_2',
        repo: 'kubernetes/kubernetes',
        local: { computedStatus: ItemStatus.NOISE, isAcked: false, privateNotes: '' } as any,
      };

      vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
        if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
          return {
            data: { items: [repoWithIdle1 as Item, repoWithNoise as Item] },
            isLoading: false,
            error: null,
            refetch: vi.fn(),
          } as any;
        }
        return {
          data: { config: mockConfig, currentUserLogin: 'testuser' },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      });

      render(<Dashboard />);

      // Total unacked count is 2
      const countEl = screen.getByTestId('repo-count-kubernetes/kubernetes');
      expect(countEl.textContent).toBe('2');

      // Neutral slate styling should be applied
      expect(countEl.className).toContain('bg-slate-200');
      expect(countEl.className).toContain('text-slate-700');
      expect(countEl.className).not.toContain('bg-orange-100');
    });

    it('does not display any badge when all items in repo are acked', () => {
      const ackedItem: Partial<Item> = {
        ...mockItem,
        id: 'PR_1',
        repo: 'kubernetes/kubernetes',
        local: { computedStatus: ItemStatus.ACKED, isAcked: true, privateNotes: '' } as any,
      };

      vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
        if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
          return {
            data: { items: [ackedItem as Item] },
            isLoading: false,
            error: null,
            refetch: vi.fn(),
          } as any;
        }
        return {
          data: { config: mockConfig, currentUserLogin: 'testuser' },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      });

      render(<Dashboard />);

      expect(screen.queryByTestId('repo-count-kubernetes/kubernetes')).toBeNull();
    });
  });

  describe('Offline Initial State (FE-05)', () => {
    it('renders explicit Daemon Offline empty state card when isDisconnected and items.length is 0', () => {
      vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
        if (schema?.name === 'GetItems' || schema?.method?.name === 'GetItems') {
          return {
            data: { items: [] },
            isLoading: false,
            isError: true,
            error: new Error('Network error'),
            refetch: vi.fn(),
          } as any;
        }
        return {
          data: { config: mockConfig, currentUserLogin: 'testuser' },
          isLoading: false,
          isError: true,
          error: new Error('Network error'),
          refetch: vi.fn(),
        } as any;
      });

      render(<Dashboard />);

      expect(screen.getByTestId('daemon-offline-empty-state')).toBeDefined();
      expect(screen.getByText(/Daemon Offline — Please start octodeck serve/i)).toBeDefined();
    });
  });

  describe('Real-Time Updates & Live Sync Status (Req 1, 2, 3)', () => {
    it('configures query polling intervals on getItems and getSyncStatus', () => {
      const queryCalls: { schemaName: string; options: any }[] = [];
      vi.mocked(connectQuery.useQuery).mockImplementation((schema: any, _input: any, options: any) => {
        const name = schema?.name || schema?.method?.name;
        queryCalls.push({ schemaName: name, options });
        if (name === 'GetItems') {
          return { data: { items: [mockItem as Item] }, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
        }
        if (name === 'GetConfig') {
          return { data: { config: mockConfig, currentUserLogin: 'testuser' }, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
        }
        if (name === 'GetSyncStatus') {
          return { data: { status: { isSyncing: false } }, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
        }
        return { data: {}, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
      });

      render(<Dashboard />);

      const getItemsCall = queryCalls.find(c => c.schemaName === 'GetItems');
      expect(getItemsCall).toBeDefined();
      expect(getItemsCall?.options?.refetchInterval).toBe(3000);
      expect(getItemsCall?.options?.staleTime).toBe(1000);

      const getSyncStatusCall = queryCalls.find(c => c.schemaName === 'GetSyncStatus');
      expect(getSyncStatusCall).toBeDefined();
      expect(getSyncStatusCall?.options?.refetchInterval).toBe(2000);
      expect(getSyncStatusCall?.options?.staleTime).toBe(1000);
    });

    it('renders live syncing status indicator in navigation bar when isSyncing is true', () => {
      vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
        const name = schema?.name || schema?.method?.name;
        if (name === 'GetItems') {
          return { data: { items: [mockItem as Item] }, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
        }
        if (name === 'GetConfig') {
          return { data: { config: mockConfig, currentUserLogin: 'testuser' }, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
        }
        if (name === 'GetSyncStatus') {
          return {
            data: {
              status: {
                isSyncing: true,
                lastSuccessfulSyncAt: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 },
              },
            },
            isLoading: false,
            isError: false,
            error: null,
            refetch: vi.fn(),
          } as any;
        }
        return { data: {}, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
      });

      render(<Dashboard />);

      expect(screen.getByText('Syncing...')).toBeDefined();
    });

    it('automatically refetches items when daemon sync completes or status updates', () => {
      const refetchItemsMock = vi.fn();
      let syncStatusState = {
        isSyncing: true,
        lastUpdateReceivedAt: { seconds: BigInt(1000), nanos: 0 },
        lastSuccessfulSyncAt: { seconds: BigInt(1000), nanos: 0 },
      };

      vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
        const name = schema?.name || schema?.method?.name;
        if (name === 'GetItems') {
          return { data: { items: [mockItem as Item] }, isLoading: false, isError: false, error: null, refetch: refetchItemsMock } as any;
        }
        if (name === 'GetConfig') {
          return { data: { config: mockConfig, currentUserLogin: 'testuser' }, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
        }
        if (name === 'GetSyncStatus') {
          return { data: { status: syncStatusState }, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
        }
        return { data: {}, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
      });

      const { rerender } = render(<Dashboard />);

      // Transition isSyncing from true to false (sync completed)
      syncStatusState = {
        isSyncing: false,
        lastUpdateReceivedAt: { seconds: BigInt(2000), nanos: 0 },
        lastSuccessfulSyncAt: { seconds: BigInt(2000), nanos: 0 },
      };

      act(() => {
        rerender(<Dashboard />);
      });

      expect(refetchItemsMock).toHaveBeenCalled();
    });

    it('refetches items when daemon updates sub-second nanos timestamp', () => {
      const refetchItemsMock = vi.fn();
      let syncStatusState = {
        isSyncing: false,
        lastUpdateReceivedAt: { seconds: BigInt(1000), nanos: 100 },
        lastSuccessfulSyncAt: { seconds: BigInt(1000), nanos: 100 },
      };

      vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
        const name = schema?.name || schema?.method?.name;
        if (name === 'GetItems') {
          return { data: { items: [mockItem as Item] }, isLoading: false, isError: false, error: null, refetch: refetchItemsMock } as any;
        }
        if (name === 'GetConfig') {
          return { data: { config: mockConfig, currentUserLogin: 'testuser' }, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
        }
        if (name === 'GetSyncStatus') {
          return { data: { status: syncStatusState }, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
        }
        return { data: {}, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
      });

      const { rerender } = render(<Dashboard />);

      // On initial mount, refetchItems should not have been called redundantly by timestamp effect
      expect(refetchItemsMock).not.toHaveBeenCalled();

      // Sub-second update arrives (same second 1000, different nanos 500)
      syncStatusState = {
        isSyncing: false,
        lastUpdateReceivedAt: { seconds: BigInt(1000), nanos: 500 },
        lastSuccessfulSyncAt: { seconds: BigInt(1000), nanos: 100 },
      };

      act(() => {
        rerender(<Dashboard />);
      });

      expect(refetchItemsMock).toHaveBeenCalledTimes(1);
    });

    it('updates open details pane automatically when updated item data is received', () => {
      const initialItem: Item = {
        ...mockItem,
        id: 'PR_1',
        title: 'Original Title',
        comments: [],
      } as unknown as Item;

      let currentItems = [initialItem];

      vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
        const name = schema?.name || schema?.method?.name;
        if (name === 'GetItems') {
          return { data: { items: currentItems }, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
        }
        if (name === 'GetConfig') {
          return { data: { config: mockConfig, currentUserLogin: 'testuser' }, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
        }
        if (name === 'GetSyncStatus') {
          return { data: { status: { isSyncing: false } }, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
        }
        return { data: {}, isLoading: false, isError: false, error: null, refetch: vi.fn() } as any;
      });

      // Select item PR_1 in URL
      window.history.pushState(null, '', '/?item=PR_1');
      const { rerender } = render(<Dashboard />);

      expect(screen.getAllByText('Original Title').length).toBeGreaterThanOrEqual(1);

      // Receive updated item with new comment from daemon
      const updatedItem: Item = {
        ...mockItem,
        id: 'PR_1',
        title: 'Updated PR Title',
        comments: [
          {
            id: 'c1',
            bodyText: 'New live comment from maintainer',
            createdAt: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 },
            author: { login: 'reviewer1', avatarUrl: '', type: 1 },
          } as any,
        ],
      } as unknown as Item;

      currentItems = [updatedItem];

      act(() => {
        rerender(<Dashboard />);
      });

      expect(screen.getAllByText('Updated PR Title').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('New live comment from maintainer').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Dashboard Component - Keyboard Navigation & Shortcuts', () => {
    it('opens keyboard shortcuts modal when pressing ? key or clicking sidebar button', () => {
      render(<Dashboard />);

      expect(screen.queryByRole('dialog', { name: /Keyboard Shortcuts/i })).toBeNull();

      // Open via '?' key
      fireEvent.keyDown(window, { key: '?' });
      expect(screen.getByRole('dialog')).toBeDefined();
      expect(screen.getByRole('heading', { name: /Keyboard Shortcuts/i })).toBeDefined();

      // Close via Escape
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();

      // Open via sidebar button
      const shortcutsBtn = screen.getByRole('button', { name: /Keyboard Shortcuts/i });
      fireEvent.click(shortcutsBtn);
      expect(screen.getByRole('dialog')).toBeDefined();
      expect(screen.getByRole('heading', { name: /Keyboard Shortcuts/i })).toBeDefined();
    });

    it('navigates with j/k, opens details with Enter, and acks with e key', async () => {
      const ackItemMutate = vi.fn().mockResolvedValue({});
      vi.mocked(connectQuery.useMutation).mockReturnValue({
        mutateAsync: ackItemMutate,
      } as any);

      render(<Dashboard />);

      // Focus first item with 'j'
      fireEvent.keyDown(window, { key: 'j' });

      // Open details with 'Enter'
      fireEvent.keyDown(window, { key: 'Enter' });
      expect(window.location.search).toContain('item=PR_1');

      // Ack item with 'e'
      await act(async () => {
        fireEvent.keyDown(window, { key: 'e' });
      });

      expect(ackItemMutate).toHaveBeenCalledWith({
        itemId: 'PR_1',
        acked: true,
      });
    });

    it('acks item from list view via card quick-ack button and applies animate-item-ack class', async () => {
      let resolveMutation: () => void;
      const mutationPromise = new Promise<any>((resolve) => {
        resolveMutation = () => resolve({});
      });
      const ackItemMutate = vi.fn().mockReturnValue(mutationPromise);
      vi.mocked(connectQuery.useMutation).mockReturnValue({
        mutateAsync: ackItemMutate,
      } as any);

      const { container } = render(<Dashboard />);

      const quickAckBtn = screen.getByTestId('card-ack-btn');
      expect(quickAckBtn).toBeDefined();

      const itemRow = container.querySelector('[data-item-id="PR_1"]');
      expect(itemRow?.classList.contains('animate-item-ack')).toBe(false);

      act(() => {
        fireEvent.click(quickAckBtn);
      });

      // Item should have animate-item-ack applied immediately
      expect(itemRow?.classList.contains('animate-item-ack')).toBe(true);

      await act(async () => {
        resolveMutation!();
      });

      expect(ackItemMutate).toHaveBeenCalledWith({
        itemId: 'PR_1',
        acked: true,
      });
    });
  });
});


