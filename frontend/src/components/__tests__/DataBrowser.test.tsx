/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DataBrowser } from '../DataBrowser';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as connectQuery from '@connectrpc/connect-query';
import { ItemType, ItemState, ItemStatus, type Item, type User } from '../../api/octodeck/v1/resources_pb';

vi.mock('@connectrpc/connect-query', () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(() => ({ mutateAsync: vi.fn() })),
}));



const mockItem: Partial<Item> = {
  id: 'PR_kwDOAToIks7M9qL1',
  repo: 'kubernetes/kubernetes',
  number: 137999,
  type: ItemType.PR,
  title: 'Fix kubelet panic in pod resize',
  state: ItemState.OPEN,
  url: 'https://github.com/kubernetes/kubernetes/pull/137999',
  author: { login: 'ndixita', avatarUrl: 'https://avatar.url', type: 1 } as unknown as User,
  commits: [],
  comments: [],
  reviews: [],
  assignees: [],
  local: {
    computedStatus: ItemStatus.NEW,
    isAcked: false,
    privateNotes: 'Test note',
  } as unknown as NonNullable<Item['local']>,
};

describe('DataBrowser', () => {
  const onBackMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders daemon configuration and cached items from ConnectRPC query', () => {
    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [mockItem as Item] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: {
          config: {
            pollingIntervalMin: 15,
            watchedRepos: ['kubernetes/kubernetes'],
            pinnedRepos: [],
            excludedRepos: [],
            knownBots: ['k8s-ci-robot'],
            autoAckOwnActivity: true,
          },
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<DataBrowser onBack={onBackMock} />);

    expect(screen.getByText('Debug Data Browser')).toBeDefined();
    expect(screen.getByText('Cached Items (1)')).toBeDefined();
    expect(screen.getByText('kubernetes/kubernetes')).toBeDefined();
    expect(screen.getByText('#137999')).toBeDefined();
    expect(screen.getByText('Fix kubelet panic in pod resize')).toBeDefined();
    expect(screen.getByText('ID: PR_kwDOAToIks7M9qL1')).toBeDefined();
  });

  it('calls onBack when clicking the back button', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { items: [] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    render(<DataBrowser onBack={onBackMock} />);

    const backButton = screen.getByTitle('Back to Dashboard');
    fireEvent.click(backButton);
    expect(onBackMock).toHaveBeenCalledTimes(1);
  });

  it('renders and highlights initialSelectedItemId', () => {
    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [mockItem as Item] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return {
        data: { config: {} },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as any;
    });

    render(<DataBrowser onBack={onBackMock} initialSelectedItemId="PR_kwDOAToIks7M9qL1" />);

    expect(screen.getByText('ID: PR_kwDOAToIks7M9qL1')).toBeDefined();
  });

  it('triggers refetchItem mutation when clicking Refetch Item', async () => {
    const refetchItemMutate = vi.fn().mockResolvedValue({});
    vi.mocked(connectQuery.useMutation).mockImplementation((schema: any) => {
      if (schema?.name === 'RefetchItem' || schema?.method?.name === 'RefetchItem') {
        return { mutateAsync: refetchItemMutate } as any;
      }
      return { mutateAsync: vi.fn() } as any;
    });

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [mockItem as Item] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return { data: { config: {} }, isLoading: false, error: null, refetch: vi.fn() } as any;
    });

    render(<DataBrowser onBack={onBackMock} initialSelectedItemId="PR_kwDOAToIks7M9qL1" />);

    const refetchBtn = screen.getByTitle('Refetch item');
    await act(async () => {
      fireEvent.click(refetchBtn);
    });

    expect(refetchItemMutate).toHaveBeenCalledWith({ itemId: 'PR_kwDOAToIks7M9qL1' });
  });

  it('triggers deleteItem mutation when clicking Delete and confirming', async () => {
    const deleteItemMutate = vi.fn().mockResolvedValue({});
    vi.mocked(connectQuery.useMutation).mockImplementation((schema: any) => {
      if (schema?.name === 'DeleteItem' || schema?.method?.name === 'DeleteItem') {
        return { mutateAsync: deleteItemMutate } as any;
      }
      return { mutateAsync: vi.fn() } as any;
    });

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [mockItem as Item] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return { data: { config: {} }, isLoading: false, error: null, refetch: vi.fn() } as any;
    });

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<DataBrowser onBack={onBackMock} initialSelectedItemId="PR_kwDOAToIks7M9qL1" />);

    const deleteBtn = screen.getByTitle('Delete item');
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    expect(deleteItemMutate).toHaveBeenCalledWith({ itemId: 'PR_kwDOAToIks7M9qL1' });
  });

  it('renders a link back to dashboard view with details for item and invokes onBack with item ID when clicked', () => {
    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetItems' || schema?.typeName === 'octodeck.v1.OctoDeckService' || schema?.method?.name === 'GetItems') {
        return {
          data: { items: [mockItem as Item] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return { data: { config: {} }, isLoading: false, error: null, refetch: vi.fn() } as any;
    });

    render(<DataBrowser onBack={onBackMock} initialSelectedItemId="PR_kwDOAToIks7M9qL1" />);

    const dashboardLink = screen.getByRole('link', { name: /View in Dashboard/i });
    expect(dashboardLink).toBeDefined();
    expect(dashboardLink.getAttribute('href')).toBe('/?item=PR_kwDOAToIks7M9qL1');

    fireEvent.click(dashboardLink);
    expect(onBackMock).toHaveBeenCalledWith('PR_kwDOAToIks7M9qL1');
  });

  it('renders sync traces and allows filtering by type and copying payload', async () => {
    const mockTrace = {
      id: 'heartbeat-123456',
      traceType: 'heartbeat',
      triggerSource: 'ticker',
      queryString: 'repo:kubernetes/kubernetes updated:>2026-08-13T00:00:00Z',
      reposEvaluated: ['kubernetes/kubernetes'],
      durationMs: 145n,
      pagesCount: 1n,
      itemsFetched: 2n,
      itemsPersisted: 2n,
      errorMessage: '',
      rawPayload: '{"nodes": [{"id": "PR_1"}]}',
    };

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetSyncTraces' || schema?.method?.name === 'GetSyncTraces') {
        return {
          data: { traces: [mockTrace] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return { data: { items: [], config: {} }, isLoading: false, error: null, refetch: vi.fn() } as any;
    });

    render(<DataBrowser onBack={onBackMock} initialTab="traces" />);

    expect(screen.getByText('Sync Traces (24h)')).toBeDefined();
    expect(screen.getAllByText('heartbeat').length).toBeGreaterThan(0);
    expect(screen.getByText('via ticker')).toBeDefined();
    expect(screen.getByText('145ms')).toBeDefined();
    expect(screen.getByText('2 fetched / 2 saved')).toBeDefined();
    expect(screen.getByText('OK')).toBeDefined();
  });

  it('renders notification_sync traces with 304 Not Modified badge and 200 OK with reasons breakdown', () => {
    const trace304 = {
      id: 'notif-trace-304',
      traceType: 'notification_sync',
      triggerSource: 'ticker',
      durationMs: 35n,
      itemsFetched: 0n,
      itemsPersisted: 0n,
      errorMessage: '',
      rawPayload: JSON.stringify({
        http_status: 304,
        last_modified: 'Thu, 14 Aug 2026 01:54:16 GMT',
        notifications_count: 0,
      }),
    };

    const trace200 = {
      id: 'notif-trace-200',
      traceType: 'notification_sync',
      triggerSource: 'manual',
      durationMs: 210n,
      itemsFetched: 2n,
      itemsPersisted: 2n,
      errorMessage: '',
      rawPayload: JSON.stringify({
        http_status: 200,
        last_modified: 'Thu, 14 Aug 2026 02:00:00 GMT',
        notifications_count: 5,
        reasons_breakdown: { assign: 3, mention: 2 },
        unsupported_types: { CheckSuite: 1 },
        filtered_by_repo_count: 1,
        hydrated_items: ['PR_kwDOAToIks7zPyIm', 'PR_kwDOAToIks7M9qL1'],
      }),
    };

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetSyncTraces' || schema?.method?.name === 'GetSyncTraces') {
        return {
          data: { traces: [trace304, trace200] },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return { data: { items: [], config: {} }, isLoading: false, error: null, refetch: vi.fn() } as any;
    });

    render(<DataBrowser onBack={onBackMock} initialTab="traces" />);

    // Filter button exists
    expect(screen.getByRole('button', { name: 'notification sync' })).toBeDefined();

    // 304 badge
    expect(screen.getByTestId('status-304')).toBeDefined();
    expect(screen.getByText('304 Not Modified')).toBeDefined();

    // 200 badge
    expect(screen.getByTestId('status-200')).toBeDefined();
    expect(screen.getByText('200 OK (5 notifs)')).toBeDefined();

    // Reasons breakdown
    expect(screen.getByTestId('reasons-breakdown')).toBeDefined();
    expect(screen.getByText('assign: 3')).toBeDefined();
    expect(screen.getByText('mention: 2')).toBeDefined();

    // Unsupported types
    expect(screen.getByTestId('unsupported-types')).toBeDefined();
    expect(screen.getByText('CheckSuite: 1')).toBeDefined();

    // Hydrated items
    expect(screen.getByText('Hydrated Items (2):')).toBeDefined();
    expect(screen.getByText('PR_kwDOAToIks7zPyIm')).toBeDefined();
    expect(screen.getByText('PR_kwDOAToIks7M9qL1')).toBeDefined();
  });

  it('switches to Config & Storage tab when clicked', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: {
        config: {
          pollingIntervalMin: 15,
          watchedRepos: ['kubernetes/kubernetes'],
        },
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    render(<DataBrowser onBack={onBackMock} />);

    const configTab = screen.getByRole('button', { name: /Config & Storage/i });
    fireEvent.click(configTab);

    expect(screen.getByText('Daemon Configuration')).toBeDefined();
    expect(screen.getByText('Client Settings & Storage')).toBeDefined();
  });

  it('updates URL search parameters when switching tabs', () => {
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { items: [], config: {}, traces: [] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    render(<DataBrowser onBack={onBackMock} />);

    const tracesTab = screen.getByRole('button', { name: /Sync Traces/i });
    fireEvent.click(tracesTab);

    expect(pushStateSpy).toHaveBeenCalledWith(null, '', expect.stringContaining('tab=traces'));
  });

  it('triggers client.sync when clicking Sync from GitHub', async () => {
    const syncMock = vi.fn(async function* () {
      yield { message: 'Sync complete' };
    });
    const { client } = await import('../../api/client');
    client.sync = syncMock as any;

    const refetchTraces = vi.fn();
    const refetchItems = vi.fn();

    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetSyncTraces' || schema?.method?.name === 'GetSyncTraces') {
        return { data: { traces: [] }, isLoading: false, error: null, refetch: refetchTraces } as any;
      }
      return { data: { items: [], config: {} }, isLoading: false, error: null, refetch: refetchItems } as any;
    });

    render(<DataBrowser onBack={onBackMock} />);

    const syncBtn = screen.getByRole('button', { name: /Sync from GitHub/i });
    await act(async () => {
      fireEvent.click(syncBtn);
    });

    expect(syncMock).toHaveBeenCalledTimes(1);
  });

  it('renders database stats tab with storage and inventory metrics', () => {
    vi.mocked(connectQuery.useQuery).mockImplementation((schema: any) => {
      if (schema?.name === 'GetDatabaseStats' || schema?.method?.name === 'GetDatabaseStats') {
        return {
          data: {
            stats: {
              totalItems: 42n,
              openItems: 30n,
              closedItems: 12n,
              prItems: 25n,
              issueItems: 17n,
              unackedItems: 8n,
              ackedItems: 34n,
              totalRepos: 3n,
              totalTraces: 10n,
              dbSizeBytes: 1048576n, // 1 MB
              dbPath: '/test/path/octodeck.db',
            },
          },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        } as any;
      }
      return { data: { items: [], config: {}, traces: [] }, isLoading: false, error: null, refetch: vi.fn() } as any;
    });

    render(<DataBrowser onBack={onBackMock} />);

    const dbTab = screen.getByRole('button', { name: /Database Stats/i });
    fireEvent.click(dbTab);

    expect(screen.getByText('Local Database & Storage Overview')).toBeDefined();
    expect(screen.getByText('42')).toBeDefined();
    expect(screen.getByText('30 open')).toBeDefined();
    expect(screen.getByText('12 closed')).toBeDefined();
    expect(screen.getByText('1.00 MB')).toBeDefined();
    expect(screen.getByText('/test/path/octodeck.db')).toBeDefined();
    expect(screen.getByRole('button', { name: /Clear Storage/i })).toBeDefined();
  });
});
