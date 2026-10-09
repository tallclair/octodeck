/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react';
import { Dashboard } from '../Dashboard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as connectQuery from '@connectrpc/connect-query';
import { ItemType, ItemState, ItemStatus, SubscriptionState, type Item, type User } from '../../api/octodeck/v1/resources_pb';
import { checkStatus } from '../../api/client';

const { invalidateQueriesMock, setQueriesDataMock } = vi.hoisted(() => ({
  invalidateQueriesMock: vi.fn().mockResolvedValue(undefined),
  setQueriesDataMock: vi.fn(),
}));

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return {
    ...actual,
    checkStatus: vi.fn().mockResolvedValue({
      gh_authenticated: true,
      version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'v0.0.1',
    }),
  };
});

vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: (previous: unknown) => previous,
  useQueryClient: () => ({
    invalidateQueries: invalidateQueriesMock,
    refetchQueries: vi.fn().mockResolvedValue(undefined),
    setQueriesData: setQueriesDataMock,
  }),
}));

vi.mock('@connectrpc/connect-query', () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(() => ({ mutateAsync: vi.fn() })),
}));

// These tests stub connect-query hooks per RPC and only cover UI behaviour that does not depend
// on the query sent to the daemon. Facet (GetFacets) and selected-item fallback (GetItem) queries
// get empty data here; filtering, options and counts are covered at the RPC level in
// Dashboard.rpc.test.tsx.
function stubAuxiliaryQuery(schema: any): any {
  const name = schema?.name ?? schema?.method?.name;
  if (name === 'GetFacets') {
    return { data: { facets: [] }, isLoading: false, isError: false, error: null, refetch: vi.fn() };
  }
  if (name === 'GetItem') {
    return { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() };
  }
  return undefined;
}

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
      const auxiliary = stubAuxiliaryQuery(schema);
      if (auxiliary) return auxiliary;
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
      const auxiliary = stubAuxiliaryQuery(schema);
      if (auxiliary) return auxiliary;
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

});

describe('Dashboard Component - Generalized Filters & URL Sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState(null, '', '/');
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
      const auxiliary = stubAuxiliaryQuery(schema);
      if (auxiliary) return auxiliary;
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
      const auxiliary = stubAuxiliaryQuery(schema);
      if (auxiliary) return auxiliary;
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
      const auxiliary = stubAuxiliaryQuery(schema);
      if (auxiliary) return auxiliary;
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
      const auxiliary = stubAuxiliaryQuery(schema);
      if (auxiliary) return auxiliary;
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
      const auxiliary = stubAuxiliaryQuery(schema);
      if (auxiliary) return auxiliary;
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

  it('renders a prominent warning banner when disconnected from backend daemon and allows reconnecting', async () => {
    const mockRefetchItems = vi.fn();
    const mockRefetchConfig = vi.fn();
    const mockRefetchSyncStatus = vi.fn();

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      const auxiliary = stubAuxiliaryQuery(schema);
      if (auxiliary) return auxiliary;
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
      const auxiliary = stubAuxiliaryQuery(schema);
      if (auxiliary) return auxiliary;
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
    it('does not display any badge when all items in repo are acked', () => {
      const ackedItem: Partial<Item> = {
        ...mockItem,
        id: 'PR_1',
        repo: 'kubernetes/kubernetes',
        local: { computedStatus: ItemStatus.ACKED, isAcked: true, privateNotes: '' } as any,
      };

      vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
        const auxiliary = stubAuxiliaryQuery(schema);
        if (auxiliary) return auxiliary;
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
        const auxiliary = stubAuxiliaryQuery(schema);
        if (auxiliary) return auxiliary;
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
        const auxiliary = stubAuxiliaryQuery(schema);
        if (auxiliary) return auxiliary;
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
        const auxiliary = stubAuxiliaryQuery(schema);
        if (auxiliary) return auxiliary;
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
        const auxiliary = stubAuxiliaryQuery(schema);
        if (auxiliary) return auxiliary;
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
        const auxiliary = stubAuxiliaryQuery(schema);
        if (auxiliary) return auxiliary;
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
        const auxiliary = stubAuxiliaryQuery(schema);
        if (auxiliary) return auxiliary;
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

  describe('Daemon Version Surfacing in Settings', () => {
    it('passes daemon version from checkStatus to Settings modal', async () => {
      vi.mocked(checkStatus).mockResolvedValue({
        gh_authenticated: true,
        version: 'v1.2.3-test',
      });
      render(<Dashboard />);

      const settingsBtn = screen.getByRole('button', { name: /^Settings$/i });
      fireEvent.click(settingsBtn);

      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeDefined();
      await waitFor(() => {
        expect(within(dialog).getByText(/Version:/)).toBeDefined();
        expect(within(dialog).getByText('v1.2.3-test')).toBeDefined();
      });
    });
  });

  describe('Subscription Mutation Wiring', () => {
    it('triggers updateSubscription mutation with SubscriptionState.SUBSCRIBED and refetches items when handleSubscribe is invoked from PullRequestCard', async () => {
      const refetchItemsMock = vi.fn().mockResolvedValue({});
      const untrackedMockItem: Partial<Item> = {
        ...mockItem,
        id: 'PR_1',
        viewerSubscription: SubscriptionState.UNSUBSCRIBED,
      };

      vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
        const auxiliary = stubAuxiliaryQuery(schema);
        if (auxiliary) return auxiliary;
        if (schema?.name === 'GetItems' || schema?.method?.name === 'GetItems') {
          return {
            data: { items: [untrackedMockItem as Item] },
            isLoading: false,
            isError: false,
            error: null,
            refetch: refetchItemsMock,
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

      const updateSubscriptionMutateMock = vi.fn().mockResolvedValue({
        item: { ...untrackedMockItem, viewerSubscription: SubscriptionState.SUBSCRIBED },
      });

      vi.mocked(connectQuery.useMutation).mockImplementation((schema: any) => {
        if (schema?.name === 'UpdateSubscription' || schema?.method?.name === 'UpdateSubscription') {
          return { mutateAsync: updateSubscriptionMutateMock } as any;
        }
        return { mutateAsync: vi.fn().mockResolvedValue({}) } as any;
      });

      render(<Dashboard />);

      const untrackedButton = screen.getByTestId('untracked-badge');
      expect(untrackedButton).toBeDefined();

      await act(async () => {
        fireEvent.click(untrackedButton);
      });

      expect(updateSubscriptionMutateMock).toHaveBeenCalledWith({
        itemId: 'PR_1',
        state: SubscriptionState.SUBSCRIBED,
      });

      expect(invalidateQueriesMock).toHaveBeenCalled();
      expect(refetchItemsMock).toHaveBeenCalled();
    });

    it('triggers updateSubscription mutation when subscribing from DetailsPane', async () => {
      const refetchItemsMock = vi.fn().mockResolvedValue({});
      const untrackedMockItem: Partial<Item> = {
        ...mockItem,
        id: 'PR_1',
        viewerSubscription: SubscriptionState.UNSUBSCRIBED,
      };

      vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
        const auxiliary = stubAuxiliaryQuery(schema);
        if (auxiliary) return auxiliary;
        if (schema?.name === 'GetItems' || schema?.method?.name === 'GetItems') {
          return {
            data: { items: [untrackedMockItem as Item] },
            isLoading: false,
            isError: false,
            error: null,
            refetch: refetchItemsMock,
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

      const updateSubscriptionMutateMock = vi.fn().mockResolvedValue({
        item: { ...untrackedMockItem, viewerSubscription: SubscriptionState.SUBSCRIBED },
      });

      vi.mocked(connectQuery.useMutation).mockImplementation((schema: any) => {
        if (schema?.name === 'UpdateSubscription' || schema?.method?.name === 'UpdateSubscription') {
          return { mutateAsync: updateSubscriptionMutateMock } as any;
        }
        return { mutateAsync: vi.fn().mockResolvedValue({}) } as any;
      });

      render(<Dashboard />);

      // Open item in DetailsPane by clicking the title
      const titleLink = screen.getByText('Test PR');
      await act(async () => {
        fireEvent.click(titleLink);
      });

      const detailsUntrackedBtn = screen.getByTestId('details-untracked-badge');
      expect(detailsUntrackedBtn).toBeDefined();

      await act(async () => {
        fireEvent.click(detailsUntrackedBtn);
      });

      expect(updateSubscriptionMutateMock).toHaveBeenCalledWith({
        itemId: 'PR_1',
        state: SubscriptionState.SUBSCRIBED,
      });
      expect(refetchItemsMock).toHaveBeenCalled();
    });
  });

  describe('Tracking Filter in State Dropdown', () => {
    it('renders Tracked and Untracked options separated by a divider in State dropdown without All or section header', () => {
      render(<Dashboard />);

      const stateTrigger = screen.getByRole('button', { name: /Filter by state/i });
      fireEvent.click(stateTrigger);

      const stateMenu = stateTrigger.parentElement!;
      // No "Tracking" text header
      expect(within(stateMenu).queryByText(/^Tracking$/i)).toBeNull();

      // No "All" option in the state menu
      expect(within(stateMenu).queryByRole('button', { name: /^All$/i })).toBeNull();

      // Tracked and Untracked options are present
      const trackedOption = within(stateMenu).getByRole('button', { name: /^Tracked$/i });
      const untrackedOption = within(stateMenu).getByRole('button', { name: /^Untracked$/i });

      expect(trackedOption).toBeDefined();
      expect(untrackedOption).toBeDefined();
    });

    it('resets tracking filter when clicking Clear filters button', () => {
      const untrackedItem: Item = {
        ...mockItem,
        id: 'PR_UNTRACKED',
        title: 'Untracked PR',
        viewerSubscription: SubscriptionState.UNSUBSCRIBED,
      } as Item;

      vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
        const auxiliary = stubAuxiliaryQuery(schema);
        if (auxiliary) return auxiliary;
        if (
          schema?.name === 'GetItems' ||
          schema?.typeName === 'octodeck.v1.OctoDeckService' ||
          schema?.method?.name === 'GetItems'
        ) {
          return {
            data: { items: [untrackedItem] },
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

      // Set tracking to untracked
      const stateTrigger = screen.getByRole('button', { name: /Filter by state/i });
      act(() => {
        fireEvent.click(stateTrigger);
      });
      const stateMenu = stateTrigger.parentElement!;
      act(() => {
        fireEvent.click(within(stateMenu).getByRole('button', { name: /^Untracked$/i }));
      });

      expect(screen.getByRole('button', { name: /Remove tracking filter/i })).toBeDefined();

      // Click "Clear filters"
      const clearFiltersBtn = screen.getByRole('button', { name: /Reset filters/i });
      act(() => {
        fireEvent.click(clearFiltersBtn);
      });

      expect(screen.queryByRole('button', { name: /Remove tracking filter/i })).toBeNull();
      expect(window.location.search).not.toContain('tracking=');
    });

    it('disables subscribe buttons on card and details pane when hasNotificationsScope is false', () => {
      const untrackedItem: Item = {
        ...mockItem,
        id: 'PR_UNTRACKED_NO_SCOPE',
        title: 'Untracked No Scope PR',
        viewerSubscription: SubscriptionState.UNSUBSCRIBED,
      } as Item;

      vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
        const auxiliary = stubAuxiliaryQuery(schema);
        if (auxiliary) return auxiliary;
        if (schema?.name === 'GetItems' || schema?.method?.name === 'GetItems') {
          return {
            data: { items: [untrackedItem] },
            isLoading: false,
            error: null,
            refetch: vi.fn(),
          } as any;
        }
        if (schema?.name === 'GetSyncStatus' || schema?.method?.name === 'GetSyncStatus') {
          return {
            data: { status: { hasNotificationsScope: false } },
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

      const cardBadge = screen.getByTestId('untracked-badge');
      expect(cardBadge.hasAttribute('disabled')).toBe(true);
      expect(cardBadge.getAttribute('title')).toContain('gh auth refresh -s notifications');

      // Select item to open DetailsPane
      fireEvent.click(screen.getByText('Untracked No Scope PR'));
      const detailsBadge = screen.getByTestId('details-untracked-badge');
      expect(detailsBadge.hasAttribute('disabled')).toBe(true);
      expect(detailsBadge.getAttribute('title')).toContain('gh auth refresh -s notifications');
    });
  });
});




